// Admission observations are snapshots, not proof of wake delivery or task acceptance.
import type { Database } from "bun:sqlite";
import { hostAlive } from "./proc.ts";
import { nameIn, openRegistry, registryDir } from "./registry.ts";
import { parseTag, sameSession } from "./tag.ts";
import {
  list,
  ToolError,
  type Agent,
  type Project,
  type Args,
  type Row,
  type MailStore,
} from "./store.ts";
import { iso, nowUs } from "./db.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { SESSION_RE } from "./wake.ts";

export interface AdmissionObservation {
  recipient: string;
  availability: "eligible" | "unavailable" | "unknown";
  lifecycle: string;
  process: "present" | "unknown";
  wake: "unknown";
  source: "t3" | "registry" | "registration";
  reason: string;
  observed_at: string;
  reported_end_at?: string;
}

/** Observes only this recipient's bound source or matching local registration. */
export function recipientObservation(
  db: Database,
  project: Project,
  who: Agent,
  observedAt: string,
  registry = registryDir(),
): AdmissionObservation {
  const observation: AdmissionObservation = {
    recipient: who.name,
    availability: "unknown",
    lifecycle: "unknown",
    process: "unknown",
    wake: "unknown",
    source: "registration",
    reason: "unbound_identity",
    observed_at: observedAt,
  };
  if (who.lifecycle_profile) {
    const state = db
      .query<{ state: string }, [string, string | null]>(
        "SELECT state FROM session_lifecycle WHERE profile = ? AND thread_id = ?",
      )
      .get(who.lifecycle_profile, who.lifecycle_thread);
    observation.source = "t3";
    observation.lifecycle = state?.state ?? "unknown";
    observation.availability =
      state?.state === "active" ? "eligible" : state ? "unavailable" : "unknown";
    observation.reason = state?.state ?? "identity_unverified";
    return observation;
  }
  if (
    !who.session_id ||
    !who.host ||
    !SESSION_RE.test(who.session_id) ||
    !/^[\w-]+$/.test(who.host)
  ) {
    return observation;
  }
  // An unqualified SessionEnd or missing process cannot close a resumable session.
  try {
    const state = openRegistry(registry).read(who.session_id);
    const tag = parseTag(state?.tags?.[project.human_key]);
    if (
      !state ||
      nameIn(state, project.human_key) !== who.name ||
      !state.projects.includes(project.human_key) ||
      !tag ||
      !sameSession(tag, parseTag(who.task_description)) ||
      tag.host !== who.host ||
      tag.sessionId !== who.session_id
    ) {
      return observation;
    }
    observation.source = "registry";
    observation.process = hostAlive(state.host) ? "present" : "unknown";
    observation.reason =
      observation.process === "present" ? "lifecycle_unqualified" : "process_unobservable";
    if (typeof state.ended === "string" && Number.isFinite(Date.parse(state.ended))) {
      observation.reported_end_at = state.ended;
      observation.reason = "lifecycle_unqualified";
    }
  } catch {
    observation.reason = "process_unobservable";
  }
  return observation;
}

/** Shared send/reply admission; errors abort every intended recipient. */
export function admitRecipients(
  store: MailStore,
  p: Project,
  sender: Agent,
  a: Args,
  options: { db: Database; lifecycle?: Lifecycle; registry?: string },
) {
  const policy = a.delivery_policy ?? "checked";
  if (policy !== "checked" && policy !== "durable") {
    throw new ToolError("INVALID_ARGUMENT", "delivery_policy must be checked or durable", {
      field: "delivery_policy",
      persisted: false,
    });
  }
  const sourceReady = options.lifecycle?.reconcile().status === "ready";
  sender = store.agentById(sender.id);
  if (sender.lifecycle_profile && !sourceReady) {
    throw new ToolError(
      "RECIPIENT_STATE_UNKNOWN",
      "Session state unavailable; no message stored.",
      {
        persisted: false,
        reason: "source_unavailable",
      },
    );
  }
  store.requireLifecycle(sender);
  // No broadcast: every message names its recipients.
  if (a.broadcast) {
    throw new ToolError("INVALID_ARGUMENT", "broadcast is not supported; name the recipients", {
      field: "broadcast",
    });
  }
  const to = list(a.to),
    cc = list(a.cc),
    bcc = list(a.bcc);
  if (to.length + cc.length + bcc.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "at least one recipient is required", {
      field: "to",
    });
  }
  // Resolve every name first so an unknown recipient sends nothing.
  const checkedAt = iso(nowUs())!;
  const failures: Row[] = [];
  const recipients = [
    ...to.map((n) => [n, "to"]),
    ...cc.map((n) => [n, "cc"]),
    ...bcc.map((n) => [n, "bcc"]),
  ].flatMap(([n, kind]) => {
    try {
      const who = store.agent(p, n!, "to");
      const observation = recipientObservation(options.db, p, who, checkedAt, options.registry);
      const reason =
        who.retired_at != null
          ? "retired"
          : who.lifecycle_profile && !sourceReady
            ? "source_unavailable"
            : observation.availability === "unavailable"
              ? observation.lifecycle
              : who.lifecycle_profile && observation.availability === "unknown"
                ? "identity_unverified"
                : null;
      if (reason) {
        failures.push({ recipient: who.name, reason, observed_at: checkedAt });
        return [];
      }
      return [{ agent: who, kind: kind!, observation }];
    } catch (error) {
      if (!(error instanceof ToolError) || error.type !== "NOT_FOUND") {
        throw error;
      }
      failures.push({
        recipient: n,
        reason: "unregistered",
        message: error.message,
        ...error.data,
      });
      return [];
    }
  });
  if (failures.length) {
    const uncertain = failures.some((failure) =>
      ["source_unavailable", "identity_unverified"].includes(failure.reason),
    );
    throw new ToolError(
      uncertain ? "RECIPIENT_STATE_UNKNOWN" : "NOT_FOUND",
      `No message stored. ${failures.map((failure) => failure.message ?? `${failure.recipient}: ${failure.reason}`).join("; ")}.`,
      {
        ...failures[0],
        persisted: false,
        recipients: failures,
        action:
          "Confirm the recipient's registration and session state before retrying; no automatic rerouting.",
      },
    );
  }
  return { sender, recipients, checkedAt };
}
