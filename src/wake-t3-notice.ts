import { INBOX_NOTICE } from "./wake.ts";
// Steer mail into active T3 threads and reconcile only owned legacy queues. Commands are saved before sending and never edited on retry.
import {
  BridgeError,
  ensureT3Unsettled,
  sendT3Command,
  t3Projection,
  t3SteeringRun,
  t3V2Adapter,
  T3CommandRejected,
  T3_HUMAN_REQUEST_KINDS,
} from "./wake-target.ts";
import type { T3ControlProjection, WakeTarget } from "./wake-target.ts";
import { peekUnreadMailboxes, waitForOffer } from "./wake-state.ts";
import type { Pending, WakeState } from "./wake-state.ts";
import type { DeliveryAdapter } from "./wake-loop.ts";

type Notice = {
  type: "t3.notice";
  messageId: string;
  hints: string[];
  delivered?: boolean;
  operation?: Record<string, unknown>;
};

function queuedNotices(
  projection: T3ControlProjection,
  ownedMessageIds: unknown[] = [],
): {
  run: T3ControlProjection["runs"][number];
  message: T3ControlProjection["messages"][number];
}[] {
  return projection.runs
    .filter((run) => run.status === "queued")
    .flatMap((run) => {
      const message = projection.messages.find((message) => message.id === run.userMessageId);
      return message &&
        (message.createdBy === "agent" || ownedMessageIds.includes(message.id)) &&
        message.creationSource === "server" &&
        typeof message.text === "string" &&
        message.text.startsWith("Swarmail: ") &&
        !message.notification &&
        !message.delegatedCompletion
        ? [{ run, message }]
        : [];
    });
}

const cancelOperation = (target: WakeTarget, runId: string) => ({
  type: "queued-run.cancel",
  commandId: crypto.randomUUID(),
  threadId: target.id,
  runId,
});

async function currentHints(
  config: { swarmailUrl: string; target: WakeTarget },
  signal: AbortSignal,
) {
  return (await peekUnreadMailboxes(config, signal)).map(
    ({ recipient, project }) =>
      `Swarmail: unread mail for ${recipient} in ${JSON.stringify(project)}.`,
  );
}

function prepareOperation(
  notice: Notice,
  queued: ReturnType<typeof queuedNotices>,
  target: WakeTarget,
  projection: T3ControlProjection,
) {
  const existing = queued[0];
  if (existing) {
    notice.messageId = existing.message.id;
    if (existing.message.text === INBOX_NOTICE) {
      const active = t3SteeringRun(projection);
      if (!active) {
        throw new BridgeError("T3 queued notice is waiting to start; holding mail", true);
      }
      notice.operation = {
        type: "queued-message.promote-to-steer",
        commandId: crypto.randomUUID(),
        threadId: target.id,
        queuedRunId: existing.run.id,
        targetRunId: active.id,
      };
      return;
    }
    notice.operation = {
      type: "queued-run.edit",
      commandId: crypto.randomUUID(),
      threadId: target.id,
      runId: existing.run.id,
      text: INBOX_NOTICE,
    };
  } else {
    t3SteeringRun(projection);
    notice.operation = {
      type: "message.dispatch",
      commandId: crypto.randomUUID(),
      threadId: target.id,
      messageId: notice.messageId,
      text: INBOX_NOTICE,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      deliveryIntent: "steer",
      dispatchMode: { type: "start_immediately" },
    };
  }
}

async function reconcileRejection(
  target: WakeTarget,
  notice: Notice,
  operation: Record<string, unknown>,
  error: unknown,
) {
  if (!(error instanceof T3CommandRejected) || operation.type === "message.dispatch") {
    throw error;
  }
  const fresh = await t3Projection(target);
  const promotion = operation.type === "queued-message.promote-to-steer";
  const source = fresh.runs.find(
    (run) => run.id === (promotion ? operation.queuedRunId : operation.runId),
  );
  if (source?.status === "queued") {
    if (!promotion) {
      throw error;
    }
    let active;
    try {
      active = t3SteeringRun(fresh);
    } catch (held) {
      if (!(held instanceof BridgeError) || !held.retryable) {
        throw held;
      }
    }
    if (active?.id === operation.targetRunId) {
      throw error; // An unexplained rejection stays retained for inspection.
    }
  }
  delete notice.operation;
  if (operation.type === "queued-run.edit") {
    notice.messageId = crypto.randomUUID();
  } else if (promotion && source?.status !== "queued") {
    notice.delivered =
      !!source &&
      ["preparing", "starting", "running", "waiting", "completed"].includes(source.status);
    if (!notice.delivered) {
      notice.messageId = crypto.randomUUID();
    }
  }
}

/** Legacy agent notices and journaled message IDs are ours; other user prompts stay untouched. */
export function t3NoticeAdapter(
  config: { swarmailUrl: string; target: WakeTarget },
  state: WakeState,
): Pick<DeliveryAdapter, "wait" | "prepare" | "deliver"> {
  const target = config.target;
  return {
    wait: async (after, signal) => {
      const queued = queuedNotices(await t3Projection(target), [state.readContext()?.messageId]);
      if (queued.length) {
        // Promote a matching legacy notice too, even when no new mail arrives.
        return { eventId: after, hint: queued[0]!.message.text };
      }
      return waitForOffer(config, after, signal);
    },
    prepare: (offer) => ({
      type: "t3.notice",
      messageId: crypto.randomUUID(),
      hints: [offer.hint],
    }),
    deliver: async (pending: Pending, attempted, signal) => {
      const notice = pending.command as unknown as Notice;
      const save = () => state.savePending(pending);
      while (!signal.aborted) {
        const projection = await t3Projection(target);
        ensureT3Unsettled(projection.thread);
        if (
          projection.runtimeRequests.some(
            (r) => r.status === "pending" && T3_HUMAN_REQUEST_KINDS.has(r.kind),
          )
        ) {
          throw new BridgeError("T3 is waiting for an operator response", true);
        }
        if (pending.command.type !== "t3.notice") {
          // Keep a previously journaled command's id and payload across rollout.
          await t3V2Adapter.deliver(target, pending.command, attempted, signal);
          if (typeof pending.command.messageId === "string") {
            state.saveContext({ messageId: pending.command.messageId });
          }
          return;
        }
        if (notice.operation) {
          const operation = notice.operation;
          try {
            await sendT3Command(target, operation);
          } catch (error) {
            await reconcileRejection(target, notice, operation, error);
            save();
            continue;
          }
          if (operation.type !== "queued-run.cancel") {
            notice.delivered = true;
          }
          delete notice.operation;
          save();
          continue;
        }
        const queued = queuedNotices(projection, [
          notice.messageId,
          state.readContext()?.messageId,
        ]);
        notice.hints = await currentHints(config, signal);
        if (!notice.hints.length) {
          const obsolete = queued[0];
          if (obsolete) {
            notice.operation = cancelOperation(target, obsolete.run.id);
            save();
            continue;
          }
          state.clearContext();
          return;
        }
        if (notice.delivered) {
          const extra = queued.find(({ message }) => message.id !== notice.messageId);
          if (extra) {
            notice.operation = cancelOperation(target, extra.run.id);
            save();
            continue;
          }
          const own = queued.find(({ message }) => message.id === notice.messageId);
          if (own) {
            prepareOperation(notice, [own], target, projection);
            save();
            continue;
          }
          state.saveContext({ messageId: notice.messageId, hints: notice.hints });
          return;
        }
        prepareOperation(notice, queued, target, projection);
        save();
      }
    },
  };
}
