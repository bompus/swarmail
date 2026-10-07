// Swarmail tools, one row each: the MCP definition, its flags and its handler. Shared lookups and writes live in
// store.ts.
import { isMessageResult, isReplyResult, isReceiptResult } from "./message-validation.ts";
import { MESSAGE_RESULT, REPLY_RESULT, RECEIPT_RESULT } from "./message-results.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Database } from "bun:sqlite";
import { iso, nowUs } from "./db.ts";
import { locations } from "./location.ts";
import { SENDING_GUIDANCE } from "./guidance.ts";
import {
  type Args,
  agentOut,
  list,
  MailStore,
  num,
  projectOut,
  pageLimit,
  reservationSeconds,
  str,
  time,
  ToolError,
} from "./store.ts";

export { ToolError } from "./store.ts";

type Schema = Record<string, unknown>;
const prop = (type: string, description?: string): Schema => ({
  type,
  ...(description && { description }),
});
const strings = (description?: string): Schema => ({
  type: "array",
  items: { type: "string" },
  ...(description && { description }),
});
const PROJECT = prop("string", "Absolute path of the repository's primary checkout.");
const AGENT = prop("string", "Your registered agent name.");
const MESSAGE = prop("integer", "Message id.");
const PROGRAM = prop("string", "Agent host, such as claude-code, codex or cursor.");
const MODEL = prop("string", "Model id the session runs.");
const WORKTREE = prop(
  "string",
  "Absolute path of the checkout being edited, in this project. Omit to keep its recorded location.",
);
const TASK = prop(
  "string",
  "What you are working on. Keep the leading [host:session ...] tag the register hook gave you.",
);
const IDEMPOTENCY_KEY = prop(
  "string",
  "Nonempty key for this tool and agent. Identical arguments replay with idempotent_replay:true; different arguments fail with IDEMPOTENCY_KEY_CONFLICT. Cleanup runs at server startup and hourly, removing keys older than 7 days. Retries can replay until removal; afterward a retry may perform the operation again.",
);
const IMPORTANCE = prop("string", "low, normal, high or urgent.");
const DELIVERY_POLICY = {
  type: "string",
  enum: ["checked", "durable"],
  description:
    "checked (default) or durable. Both currently admit and store mail the same way. Neither bypasses closed T3 or unavailable bound sources. Unqualified standalone state remains unknown and is returned with warnings; storage does not transfer task ownership.",
};
const NOTIFICATION_POLICY = {
  type: "string",
  enum: ["wake", "quiet"],
  description:
    "wake (default) permits automatic inbox hints. quiet stores normal/low informational mail for inbox/search without waking the recipient; high/urgent importance or ack_required:true rejects. Omitted on a reply, defaults to wake rather than inheriting the original policy. Keep actionable handoffs, results and blockers on wake delivery.",
};
const RESERVATION_PATHS = strings("Only your reservations with exactly these patterns.");
const RESERVATION_IDS = {
  type: "array",
  items: { type: "integer" },
  description: "Only your reservations with these ids.",
};

interface ToolBase {
  name: string;
  description: string;
  properties: Record<string, Schema>;
  required: string[];
  /** Never writes, not even agent activity, so hosts may treat it as safe to run. */
  readOnly?: true;
  /** A repeat with the same arguments changes nothing more. */
  idempotent?: true;
  /** May overwrite or end something another call made, beyond adding new records. */
  destructive?: true;
  /** Can give a waiting session unread mail: a new message, or a newly tagged or unretired recipient. */
  wakes?: true;
  run: (s: MailStore, a: Args, info: { databasePath: string }) => unknown;
}

// A declared output contract always has a transaction-time check.
type Tool = ToolBase &
  (
    | { outputSchema: Schema; validateResult: (value: unknown) => boolean }
    | { outputSchema?: never; validateResult?: never }
  );

// FTS limits tokens, but a token or the punctuation between tokens can be arbitrarily long.
function boundedExcerpt(value: string, startMarker: string, endMarker: string): string {
  const match = Array.from(value.slice(0, Math.max(0, value.indexOf(startMarker)))).length;
  value = value.replaceAll(startMarker, ">>>").replaceAll(endMarker, "<<<");
  const chars = Array.from(value);
  if (chars.length <= 512) {
    return value;
  }
  const start = Math.max(0, match - 120);
  return (start ? "…" : "") + chars.slice(start, start + 510).join("") + "…";
}

