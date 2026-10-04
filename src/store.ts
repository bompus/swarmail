// The mail store behind the tools: argument checks, lookups and the write paths the tools share.
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { primaryCheckout } from "./checkout.ts";
import { overlaps } from "./glob.ts";
import { identity, leadingTag, parseTag, sameSessionRow, tagOf, type Identity } from "./tag.ts";
import { InvalidTimestamp, iso, nowUs, parseIso } from "./db.ts";

/** A tool failure reported to the caller as `{"error": {type, message, recoverable, data}}`. */
export class ToolError extends Error {
  readonly type: string;
  readonly data: Record<string, unknown>;
  constructor(type: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.type = type;
    this.data = data;
  }
}

/** Positive safe-integer page sizes, capped to keep one tool response bounded. */
export function pageLimit(value: unknown, field: string, fallback: number): number {
  const limit = value === undefined ? fallback : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ToolError("INVALID_ARGUMENT", `${field} must be a positive safe integer`, { field });
  }
  return Math.min(limit, 1000);
}

/** A JSON number above zero and at most `max` (named when finite and set), or `fallback` when absent; `integer` also requires a whole number. */
export function num(
  value: unknown,
  field: string,
  fallback: number,
  { max = Number.MAX_SAFE_INTEGER, integer = false } = {},
): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !(n > 0 && n <= max) || (integer && !Number.isInteger(n))) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${field} must be a ${integer ? "whole number" : "number"} above 0${Number.isFinite(max) && max !== Number.MAX_SAFE_INTEGER ? ` and at most ${max}` : ""}`,
      { field },
    );
  }
  return n;
}

/** Reservation times in seconds: whole, above zero, up to 30 days. */
export const reservationSeconds = (value: unknown, field: string, fallback: number) =>
  num(value, field, fallback, { max: 30 * 86_400, integer: true });

export type Args = Record<string, any>;
export type Row = Record<string, any>;
export interface Project {
  id: number;
  slug: string;
  human_key: string;
  created_at: number;
}
export interface Agent extends Identity {
  id: number;
  project_id: number;
  name: string;
  program: string;
  model: string;
  task_description: string;
  inception_ts: number;
  last_active_ts: number;
  retired_at: number | null;
}

const ADJECTIVES = [
  "Amber",
  "Azure",
  "Black",
  "Blue",
  "Bold",
  "Brave",
  "Bright",
  "Brown",
  "Calm",
  "Coral",
  "Crimson",
  "Dark",
  "Frost",
  "Gold",
  "Gray",
  "Green",
  "Indigo",
  "Iron",
  "Jade",
  "Lavender",
  "Lime",
  "Maroon",
  "Mint",
  "Navy",
  "Olive",
  "Orange",
  "Peach",
  "Pink",
  "Plum",
  "Purple",
  "Quiet",
  "Red",
  "Rose",
  "Ruby",
  "Rust",
  "Sage",
  "Silver",
  "Swift",
  "Tan",
  "Teal",
  "Violet",
  "White",
  "Wild",
  "Yellow",
];
const NOUNS = [
  "Anchor",
  "Bear",
  "Brook",
  "Canyon",
  "Castle",
  "Cliff",
  "Cloud",
  "Creek",
  "Crow",
  "Dog",
  "Dove",
  "Dune",
  "Falcon",
  "Fern",
  "Forest",
  "Fox",
  "Glen",
  "Hawk",
  "Heron",
  "Hill",
  "Horse",
  "Lake",
  "Maple",
  "Meadow",
  "Moose",
  "Mountain",
  "Oak",
  "Otter",
  "Owl",
  "Peak",
  "Pike",
  "Pine",
  "Pond",
  "Raven",
  "Ridge",
  "River",
  "Rock",
  "Sparrow",
  "Stone",
  "Thrush",
  "Tiger",
  "Valley",
  "Willow",
  "Wolf",
];
const NAME_RE = /^[A-Z][a-z]+[A-Z][a-z]+$/;

export function slugify(humanKey: string): string {
  return humanKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ToolError("INVALID_ARGUMENT", `${field} is required`, { field });
  }
  return value;
}

export function list(value: unknown): string[] {
  return value == null ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
}

export function time(value: unknown, field: string, endOfDay = false): number | null {
  if (value == null || value === "") {
    return null;
  }
  try {
    // A date-only upper bound covers the whole day.
    const us = parseIso(String(value));
    return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? us + 86_400_000_000 - 1 : us;
  } catch (e) {
    if (e instanceof InvalidTimestamp) {
      throw new ToolError("INVALID_ARGUMENT", e.message, { field });
    }
    throw e;
  }
}

export const agentOut = (a: Agent) => ({
  id: a.id,
  name: a.name,
  program: a.program,
  model: a.model,
  task_description: a.task_description,
  inception_ts: iso(a.inception_ts),
  last_active_ts: iso(a.last_active_ts),
  project_id: a.project_id,
});

export const projectOut = (p: Project) => ({
  id: p.id,
  slug: p.slug,
  human_key: p.human_key,
  created_at: iso(p.created_at),
});

const payload = (m: Row, sender: string) => ({
  id: m.id,
  project_id: m.project_id,
  sender_id: m.sender_id,
  thread_id: m.thread_id,
  topic: m.topic,
  subject: m.subject,
  body_md: m.body_md,
  importance: m.importance,
  ack_required: !!m.ack_required,
  created_ts: iso(m.created_ts),
  from: sender,
  to: [],
  cc: [],
  bcc: [],
  ...JSON.parse(m.recipients_json),
});

const inboxOut = (m: Row, includeBody: boolean) => ({
  id: m.id,
  project_id: m.project_id,
  sender_id: m.sender_id,
  thread_id: m.thread_id,
  topic: m.topic,
  subject: m.subject,
  importance: m.importance,
  ack_required: !!m.ack_required,
  from: m.from,
  created_ts: iso(m.created_ts),
  // Omit unset read_ts and ack_ts.
  ...(m.read_ts != null && { read_ts: iso(m.read_ts) }),
  ...(m.ack_ts != null && { ack_ts: iso(m.ack_ts) }),
  kind: m.kind,
  ...(includeBody && { body_md: m.body_md }),
});

const queries = (db: Database) => ({
  projectByKey: db.query<Project, [string, string]>(
    "SELECT * FROM projects WHERE human_key = ? OR slug = ? ORDER BY id LIMIT 1",
  ),
  insertProject: db.query<Project, [string, string, number]>(
    "INSERT INTO projects (slug, human_key, created_at) VALUES (?, ?, ?) RETURNING *",
  ),
  agentByName: db.query<Agent, [number, string]>(
    "SELECT * FROM agents WHERE project_id = ? AND name = ? COLLATE NOCASE",
  ),
  agentById: db.query<Agent, [number]>("SELECT * FROM agents WHERE id = ?"),
  liveAgentsInSession: db.query<Agent, [number, string | null, string | null]>(
    "SELECT * FROM agents WHERE project_id = ?1 AND retired_at IS NULL AND (t3_thread = ?2 OR session_id = ?3) ORDER BY last_active_ts DESC, id DESC",
  ),
  agentProjects: db.query<{ human_key: string; retired_at: number | null }, [string, number]>(
    "SELECT p.human_key, a.retired_at FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.name = ? COLLATE NOCASE AND a.project_id != ? ORDER BY a.last_active_ts DESC",
  ),
  agentNames: db.query<{ name: string }, [number]>(
    "SELECT name FROM agents WHERE project_id = ? AND retired_at IS NULL ORDER BY last_active_ts DESC, id DESC",
  ),
  touch: db.query<unknown, [number, number]>(
    "UPDATE agents SET last_active_ts = ?, retired_at = NULL WHERE id = ?",
  ),
  message: db.query<Row, [number, number]>(
    "SELECT * FROM messages WHERE id = ? AND project_id = ?",
  ),
  recipient: db.query<Row, [number, number]>(
    "SELECT * FROM message_recipients WHERE message_id = ? AND agent_id = ?",
  ),
});

/** Lookups and writes over one mail database; the tools are thin wrappers around these. */
export class MailStore {
  private readonly db: Database;
  private readonly q: ReturnType<typeof queries>;
  private readonly tx: (run: () => unknown) => unknown;

  constructor(db: Database) {
    this.db = db;
    this.q = queries(db);
    this.tx = db.transaction((run: () => unknown) => run());
  }

  private readonly checkouts = new Map<string, string>();

  /** Runs one tool call in one transaction, so a call that throws partway leaves no partial write. */
  atomic<T>(run: () => T): T {
    return this.tx(run) as T;
  }

  /** Reads a real table, so a closed, locked or unreadable database throws. */
  ping(): void {
    this.db.query("SELECT 1 FROM projects LIMIT 1").get();
  }

  /**
   * A path inside a git worktree or subdirectory names the repository's primary checkout, where
   * sessions register. Other keys, and the primary checkout under any alias, stay as given.
   */
  projectKey(key: string): string {
    if (!isAbsolute(key) || !existsSync(key)) {
      return key;
    }
    let canonical = this.checkouts.get(key);
    if (canonical === undefined) {
      const primary = primaryCheckout(key);
      canonical = primary && realpathSync.native(key) !== primary ? primary : key;
      this.checkouts.set(key, canonical);
    }
    return canonical;
  }

  /**
   * The project a key names. A row stored under the exact key wins, so a project created under a
   * worktree path stays reachable by that path.
   */
  private lookup(given: string): { k: string; p: Project | null } {
    const exact = this.q.projectByKey.get(given, slugify(given));
    const k = exact ? given : this.projectKey(given);
    return { k, p: exact ?? (k === given ? null : this.q.projectByKey.get(k, slugify(k))) };
  }

  project(key: unknown): Project {
    const { k, p } = this.lookup(str(key, "project_key"));
    if (!p) {
      throw new ToolError(
        "NOT_FOUND",
        `Project '${k}' not found. Use ensure_project to create it.`,
        { identifier: k },
      );
    }
    return p;
  }

  ensureProject(key: unknown): Project {
    const { k, p } = this.lookup(str(key, "human_key"));
    return p ?? this.q.insertProject.get(slugify(k), k, nowUs())!;
  }

  recipient(p: Project, name: string): Agent {
    const a = this.agent(p, name, "to");
    if (a.retired_at != null) {
      throw new ToolError(
        "NOT_FOUND",
        `Agent '${a.name}' is retired and does not accept new messages.`,
        { agent_name: a.name },
      );
    }
    return a;
  }

  agent(p: Project, name: unknown, field = "agent_name"): Agent {
    const n = str(name, field);
    const a = this.q.agentByName.get(p.id, n);
    if (!a) {
      const active = this.q.agentNames.all(p.id).map((r) => r.name);
      const recent = active.slice(0, 10);
      const more =
        active.length > recent.length ? ` and ${active.length - recent.length} more` : "";
      // A name registered under another project_key is the usual cause, not a misspelling.
      // A retired recipient takes no messages there either; an agent's own retired name comes back when it acts.
      const matches = this.q.agentProjects.all(n, p.id);
      const elsewhere = matches.map((r) => r.human_key);
      const usable = matches
        .filter((r) => field !== "to" || r.retired_at == null)
        .map((r) => `'${r.human_key}'`);
      const advice = usable.length
        ? `'${n}' is registered in project ${usable.join(", ")}; pass that project_key${
            field === "to" ? ", registering there first if you are not" : ""
          }.`
        : elsewhere.length
          ? `'${n}' is retired in project ${elsewhere.map((k) => `'${k}'`).join(", ")} and accepts no messages until it registers again.`
          : field === "to"
            ? "Check the recipient's spelling; list_agents shows every agent."
            : "Find your name with `swarmail who`, or call register_agent without a name to get one.";
      throw new ToolError(
        "NOT_FOUND",
        `Agent '${n}' not found in project '${p.human_key}'. Recently active: ${
          recent.map((x) => `'${x}'`).join(", ") || "none"
        }${more}. ${advice}`,
        {
          agent_name: n,
          available_agents: recent,
          active_agents: active.length,
          registered_in: elsewhere,
        },
      );
    }
    return a;
  }

  // Every successful tool call an agent makes as itself counts as activity, which list_agents orders by, and brings
  // back an agent the server retired for idleness.
  acting(p: Project, name: unknown, field = "agent_name"): Agent {
    const a = this.agent(p, name, field);
    a.last_active_ts = nowUs();
    a.retired_at = null;
    this.q.touch.run(a.last_active_ts, a.id);
    return a;
  }

  agentById(id: number): Agent {
    return this.q.agentById.get(id)!;
  }

  /** A project's agents that are not retired, most recently active first. */
  liveAgents(p: Project, activeSince: number, limit: number): Agent[] {
    return this.db
      .query<Agent, [number, number, number]>(
        `SELECT * FROM agents WHERE project_id = ? AND retired_at IS NULL AND last_active_ts >= ?
         ORDER BY last_active_ts DESC, id DESC LIMIT ?`,
      )
      .all(p.id, activeSince, limit);
  }

  retire(who: Agent, now: number): void {
    this.db.run("UPDATE agents SET retired_at = ? WHERE id = ?", [now, who.id]);
  }

  unretire(who: Agent, now: number): void {
    this.db.run("UPDATE agents SET retired_at = NULL, last_active_ts = ? WHERE id = ?", [
      now,
      who.id,
    ]);
  }

  uniqueName(projectId: number): string {
    for (let i = 0; i < 200; i++) {
      const n =
        ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]! +
        NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
      if (!this.q.agentByName.get(projectId, n)) {
        return n;
      }
    }
    throw new ToolError("INTERNAL", "could not find a free agent name");
  }

  /**
   * The live agent whose leading tag names the same session as `task`'s, most recently active
   * first, so a session that registers again without its name keeps it instead of getting a second.
   */
  private agentForTag(projectId: number, task: unknown): Agent | null {
    const tag = parseTag(leadingTag(String(task ?? "")));
    if (!tag?.t3 && !tag?.sessionId) {
      return null;
    }
    const rows = this.q.liveAgentsInSession.all(projectId, tag.t3, tag.sessionId);
    return sameSessionRow(rows, tag, tagOf);
  }

  register(p: Project, a: Args): Agent {
    const name = a.name;
    if (name != null && !NAME_RE.test(name)) {
      throw new ToolError(
        "INVALID_AGENT_NAME",
        `Invalid agent name format: '${name}'. Agent names are adjective+noun ` +
          "combinations such as 'GreenLake'. Omit the name to generate one.",
        { provided: name },
      );
    }
    const now = nowUs();
    const existing =
      name == null
        ? this.agentForTag(p.id, a.task_description)
        : this.q.agentByName.get(p.id, name);
    if (existing) {
      // Re-registering replaces the task description. A leading `[host:session ...]` tag routes
      // wake-ups (wake.ts), so a new description without one keeps the old tag.
      const tag = leadingTag(existing.task_description);
      const task = String(a.task_description ?? "");
      const description = tag && !leadingTag(task) ? `${tag} ${task}`.trim() : task;
      const id = identity(description);
      this.db.run(
        `UPDATE agents SET program = ?, model = ?, task_description = ?, last_active_ts = ?, retired_at = NULL,
        host = ?, session_id = ?, t3_thread = ?, build = ?, cwd = ? WHERE id = ?`,
        [
          str(a.program, "program"),
          str(a.model, "model"),
          description,
          now,
          id.host,
          id.session_id,
          id.t3_thread,
          id.build,
          id.cwd,
          existing.id,
        ],
      );
      return this.q.agentById.get(existing.id)!;
    }
    const description = String(a.task_description ?? "");
    const id = identity(description);
    return this.db
      .query<Agent, (string | number | null)[]>(
        `INSERT INTO agents (project_id, name, program, model, task_description, inception_ts, last_active_ts,
         host, session_id, t3_thread, build, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        p.id,
        name ?? this.uniqueName(p.id),
        str(a.program, "program"),
        str(a.model, "model"),
        description,
        now,
        now,
        id.host,
        id.session_id,
        id.t3_thread,
        id.build,
        id.cwd,
      )!;
  }

  // With a key, a repeat of the same arguments returns the first result marked idempotent_replay; the same key with
  // different arguments is a conflict, never a silent replay. The caller's atomic() keeps the key and the write together.
  idempotent<T extends object>(tool: string, agentId: number, a: Args, run: () => T): T {
    if (!this.db.inTransaction) {
      throw new Error("idempotent() runs inside atomic()");
    }
    const key = a.idempotency_key;
    if (key == null || key === "") {
      return run();
    }
    const { idempotency_key, ...rest } = a;
    const fingerprint = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify(
          Object.keys(rest)
            .sort()
            .map((k) => [k, rest[k]]),
        ),
      )
      .digest("hex");
    const hit = this.db
      .query<{ result: string; fingerprint: string }, [string, number, string]>(
        "SELECT result, fingerprint FROM idempotency_keys WHERE tool = ? AND agent_id = ? AND key = ?",
      )
      .get(tool, agentId, String(key));
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        throw new ToolError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `idempotency_key '${key}' was already used with different arguments`,
          {
            idempotency_key: key,
          },
        );
      }
      return { ...JSON.parse(hit.result), idempotent_replay: true } as T;
    }
    const result = run();
    this.db.run("INSERT INTO idempotency_keys VALUES (?, ?, ?, ?, ?, ?)", [
      tool,
      agentId,
      String(key),
      fingerprint,
      JSON.stringify(result),
      nowUs(),
    ]);
    return result;
  }

  deliver(p: Project, sender: Agent, a: Args, defaults: Row = {}) {
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
    const recipients = [
      ...to.map((n) => [n, "to"]),
      ...cc.map((n) => [n, "cc"]),
      ...bcc.map((n) => [n, "bcc"]),
    ].map(([n, kind]) => ({
      agent: this.recipient(p, n!),
      kind: kind!,
    }));
    const names = (kind: string) =>
      recipients.filter((r) => r.kind === kind).map((r) => r.agent.name);
    const m = this.db
      .query<Row, any[]>(
        `INSERT INTO messages (project_id, sender_id, thread_id, topic, subject, body_md, importance, ack_required,
         created_ts, recipients_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        p.id,
        sender.id,
        a.thread_id ?? defaults.thread_id ?? null,
        a.topic ?? defaults.topic ?? null,
        str(a.subject ?? defaults.subject, "subject"),
        str(a.body_md, "body_md"),
        a.importance ?? defaults.importance ?? "normal",
        (a.ack_required ?? defaults.ack_required) ? 1 : 0,
        nowUs(),
        JSON.stringify({ to: names("to"), cc: names("cc"), bcc: names("bcc") }),
      )!;
    const add = this.db.query(
      "INSERT OR IGNORE INTO message_recipients (message_id, agent_id, kind, created_ts) VALUES (?, ?, ?, ?)",
    );
    for (const r of recipients) {
      add.run(m.id, r.agent.id, r.kind, m.created_ts);
    }
    return payload(m, sender.name);
  }

  inbox(p: Project, who: Agent, a: Args, markRead: boolean) {
    const now = nowUs();
    const rows = this.db
      .query<Row, any[]>(
        `SELECT m.id, m.project_id, m.sender_id, m.thread_id, m.topic, m.subject, m.importance, m.ack_required,
              s.name AS "from", m.created_ts, r.read_ts, r.ack_ts, r.kind, m.body_md
       FROM message_recipients r JOIN messages m ON m.id = r.message_id JOIN agents s ON s.id = m.sender_id
       WHERE r.agent_id = ?1 AND (?2 = 0 OR r.read_ts IS NULL) AND (?3 = 0 OR m.importance IN ('high', 'urgent'))
         AND r.created_ts > ?4 AND (?5 IS NULL OR m.topic = ?5)
         AND (?6 = 0 OR (m.ack_required = 1 AND r.ack_ts IS NULL AND m.created_ts < ?7))
       ORDER BY r.created_ts DESC, r.message_id DESC LIMIT ?8`,
      )
      .all(
        who.id,
        a.unread_only ? 1 : 0,
        a.urgent_only ? 1 : 0,
        time(a.since_ts, "since_ts") ?? -1,
        a.topic ?? null,
        a.ack_overdue_only ? 1 : 0,
        now - 30 * 60 * 1_000_000,
        pageLimit(a.limit, "limit", 20),
      );
    if (markRead) {
      const mark = this.db.query(
        "UPDATE message_recipients SET read_ts = ? WHERE message_id = ? AND agent_id = ? AND read_ts IS NULL",
      );
      for (const r of rows.filter((row) => row.read_ts == null)) {
        mark.run(now, r.id, who.id);
        r.read_ts = now;
      }
    }
    return rows.map((m) => inboxOut(m, !!a.include_bodies));
  }

  message(p: Project, messageId: unknown) {
    const m = this.q.message.get(Number(messageId), p.id);
    if (!m) {
      throw new ToolError(
        "NOT_FOUND",
        `Message ${messageId} not found in project '${p.human_key}'`,
        { message_id: messageId },
      );
    }
    return m;
  }

  recipientRow(p: Project, who: Agent, messageId: unknown) {
    const id = this.message(p, messageId).id;
    const r = this.q.recipient.get(id, who.id);
    if (!r) {
      throw new ToolError("NOT_FOUND", `${who.name} is not a recipient of message ${id}`, {
        message_id: id,
        agent_name: who.name,
      });
    }
    return { id, r };
  }

  markRead(messageId: number, who: Agent, readTs: number): void {
    this.db.run("UPDATE message_recipients SET read_ts = ? WHERE message_id = ? AND agent_id = ?", [
      readTs,
      messageId,
      who.id,
    ]);
  }

  acknowledge(messageId: number, who: Agent, ackTs: number, readTs: number): void {
    this.db.run(
      "UPDATE message_recipients SET ack_ts = ?, read_ts = ? WHERE message_id = ? AND agent_id = ?",
      [ackTs, readTs, messageId, who.id],
    );
  }

  /** Each recipient of a message with its read and acknowledge times, by name. */
  receipts(messageId: number): Row[] {
    return this.db
      .query<Row, [number]>(
        `SELECT a.name, r.kind, r.read_ts, r.ack_ts FROM message_recipients r JOIN agents a ON a.id = r.agent_id
         WHERE r.message_id = ? ORDER BY a.name`,
      )
      .all(messageId);
  }

  /** Full-text matches in one project, best first unless `recency`; `excerpt` wraps hits in the two markers. */
  search(
    p: Project,
    f: {
      match: string;
      from: string | null;
      threadId: string | null;
      importance: string | null;
      after: number | null;
      before: number | null;
      limit: number;
      offset: number;
      startMarker: string;
      endMarker: string;
      recency: boolean;
    },
  ): Row[] {
    return this.db
      .query<Row, any[]>(
        `SELECT m.id, m.subject, m.importance, m.ack_required, m.created_ts, m.thread_id, m.topic, s.name AS "from",
                m.body_md, m.recipients_json,
                snippet(messages_fts, -1, ?10, ?11, ' … ', 32) AS excerpt
         FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN agents s ON s.id = m.sender_id
         WHERE messages_fts MATCH ?1 AND m.project_id = ?2 AND (?3 IS NULL OR s.name = ?3 COLLATE NOCASE)
           AND (?4 IS NULL OR m.thread_id = ?4 OR CAST(m.id AS TEXT) = ?4) AND (?5 IS NULL OR m.importance IN (SELECT value FROM json_each(?5)))
           AND (?6 IS NULL OR m.created_ts >= ?6) AND (?7 IS NULL OR m.created_ts <= ?7)
         ORDER BY ${f.recency ? "" : "bm25(messages_fts, 4.0, 1.0),"} m.created_ts DESC, m.id DESC
         LIMIT ?8 OFFSET ?9`,
      )
      .all(
        f.match,
        p.id,
        f.from,
        f.threadId,
        f.importance,
        f.after,
        f.before,
        f.limit,
        f.offset,
        f.startMarker,
        f.endMarker,
      );
  }

  activeReservations(projectId: number, now: number) {
    return this.db
      .query<Row, [number, number]>(
        `SELECT f.*, a.name AS agent FROM file_reservations f JOIN agents a ON a.id = f.agent_id
     WHERE f.project_id = ? AND f.released_ts IS NULL AND f.expires_ts > ?`,
      )
      .all(projectId, now);
  }

  reserve(p: Project, who: Agent, a: Args, ttlField = "ttl_seconds") {
    const paths = [...new Set(list(a.paths))];
    if (paths.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", "paths is required", { field: "paths" });
    }
    const now = nowUs(),
      exclusive = a.exclusive ?? true;
    const expires = now + reservationSeconds(a.ttl_seconds, ttlField, 3600) * 1_000_000;
    const active = this.activeReservations(p.id, now);
    const granted = [],
      conflicts = [];
    for (const path of paths) {
      const holders = active.filter(
        (r) =>
          r.agent_id !== who.id && (exclusive || r.exclusive) && overlaps(r.path_pattern, path),
      );
      if (holders.length) {
        conflicts.push({
          path,
          holders: holders.map((r) => ({
            agent: r.agent,
            path_pattern: r.path_pattern,
            exclusive: !!r.exclusive,
            expires_ts: iso(r.expires_ts),
          })),
        });
        continue;
      }
      const own = active.find((r) => r.agent_id === who.id && r.path_pattern === path);
      const row = own
        ? this.db
            .query<Row, any[]>(
              "UPDATE file_reservations SET expires_ts = ?, exclusive = ?, reason = ? WHERE id = ? RETURNING *",
            )
            .get(
              Math.max(own.expires_ts, expires),
              exclusive ? 1 : 0,
              a.reason ?? own.reason,
              own.id,
            )!
        : this.db
            .query<
              Row,
              any[]
            >(`INSERT INTO file_reservations (project_id, agent_id, path_pattern, exclusive, reason, created_ts, expires_ts)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
            .get(p.id, who.id, path, exclusive ? 1 : 0, a.reason ?? "", now, expires)!;
      granted.push({
        id: row.id,
        path_pattern: row.path_pattern,
        exclusive: !!row.exclusive,
        reason: row.reason,
        expires_ts: iso(row.expires_ts),
      });
    }
    return { granted, conflicts };
  }

  ownActive(p: Project, who: Agent, a: Args) {
    const paths = list(a.paths),
      ids = list(a.file_reservation_ids).map(Number);
    return this.activeReservations(p.id, nowUs()).filter(
      (r) =>
        r.agent_id === who.id &&
        (paths.length === 0 || paths.includes(r.path_pattern)) &&
        (ids.length === 0 || ids.includes(r.id)),
    );
  }

  setExpiry(reservationId: number, expiresTs: number): void {
    this.db.run("UPDATE file_reservations SET expires_ts = ? WHERE id = ?", [
      expiresTs,
      reservationId,
    ]);
  }

  release(reservationId: number, now: number): void {
    this.db.run("UPDATE file_reservations SET released_ts = ? WHERE id = ?", [now, reservationId]);
  }

  thread(p: Project, threadId: string) {
    return this.db
      .query<Row, [number, string, string]>(
        `SELECT m.*, s.name AS sender FROM messages m JOIN agents s ON s.id = m.sender_id
     WHERE m.project_id = ? AND (m.thread_id = ? OR CAST(m.id AS TEXT) = ?) ORDER BY m.created_ts, m.id`,
      )
      .all(p.id, threadId, threadId);
  }
}
