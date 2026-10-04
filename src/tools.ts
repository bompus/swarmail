// Swarmail tools, one row each: the MCP definition, its flags and its handler. Shared lookups and writes live in
// store.ts.
import type { Database } from "bun:sqlite";
import { iso, nowUs } from "./db.ts";
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
const TASK = prop(
  "string",
  "What you are working on. Keep the leading [host:session ...] tag the register hook gave you.",
);
const IDEMPOTENCY_KEY = prop(
  "string",
  "Any string. A retry with the same key and arguments returns the first result.",
);
const IMPORTANCE = prop("string", "low, normal, high or urgent.");
const RESERVATION_PATHS = strings("Only your reservations with exactly these patterns.");
const RESERVATION_IDS = {
  type: "array",
  items: { type: "integer" },
  description: "Only your reservations with these ids.",
};

interface Tool {
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
      "Create the project for a repository path if it does not exist, and return it. Other " +
      "tools fail with NOT_FOUND until the project exists. register_agent and " +
      "macro_start_session create it themselves, so call this only to create a project " +
      "without registering.",
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
      "a session tag a live agent already has; then that agent is updated. Re-registering an " +
      "existing name replaces its program, model and task and brings it back if retired. If " +
      "the register hook already told you your name, pass it as name, or start " +
      "task_description with the session tag it gave you. To also reserve paths and read " +
      "your inbox in one call, use macro_start_session.",
    properties: {
      project_key: PROJECT,
      program: PROGRAM,
      model: MODEL,
      name: prop("string", "Adjective+noun such as GreenLake. Omit to get one generated."),
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
      "Start a session in one call: ensure the project, register the agent, optionally " +
      "reserve paths, and return the latest inbox without marking it read. If the register " +
      "hook already told you your name, pass it as agent_name, or start task_description with " +
      "the session tag it gave you; otherwise you get a second name. Paths another agent " +
      "holds come back as conflicts, as in file_reservation_paths.",
    properties: {
      human_key: PROJECT,
      program: PROGRAM,
      model: MODEL,
      agent_name: prop("string", "Your existing name. Omit to get one generated."),
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
      "To see every agent in a project, use list_agents.",
    properties: { project_key: PROJECT, agent_name: prop("string", "The agent to look up.") },
    required: ["project_key", "agent_name"],
    readOnly: true,
    run: (s, a) => agentOut(s.agent(s.project(a.project_key), a.agent_name)),
  },
  {
    name: "list_agents",
    description:
      "List a project's agents that are not retired, most recently active first, with each " +
      "one's program, model, task and session. Use it to find who to message; whois returns " +
      "one agent.",
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
      return s.liveAgents(p, since, pageLimit(a.limit, "limit", 250)).map((r) => ({
        name: r.name,
        program: r.program,
        model: r.model,
        task_description: r.task_description,
        host: r.host,
        session_id: r.session_id,
        t3_thread: r.t3_thread,
        cwd: r.cwd,
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
      "any tool call the agent makes as itself.",
    properties: { project_key: PROJECT, agent_name: prop("string", "The agent to retire.") },
    required: ["project_key", "agent_name"],
    idempotent: true,
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
      "Bring a retired agent back into list_agents so it can receive messages again; its " +
      "earlier messages are unchanged. An agent that calls a tool as itself or registers " +
      "again comes back on its own, so use this to revive another agent.",
    properties: {
      project_key: PROJECT,
      agent_name: prop("string", "The retired agent to bring back."),
    },
    required: ["project_key", "agent_name"],
    idempotent: true,
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
    description:
      "Send a Markdown message to agents in the same project. An unknown or retired recipient " +
      "fails the whole send. Returns the message, including its id. To answer a message, use " +
      "reply_message, which keeps the thread and addresses the sender.",
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
    description:
      "Reply in a message's thread. Defaults: to the original sender, the original's topic, " +
      "importance and ack_required, and a 'Re:' subject. Returns the message with reply_to. " +
      "To start a new thread, use send_message.",
    properties: {
      project_key: PROJECT,
      message_id: prop("integer", "The message to reply to."),
      sender_name: AGENT,
      body_md: prop("string", "The reply body, in Markdown."),
      to: strings("Recipients; default the original sender."),
      cc: strings("Recipients copied, visible to everyone."),
      bcc: strings("Recipients the others do not see."),
      subject_prefix: prop("string", "Default 'Re:'; not added twice."),
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
            ack_required: !!original.ack_required,
          },
        );
        return { ...m, reply_to: original.id };
      });
    },
  },
  {
    name: "fetch_inbox",
    description:
      "Return your latest messages, newest first, and mark them read unless mark_read is " +
      "false. Check it at the start of a session and when a wake hook says mail arrived. To " +
      "change one message, use mark_message_read or acknowledge_message.",
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
    name: "mark_message_read",
    description:
      "Mark one message read for you, without acknowledging it; a repeat keeps the first " +
      "read time. fetch_inbox already marks what it returns. When the message has " +
      "ack_required, use acknowledge_message instead. Fails with NOT_FOUND unless you are " +
      "a recipient.",
    properties: { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    required: ["project_key", "agent_name", "message_id"],
    idempotent: true,
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
      "Acknowledge one message, which also marks it read; a repeat keeps the first times. " +
      "Use it for messages with ack_required: the sender sees it in " +
      "get_message_delivery_receipt, and fetch_inbox stops listing it under " +
      "ack_overdue_only. Fails with NOT_FOUND unless you are a recipient.",
    properties: { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    required: ["project_key", "agent_name", "message_id"],
    idempotent: true,
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
    description:
      "Show, per recipient, whether and when a message was read and acknowledged. Use it as " +
      "the sender to check an ack_required message; recipients use fetch_inbox.",
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
        recipients: rows.map((r) => ({
          recipient: r.name,
          kind: r.kind,
          read_at: iso(r.read_ts),
          acknowledged: r.ack_ts != null,
          acknowledged_at: iso(r.ack_ts),
        })),
      };
    },
  },
  {
    name: "search_messages",
    description:
      "Full-text search over subjects and bodies in a project, best match first " +
      "(ranking: 'recency' for newest first). Results include an excerpt of up to 512 Unicode " +
      "code points from the best matching subject or body, with >>>matched text<<< markers. " +
      "Pass next_cursor back as cursor for the next page. To read one whole thread, use " +
      "summarize_thread.",
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
      "Return a thread's participants, message count and messages with bodies, oldest " +
      "first, for you to summarize. Find a thread_id with search_messages or fetch_inbox.",
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
          created_ts: iso(m.created_ts),
          body_md: m.body_md,
        })),
      };
    },
  },
  {
    name: "file_reservation_paths",
    description:
      "Advisory reservation of paths or globs so other agents know what you are editing. " +
      "Paths another agent holds come back as conflicts, not grants. Nothing blocks the edit " +
      "itself; the optional git guard refuses commits that touch another agent's exclusive " +
      "reservation. Reserving a path you already hold updates it. Extend with " +
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
      "Extend your active reservations, all or those matching paths or ids, by " +
      "extend_seconds past their current expiry; each call extends again. Expired " +
      "reservations are not renewed; reserve them again with file_reservation_paths.",
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
      "Release your active reservations, all or those matching paths or ids, so other " +
      "agents can reserve those paths. Returns how many were released; zero is not an error.",
    properties: {
      project_key: PROJECT,
      agent_name: AGENT,
      paths: RESERVATION_PATHS,
      file_reservation_ids: RESERVATION_IDS,
    },
    required: ["project_key", "agent_name"],
    idempotent: true,
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
  info: { databasePath: string },
): Record<string, (a: Args) => unknown> {
  const s = new MailStore(db);
  return Object.fromEntries(
    TOOLS.map((t) => [t.name, (a: Args) => s.atomic(() => t.run(s, a, info))]),
  );
}