function searchMessages(s: MailStore, a: Args) {
  const p = s.project(a.project_key);
  const terms = String(a.query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "query needs at least one word", {
      field: "query",
    });
  }
  const match = terms.map((t) => `"${t}"`).join(" ");
  const marker = crypto.randomUUID();
  const startMarker = `start-${marker}`;
  const endMarker = `end-${marker}`;
  const from = a.sender_name ?? null;
  const after = time(a.since, "since");
  const before = time(a.until, "until", true);
  const importance =
    a.importance == null
      ? null
      : JSON.stringify(
          String(a.importance)
            .split(",")
            .map((x) => x.trim()),
        );
  const limit = pageLimit(a.limit, "limit", 20);
  if (a.cursor !== undefined && (typeof a.cursor !== "string" || !/^o\d+$/.test(a.cursor))) {
    throw new ToolError("INVALID_ARGUMENT", "cursor must be a search continuation cursor", {
      field: "cursor",
    });
  }
  const offset = Number(a.cursor?.slice(1) ?? 0);
  if (!Number.isSafeInteger(offset) || offset > Number.MAX_SAFE_INTEGER - limit) {
    throw new ToolError("INVALID_ARGUMENT", "cursor exceeds the supported search range", {
      field: "cursor",
    });
  }
  const rows = s.search(p, {
    match,
    from,
    threadId: a.thread_id == null ? null : String(a.thread_id),
    importance,
    after,
    before,
    limit: limit + 1,
    offset,
    startMarker,
    endMarker,
    recency: a.ranking === "recency",
  });
  const result = rows.slice(0, limit).map(({ body_md, recipients_json, ...m }) => {
    const r = JSON.parse(recipients_json || "{}");
    // Omit an unset topic.
    const { topic, from, ...rest } = m;
    return {
      ...rest,
      has_withdrawn_deliveries: !!m.has_withdrawn_deliveries,
      created_ts: iso(m.created_ts),
      excerpt: boundedExcerpt(m.excerpt, startMarker, endMarker),
      ...(topic != null && { topic }),
      from,
      to: r.to ?? [],
      cc: r.cc ?? [],
      ...(a.include_body_md && { body_md }),
    };
  });
  return { result, ...(rows.length > limit && { next_cursor: `o${offset + limit}` }) };
}

