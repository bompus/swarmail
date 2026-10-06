// Sender-owned mail changes. Retry results precede fresh activation, lifecycle and revision checks.
import type { Database } from "bun:sqlite";
import type { Lifecycle } from "./lifecycle.ts";
import { iso, nowUs } from "./db.ts";
import { reconcileNotices } from "./wake-notices.ts";
import {
  type Agent,
  type Args,
  type Project,
  type Row,
  type MailStore,
  str,
  ToolError,
} from "./store.ts";

type Kind = "withdraw_message" | "set_message_importance";
type Options = { db: Database; lifecycle?: Lifecycle; enabled: boolean };

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ToolError("INVALID_ARGUMENT", "expected_revision must be a nonnegative safe integer");
  }
  return value;
}

function audit(
  db: Database,
  m: Row,
  actor: Agent,
  entry: { kind: Kind; at: number; details: object },
) {
  db.run(
    "INSERT INTO message_mutations(message_id, actor_id, kind, created_ts, revision, details_json) VALUES (?, ?, ?, ?, ?, ?)",
    [m.id, actor.id, entry.kind, entry.at, m.revision, JSON.stringify(entry.details)],
  );
}

function withdraw(db: Database, m: Row, actor: Agent, a: Args) {
  const rows = db
    .query<Row, [number]>(`SELECT r.*, a.name FROM message_recipients r
    JOIN agents a ON a.id = r.agent_id WHERE r.message_id = ? ORDER BY a.name`)
    .all(m.id);
  let targets = rows;
  if (a.recipients !== undefined) {
    if (
      !Array.isArray(a.recipients) ||
      a.recipients.length === 0 ||
      a.recipients.some((name: unknown) => typeof name !== "string" || !name)
    ) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        "recipients must be a nonempty array of names when supplied",
      );
    }
    const wanted = new Set<string>(a.recipients.map((name: string) => name.toLowerCase()));
    targets = rows.filter((row) => wanted.delete(row.name.toLowerCase()));
    if (wanted.size) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        "recipients includes a name without a delivery for this message",
      );
    }
  }
  const at = nowUs();
  const changed = targets.filter(
    (r) => r.withdrawn_ts == null && r.read_ts == null && r.ack_ts == null,
  );
  for (const r of changed) {
    db.run(
      `UPDATE message_recipients SET withdrawn_ts = ? WHERE message_id = ? AND agent_id = ?
      AND withdrawn_ts IS NULL AND read_ts IS NULL AND ack_ts IS NULL`,
      [at, m.id, r.agent_id],
    );
  }
  if (changed.length) {
    db.run("UPDATE messages SET revision = revision + 1 WHERE id = ?", [m.id]);
    m.revision++;
    audit(db, m, actor, {
      kind: "withdraw_message",
      at,
      details: { recipient_ids: changed.map((r) => r.agent_id) },
    });
    reconcileNotices(db);
  }
  return {
    message_id: m.id,
    revision: m.revision,
    recipients: targets.map((r) => ({
      recipient: r.name,
      status:
        r.withdrawn_ts != null
          ? "already_withdrawn"
          : r.read_ts != null || r.ack_ts != null
            ? "too_late"
            : "withdrawn",
      withdrawn_at: iso(r.withdrawn_ts ?? (changed.includes(r) ? at : null)),
    })),
  };
}

function importance(db: Database, m: Row, actor: Agent, a: Args) {
  const expected = revision(a.expected_revision);
  if (!["low", "normal", "high", "urgent"].includes(a.importance)) {
    throw new ToolError("INVALID_ARGUMENT", "importance must be low, normal, high or urgent");
  }
  if (expected !== m.revision) {
    throw new ToolError(
      "REVISION_CONFLICT",
      "message revision changed; inspect current metadata before editing",
      {
        expected_revision: expected,
        revision: m.revision,
      },
    );
  }
  const old = m.importance;
  if (old !== a.importance) {
    db.run("UPDATE messages SET importance = ?, revision = revision + 1 WHERE id = ?", [
      a.importance,
      m.id,
    ]);
    m.revision++;
    audit(db, m, actor, {
      kind: "set_message_importance",
      at: nowUs(),
      details: { old_importance: old, importance: a.importance },
    });
  }
  return {
    message_id: m.id,
    revision: m.revision,
    importance: a.importance,
    changed: old !== a.importance,
  };
}

export function mutateMessage(store: MailStore, options: Options, p: Project, a: Args, kind: Kind) {
  str(a.idempotency_key, "idempotency_key");
  const actor = store.agent(p, a.sender_name, "sender_name");
  return store.idempotent(kind, actor.id, a, () => {
    if (!options.enabled) {
      throw new ToolError(
        "MUTATIONS_DISABLED",
        "message mutations are disabled; reader qualification and explicit server activation are required",
      );
    }
    const ready = options.lifecycle?.reconcile().status === "ready";
    const current = store.agentById(actor.id);
    if (current.lifecycle_profile != null && !ready) {
      throw new ToolError("LIFECYCLE_UNAVAILABLE", "bound sender lifecycle source is unavailable");
    }
    store.requireLifecycle(current);
    if (current.retired_at != null) {
      throw new ToolError("NOT_FOUND", "sender is retired; mutation does not reopen an identity");
    }
    if (
      typeof a.message_id !== "number" ||
      !Number.isSafeInteger(a.message_id) ||
      a.message_id < 1
    ) {
      throw new ToolError("INVALID_ARGUMENT", "message_id must be a positive safe integer");
    }
    const m = store.message(p, a.message_id);
    if (m.sender_id !== actor.id) {
      throw new ToolError("FORBIDDEN", "only the original sender can mutate this message");
    }
    return kind === "withdraw_message"
      ? withdraw(options.db, m, actor, a)
      : importance(options.db, m, actor, a);
  });
}