export const TOOLS: Tool[] = [
  {
    name: "health_check",
    description:
      "Report whether the server and its database answer, with the database path. Call it " +
      "when another tool fails with an INTERNAL error or no answer, to tell a down server " +
      "from a bad request.",
    properties: {},
    required: [],
    readOnly: true,
    run: (s, _a, info) => {
      s.ping();
      return { status: "ok", database_path: info.databasePath };
    },
  },
  {
    name: "ensure_project",
    description:
      "Create a project without registering an agent, returning id, slug, human_key and " +
      "created_at. Repeating the same repository path returns the existing project. Other tools " +
      "fail with NOT_FOUND until it exists; register_agent and macro_start_session create it " +
      "themselves.",
    properties: { human_key: PROJECT },
    required: ["human_key"],
    idempotent: true,
    run: (s, a) => projectOut(s.ensureProject(a.human_key)),
  },
  {
    name: "register_agent",
    description:
      "Register or update an agent identity in a project, creating the project if needed. " +
      "Omit name to get a generated adjective+noun name, unless task_description starts with " +
      "a session tag an eligible or lifecycle-bound agent already has; then that agent is updated. Re-registering an " +
      "existing name replaces its program, model and task and clears inactivity retirement. Authoritative lifecycle closure requires a verified reopen. If " +
      "the register hook already told you your name, pass it as name, or start " +
      "task_description with the session tag it gave you. To also reserve paths and read " +
      "your inbox in one call, use macro_start_session.",
    properties: {
      project_key: PROJECT,
      program: PROGRAM,
      model: MODEL,
      name: prop("string", "Adjective+noun such as GreenLake. Omit to get one generated."),
      worktree: WORKTREE,
      task_description: TASK,
    },
    required: ["project_key", "program", "model"],
    destructive: true,
    wakes: true,
    run: (s, a) => agentOut(s.register(s.ensureProject(a.project_key), a)),
  },
  {
    name: "macro_start_session",
    description:
      "Ensure the project, register an agent, optionally reserve paths, and return {project, " +
      "agent, file_reservations, inbox}. The inbox contains the latest metadata without marking " +
      "mail read; use fetch_inbox for bodies and unread-mail draining. Reuse the hook's name as " +
      "agent_name or its session tag in task_description to avoid a second identity. Conflicting " +
      "paths appear under file_reservations.conflicts; other paths are granted. If already " +
      "registered and only checking mail, use fetch_inbox instead.",
    properties: {
      human_key: PROJECT,
      program: PROGRAM,
      model: MODEL,
      agent_name: prop("string", "Your existing name. Omit to get one generated."),
      worktree: WORKTREE,
      task_description: TASK,
      file_reservation_paths: strings("Repository-relative paths or globs to reserve."),
      file_reservation_reason: prop("string", "Shown to agents whose reservation conflicts."),
      file_reservation_ttl_seconds: prop(
        "integer",
        "Seconds, default 3600, at most 2592000 (30 days).",
      ),
      inbox_limit: prop("integer", "Positive page size; default 10, capped at 1000."),
    },
    required: ["human_key", "program", "model"],
    destructive: true,
    wakes: true,
    run: (s, a) => {
      const limit = pageLimit(a.inbox_limit, "inbox_limit", 10);
      const ttl = reservationSeconds(
        a.file_reservation_ttl_seconds,
        "file_reservation_ttl_seconds",
        3600,
      );
      const p = s.ensureProject(a.human_key);
      const who = s.register(p, { ...a, name: a.agent_name });
      const reservations = list(a.file_reservation_paths).length
        ? s.reserve(
            p,
            who,
            {
              paths: a.file_reservation_paths,
              reason: a.file_reservation_reason,
              ttl_seconds: ttl,
            },
            "file_reservation_ttl_seconds",
          )
        : { granted: [], conflicts: [] };
      return {
        project: projectOut(p),
        agent: agentOut(who),
        file_reservations: reservations,
        inbox: s.inbox(p, who, { limit }, false),
      };
    },
  },
  {
    name: "whois",
    description:
      "Return one agent's profile: program, model, task description, and first and last " +
      "activity times. An unknown name fails with NOT_FOUND, naming recently active agents. " +
      "Profile metadata and activity do not prove the session or model is currently running. " +
      "To see every agent in a project, use list_agents.",
    properties: { project_key: PROJECT, agent_name: prop("string", "The agent to look up.") },
    required: ["project_key", "agent_name"],
    readOnly: true,
    run: (s, a) => agentOut(s.agent(s.project(a.project_key), a.agent_name)),
  },
  {
    name: "list_agents",
    description:
      "Return an array of non-retired agents in a project, most recently active first, with " +
      "program, model, task and session details. Use it to find who to message; whois returns " +
      "one agent. active_within_days filters recent activity, not whether a session is running. " +
      "Metadata and activity do not prove current session or model liveness. " +
      "limit caps this single result; there is no continuation cursor, so a full result may omit " +
      "agents.",
    properties: {
      project_key: PROJECT,
      active_within_days: prop("number", "Above 0; fractions allowed. Omit for every agent."),
      limit: prop("integer", "Positive page size; default 250, capped at 1000."),
    },
    required: ["project_key"],
    readOnly: true,
    run: (s, a) => {
      const p = s.project(a.project_key);
      const since =
        a.active_within_days === undefined
          ? 0
          : nowUs() - num(a.active_within_days, "active_within_days", 0) * 86_400_000_000;
      const agents = s.liveAgents(p, since, pageLimit(a.limit, "limit", 250));
      const labels = locations(p.human_key, agents);
      return agents.map((r, i) => ({
        name: r.name,
        program: r.program,
        model: r.model,
        task_description: r.task_description,
        host: r.host,
        session_id: r.session_id,
        t3_thread: r.t3_thread,
        cwd: r.cwd,
        location: labels[i],
        inception_ts: iso(r.inception_ts),
        last_active_ts: iso(r.last_active_ts),
      }));
    },
  },
  {
    name: "retire_agent",
    description:
      "Retire an agent whose session has ended, so it no longer appears in list_agents and " +
      "new messages to it fail. Its messages stay. unretire_agent reverses it, and so does " +
      "the agent registering again or sending, reading mail or reserving files as itself. " +
      "Lookups such as whois and list_agents do not.",
    properties: { project_key: PROJECT, agent_name: prop("string", "The agent to retire.") },
    required: ["project_key", "agent_name"],
    run: (s, a) => {
      // Localhost callers can register directly.
      const p = s.project(a.project_key),
        who = s.agent(p, a.agent_name),
        now = nowUs();
      s.retire(who, now);
      return { agent_name: who.name, retired: true, retired_at: iso(now) };
    },
  },
  {
    name: "unretire_agent",
    description:
      "Bring a retired agent back into list_agents so it can receive messages again; earlier " +
      "messages stay unchanged. Returns {agent_name, retired:false}. Calling on an already " +
      "active agent also succeeds and refreshes its activity time, as every revival does. " +
      "Registering, sending, reading mail or reserving files revives the caller automatically; " +
      "use this to revive another agent. An unknown name fails with NOT_FOUND.",
    properties: {
      project_key: PROJECT,
      agent_name: prop("string", "The retired agent to bring back."),
    },
    required: ["project_key", "agent_name"],
    wakes: true,
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.agent(p, a.agent_name);
      s.unretire(who, nowUs());
      return { agent_name: who.name, retired: false };
    },
  },
  {
    name: "send_message",
    outputSchema: MESSAGE_RESULT,
    validateResult: isMessageResult,
    description:
      "Send a Markdown message to named agents in the same project. An unregistered, retired or closed " +
      "recipient fails the whole send with persisted:false and a reason. Bound source loss also rejects. " +
      "Returns the stored message and delivery observations/warnings; unknown standalone state is " +
      "not proof of death. Storage is not task acceptance. To answer a " +
      "message, use reply_message, which keeps the thread and addresses the sender. Without " +
      "idempotency_key, a retry sends another message; reuse a nonempty key with identical " +
      "arguments within 7 days to replay its stored result instead; delivery observations on replay are historical. " +
      SENDING_GUIDANCE,
    properties: {
      project_key: PROJECT,
      sender_name: AGENT,
      to: strings("Recipient agent names in this project."),
      cc: strings("Recipients copied, visible to everyone."),
      bcc: strings("Recipients the others do not see."),
      subject: prop("string", "One line, shown in inbox listings."),
      body_md: prop("string", "The message body, in Markdown."),
      importance: prop("string", "low, normal (default), high or urgent."),
      ack_required: prop("boolean", "Ask recipients to call acknowledge_message."),
      topic: prop("string", "A label fetch_inbox can filter on."),
      thread_id: prop("string", "A thread to join. reply_message sets it for you."),
      delivery_policy: DELIVERY_POLICY,
      notification_policy: NOTIFICATION_POLICY,
      idempotency_key: IDEMPOTENCY_KEY,
    },
    required: ["project_key", "sender_name", "to", "subject", "body_md"],
    wakes: true,
    run: (s, a) => {
      const p = s.project(a.project_key),
        sender = s.acting(p, a.sender_name, "sender_name");
      return s.idempotent("send_message", sender.id, a, () => s.deliver(p, sender, a));
    },
  },
  {
    name: "reply_message",
    outputSchema: REPLY_RESULT,
    validateResult: isReplyResult,
    description:
      "Reply in a message's thread, returning the stored message with reply_to. message_id " +
      "selects the original in this project. Omit to to address its sender; cc and bcc are added " +
      "only when supplied. The original's topic and importance are inherited, with a 'Re:' " +
      "subject; importance can be overridden. ack_required defaults to false; set it explicitly " +
      "to request acknowledgement of this reply. For retries within 7 " +
      "days, reuse a nonempty idempotency_key with identical arguments. To start a new thread, " +
      "use send_message. " +
      SENDING_GUIDANCE,
    properties: {
      project_key: PROJECT,
      message_id: prop("integer", "The message to reply to."),
      sender_name: AGENT,
      body_md: prop("string", "The reply body, in Markdown."),
      to: strings("Recipients; default the original sender."),
      cc: strings("Recipients copied, visible to everyone."),
      bcc: strings("Recipients the others do not see."),
      subject_prefix: prop("string", "Default 'Re:'; not added twice."),
      delivery_policy: DELIVERY_POLICY,
      notification_policy: NOTIFICATION_POLICY,
      importance: IMPORTANCE,
      ack_required: prop("boolean", "Ask recipients to call acknowledge_message."),
      idempotency_key: IDEMPOTENCY_KEY,
    },
    required: ["project_key", "message_id", "sender_name", "body_md"],
    wakes: true,
    run: (s, a) => {
      const p = s.project(a.project_key),
        sender = s.acting(p, a.sender_name, "sender_name");
      const original = s.message(p, a.message_id);
      const prefix = a.subject_prefix ?? "Re:";
      const subject = original.subject.toLowerCase().startsWith(prefix.toLowerCase())
        ? original.subject
        : `${prefix} ${original.subject}`;
      const to = a.to ?? [s.agentById(original.sender_id).name];
      return s.idempotent("reply_message", sender.id, a, () => {
        const m = s.deliver(
          p,
          sender,
          { ...a, to, subject: undefined, thread_id: undefined, topic: undefined },
          {
            thread_id: original.thread_id ?? String(original.id),
            topic: original.topic,
            subject,
            importance: original.importance,
            ack_required: false,
          },
        );
        return { ...m, reply_to: original.id };
      });
    },
  },
  {
    name: "withdraw_message",
    description:
      "Withdraw your message from recipients whose delivery has not been read, acknowledged or withdrawn. Returns message_id, revision and per-recipient withdrawn/already_withdrawn/too_late results. Omit recipients for all deliveries; an explicit subset must be nonempty and valid. Retains content and audit history. Previews and injected context cannot be recalled. Requires explicit server activation after all readers are qualified. A nonempty idempotency_key is required; identical retries replay even when execution is disabled or the sender closes.",
    properties: {
      project_key: PROJECT,
      sender_name: AGENT,
      message_id: MESSAGE,
      recipients: strings(
        "Optional nonempty subset of this message's recipient names; omit for all.",
      ),
      idempotency_key: IDEMPOTENCY_KEY,
    },
    required: ["project_key", "sender_name", "message_id", "idempotency_key"],
    destructive: true,
    idempotent: true,
    run: (s, a) => s.mutate(s.project(a.project_key), a, "withdraw_message"),
  },
  {
    name: "set_message_importance",
    description:
      "Change only your message's low/normal/high/urgent priority. Requires current expected_revision from inbox, history or sender receipt and a nonempty idempotency_key. Returns message_id, revision, importance and changed. A stale revision fails before a matching-value no-op. Edits affect metadata only: no new inbox notice or repeated instruction, and priority does not grant authority. Requires explicit server activation; identical retries replay before activation, lifecycle or revision checks.",
    properties: {
      project_key: PROJECT,
      sender_name: AGENT,
      message_id: MESSAGE,
      importance: { ...IMPORTANCE, enum: ["low", "normal", "high", "urgent"] },
      expected_revision: {
        type: "integer",
        minimum: 0,
        description:
          "Current message revision, initially 0; inspect metadata again after a conflict.",
      },
      idempotency_key: IDEMPOTENCY_KEY,
    },
    required: [
      "project_key",
      "sender_name",
      "message_id",
      "importance",
      "expected_revision",
      "idempotency_key",
    ],
    destructive: true,
    idempotent: true,
    run: (s, a) => s.mutate(s.project(a.project_key), a, "set_message_importance"),
  },
  {
    name: "fetch_inbox",
    description:
      "Return an array of your latest received message metadata, newest first; include_bodies " +
      "adds body_md. At session start or after a mail notice, set unread_only:true, " +
      "include_bodies:true and mark_read:true. Stop when fewer than limit messages return " +
      "(default 20, capped at 1000); repeat only after a full page. For a metadata " +
      "preview, set mark_read:false; include_bodies defaults to false and mark_read to true. " +
      "Filters combine, so omit optional filters when draining all unread mail. Use " +
      "search_messages for project-wide text matching, or mark_message_read or " +
      "acknowledge_message for one message.",
    properties: {
      project_key: PROJECT,
      agent_name: AGENT,
      limit: prop("integer", "Positive page size; default 20, capped at 1000."),
      unread_only: prop("boolean", "Only messages you have not read."),
      urgent_only: prop("boolean", "Only high and urgent."),
      ack_overdue_only: prop(
        "boolean",
        "Only unacknowledged ack_required messages older than 30 minutes.",
      ),
      since_ts: prop("string", "ISO-8601; only newer messages."),
      topic: prop("string", "Only messages with this topic."),
      include_bodies: prop("boolean", "Include each body_md; default false."),
      mark_read: prop("boolean", "Default true."),
    },
    required: ["project_key", "agent_name"],
    run: (s, a) => {
      a = { ...a, limit: pageLimit(a.limit, "limit", 20) };
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name);
      return s.inbox(p, who, a, a.mark_read ?? true);
    },
  },
  {
    name: "fetch_session_inbox",
    description:
      "Return one newest-first page across registrations matching your host/session tag or T3 thread. " +
      "Use machine-derived host and session_id, with t3_thread when known; never guess from an agent name. " +
      "Each receipt includes project_key and agent_name for replies and acknowledgements. Defaults: " +
      "unread_only:true, mark_read:true, include_bodies:false, limit:20. To drain, include bodies; " +
      "stop when fewer than limit messages return (default 20, capped at 1000), repeating only after a full page. " +
      "With mark_read:false or unread_only:false, this is a bounded preview, not a drain. " +
      "The CLI swarmail inbox --session discovers identity and drains without mailbox arguments. " +
      "Swarmail is a trusted local service; session identity selects inboxes and is not authentication.",
    properties: {
      host: prop(
        "string",
        "Host tag, such as claude, codex, cursor, devin, opencode, grok or agy.",
      ),
      session_id: prop(
        "string",
        "Your native host session ID from its shell variable or registration.",
      ),
      t3_thread: prop(
        "string",
        "Your T3 thread ID when known; includes older provider registrations in that thread.",
      ),
      limit: prop("integer", "Positive page size; default 20, capped at 1000."),
      unread_only: prop(
        "boolean",
        "Default true. False gives a bounded page including read receipts.",
      ),
      include_bodies: prop("boolean", "Include each body_md; default false."),
      mark_read: prop("boolean", "Default true. False previews without marking receipts read."),
    },
    required: ["host", "session_id"],
    run: (s, a) => s.sessionInbox(a),
  },
  {
    name: "mark_message_read",
    description:
      "Mark one received message read without acknowledging it, returning message_id, read and " +
      "read_at. A repeat keeps the first read time but refreshes your agent's activity time. " +
      "fetch_inbox already marks what it returns unless mark_read:false. When the message has " +
      "ack_required, use acknowledge_message instead. Fails with NOT_FOUND unless you are a " +
      "recipient.",
    properties: { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    required: ["project_key", "agent_name", "message_id"],
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name);
      const { id, r } = s.recipientRow(p, who, a.message_id);
      const readTs = r.read_ts ?? nowUs();
      if (r.read_ts == null) {
        s.markRead(id, who, readTs);
      }
      return { message_id: id, read: true, read_at: iso(readTs) };
    },
  },
  {
    name: "acknowledge_message",
    description:
      "Acknowledge one received message and mark it read, returning message_id, acknowledged, " +
      "acknowledged_at and read_at. Repeated calls preserve first read and acknowledgement " +
      "timestamps but refresh your agent's activity time. Acknowledge ack_required mail after " +
      "acting on it; if you cannot or will not act, reply with the reason. Acknowledging lets " +
      "the sender see the acknowledgement in get_message_delivery_receipt and ack_overdue_only " +
      "stops listing it. To mark read without acknowledging, use mark_message_read. Fails with " +
      "NOT_FOUND unless you are a recipient.",
    properties: { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    required: ["project_key", "agent_name", "message_id"],
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name);
      const { id, r } = s.recipientRow(p, who, a.message_id);
      const now = nowUs(),
        ackTs = r.ack_ts ?? now,
        readTs = r.read_ts ?? now;
      s.acknowledge(id, who, ackTs, readTs);
      return {
        message_id: id,
        acknowledged: true,
        acknowledged_at: iso(ackTs),
        read_at: iso(readTs),
      };
    },
  },
  {
    name: "get_message_delivery_receipt",
    outputSchema: RECEIPT_RESULT,
    validateResult: isReceiptResult,
    description:
      "Return a message's persisted_at and recipients with kind, read_at, acknowledged, " +
      "acknowledged_at and admission. Admission observations are historical; null admission means " +
      "no snapshot was recorded. Storage/read/acknowledgement do not establish task acceptance. " +
      "Null timestamps mean that recipient has not read or acknowledged it yet; " +
      "they are not delivery errors. Use it as the sender to check an ack_required message; " +
      "recipients use fetch_inbox. message_id must exist in this project or the call fails with " +
      "NOT_FOUND.",
    properties: { project_key: PROJECT, message_id: MESSAGE },
    required: ["project_key", "message_id"],
    readOnly: true,
    run: (s, a) => {
      const p = s.project(a.project_key);
      const m = s.message(p, a.message_id);
      const rows = s.receipts(m.id);
      // read_at tells a sender whether each recipient has fetched the message yet.
      return {
        message_id: m.id,
        project_id: p.id,
        persisted_at: iso(m.created_ts),
        revision: m.revision,
        recipients: rows.map((r) => ({
          recipient: r.name,
          kind: r.kind,
          read_at: iso(r.read_ts),
          acknowledged: r.ack_ts != null,
          acknowledged_at: iso(r.ack_ts),
          withdrawn_at: iso(r.withdrawn_ts),
          admission: r.admission_json
            ? { ...JSON.parse(r.admission_json), historical: true }
            : null,
        })),
      };
    },
  },
  {
    name: "search_messages",
    description:
      "Search subjects and bodies across a project, returning {result, next_cursor?} without " +
      "marking mail read. All query words must match; filters narrow those matches. Results rank " +
      "by best match unless ranking:'recency'. Each excerpt has up to 512 Unicode code points " +
      "and >>>matched text<<< markers; include_body_md adds full bodies. Keep query, filters and " +
      "ranking unchanged when passing next_cursor as cursor; no next_cursor means the last page. Use " +
      "fetch_inbox for your received unread mail, or summarize_thread for a thread's " +
      "participants and recent messages.",
    properties: {
      project_key: PROJECT,
      query: prop("string", "Words that must all appear; punctuation is ignored."),
      sender_name: prop("string", "Only messages from this agent."),
      thread_id: prop("string", "Only messages in this thread."),
      importance: prop("string", "Comma-separated levels to keep: low, normal, high, urgent."),
      since: prop("string", "ISO-8601"),
      until: prop("string", "ISO-8601"),
      limit: prop("integer", "Positive page size; default 20, capped at 1000."),
      cursor: prop("string", "The next_cursor of the previous page."),
      ranking: prop("string", "'recency' for newest first; omit for best match first."),
      include_body_md: prop("boolean", "Include each full body; default false."),
    },
    required: ["project_key", "query"],
    readOnly: true,
    run: searchMessages,
  },
  {
    name: "summarize_thread",
    description:
      "Return {thread_id, summary:{participants, total_messages}, messages} for you to " +
      "summarize; this tool does not generate prose or mark mail read. Find thread_id with " +
      "search_messages or fetch_inbox. per_thread_limit selects the newest messages with full " +
      "bodies, returned oldest first. It defaults to 50 and caps at 1000, with no continuation " +
      "cursor; total_messages counts the entire thread, even when messages is truncated. Use " +
      "search_messages for text matching and fetch_inbox to drain unread mail. No matching " +
      "thread returns zero messages.",
    properties: {
      project_key: PROJECT,
      thread_id: prop("string", "The first message's id, or the thread_id its replies carry."),
      per_thread_limit: prop(
        "integer",
        "Newest messages to return; positive page size, default 50, capped at 1000.",
      ),
    },
    required: ["project_key", "thread_id"],
    readOnly: true,
    run: (s, a) => {
      // Returns the thread for the caller to summarize.
      const p = s.project(a.project_key),
        threadId = str(a.thread_id == null ? a.thread_id : String(a.thread_id), "thread_id");
      const rows = s.thread(p, threadId);
      const limit = pageLimit(a.per_thread_limit, "per_thread_limit", 50);
      return {
        thread_id: threadId,
        summary: {
          participants: [...new Set(rows.map((r) => r.sender))],
          total_messages: rows.length,
        },
        messages: rows.slice(-limit).map((m) => ({
          id: m.id,
          from: m.sender,
          subject: m.subject,
          importance: m.importance,
          revision: m.revision,
          has_withdrawn_deliveries: !!m.has_withdrawn_deliveries,
          created_ts: iso(m.created_ts),
          body_md: m.body_md,
        })),
      };
    },
  },
  {
    name: "file_reservation_paths",
    description:
      "Reserve repository-relative paths or globs so other agents know what you are editing. " +
      "Returns {granted, conflicts}; grants include reservation ids and expiry times, while " +
      "conflicts name the requested path and its holders. Conflicts do not fail the call, and " +
      "nothing blocks the edit itself; the optional git guard refuses commits touching another " +
      "agent's exclusive reservation. Reserving a path you already hold updates it. Extend with " +
      "renew_file_reservations and release with release_file_reservations when done.",
    properties: {
      project_key: PROJECT,
      agent_name: AGENT,
      paths: strings("Repository-relative paths or globs."),
      ttl_seconds: prop("integer", "Seconds, default 3600, at most 2592000 (30 days)."),
      exclusive: prop(
        "boolean",
        "Default true. Shared reservations conflict only with exclusive ones.",
      ),
      reason: prop("string", "Shown to agents whose reservation conflicts."),
      idempotency_key: IDEMPOTENCY_KEY,
    },
    required: ["project_key", "agent_name", "paths"],
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name);
      return s.idempotent("file_reservation_paths", who.id, a, () => s.reserve(p, who, a));
    },
  },
  {
    name: "renew_file_reservations",
    description:
      "Extend your active reservations by extend_seconds past their current expiry; each call " +
      "extends again. Omit paths and file_reservation_ids for all; empty filters impose no " +
      "restriction, and two nonempty filters must both match. Returns {renewed, " +
      "file_reservations} with old and new expiry times; no matches returns zero and an empty " +
      "array. Expired reservations are not renewed; reserve them again with " +
      "file_reservation_paths.",
    properties: {
      project_key: PROJECT,
      agent_name: AGENT,
      extend_seconds: prop("integer", "Seconds, default 1800, at most 2592000 (30 days)."),
      paths: RESERVATION_PATHS,
      file_reservation_ids: RESERVATION_IDS,
    },
    required: ["project_key", "agent_name"],
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name);
      s.requireLifecycle(who);
      const extend = reservationSeconds(a.extend_seconds, "extend_seconds", 1800) * 1_000_000;
      const renewed = s.ownActive(p, who, a).map((r) => {
        const next = r.expires_ts + extend;
        s.setExpiry(r.id, next);
        return {
          id: r.id,
          path_pattern: r.path_pattern,
          old_expires_ts: iso(r.expires_ts),
          new_expires_ts: iso(next),
        };
      });
      return { renewed: renewed.length, file_reservations: renewed };
    },
  },
  {
    name: "release_file_reservations",
    description:
      "Release your active reservations when you finish work so other agents can reserve " +
      "those paths. While work continues, use renew_file_reservations instead. Omit both " +
      "filters to release all; supply paths or file_reservation_ids for a subset. Empty " +
      "filters impose no restriction; two nonempty filters must both match. " +
      "Returns how many were released; " +
      "zero is not an error.",
    properties: {
      project_key: PROJECT,
      agent_name: AGENT,
      paths: RESERVATION_PATHS,
      file_reservation_ids: RESERVATION_IDS,
    },
    required: ["project_key", "agent_name"],
    destructive: true,
    run: (s, a) => {
      const p = s.project(a.project_key),
        who = s.acting(p, a.agent_name),
        now = nowUs();
      const rows = s.ownActive(p, who, a);
      for (const r of rows) {
        s.release(r.id, now);
      }
      return { released: rows.length, released_at: iso(now) };
    },
  },
];

/** The tools/list answer. Every tool declares its hints, and none reaches outside the server's own database. */
export const TOOL_DEFINITIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: "object", properties: t.properties, required: t.required },
  ...(t.outputSchema && { outputSchema: t.outputSchema }),
  annotations: t.readOnly
    ? { readOnlyHint: true, openWorldHint: false }
    : {
        readOnlyHint: false,
        destructiveHint: !!t.destructive,
        idempotentHint: !!t.idempotent,
        openWorldHint: false,
      },
}));

/** Tools whose success can leave a waiting session with unread mail. */
export const WAKES = new Set(TOOLS.filter((t) => t.wakes).map((t) => t.name));

// One transaction per call: a tool that throws partway, such as a register that fails after its project was created,
// writes nothing.
export function createTools(
  db: Database,
  info: {
    databasePath: string;
    lifecycle?: Lifecycle;
    registry?: string;
    mutationsEnabled?: boolean;
  },
): Record<string, (a: Args) => unknown> {
  const s = new MailStore(db, info.lifecycle, info.registry, info.mutationsEnabled);
  return Object.fromEntries(
    TOOLS.map((t) => [
      t.name,
      (a: Args) =>
        s.atomic(() => {
          const value = t.run(s, a, info);
          const validate = t.validateResult;
          if (validate) {
            if (!validate(value)) {
              console.error(`Invalid ${t.name} result`);
              throw new ToolError("INTERNAL", "Tool result failed validation");
            }
            // Serialization is part of the transaction too; never report failure after storing mail.
            JSON.stringify(value);
          }
          return value;
        }),
    ]),
  );
}
