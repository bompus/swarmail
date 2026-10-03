#!/usr/bin/env bun
// Swarmail server: MCP over streamable HTTP (stateless JSON responses) on 127.0.0.1.
//   bun server.ts                      serve (SWARMAIL_DB, SWARMAIL_PORT, SWARMAIL_SYNCHRONOUS, SWARMAIL_RETIRE_DAYS: 0 keeps idle agents and gone projects); GET /wait is the wake long poll (wake.ts)
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { nowUs, openDatabase } from "./db.ts";
import { buildSource } from "./build.ts";
import { createTools, ToolError } from "./tools.ts";
import { createWaiters, SESSION_RE } from "./wake.ts";
import { pruneEndedRegistrations, registryDir } from "./registry.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Schema = Record<string, unknown>;
const s = (type: string, description?: string): Schema => ({
  type,
  ...(description && { description }),
});
const strings = (description?: string): Schema => ({
  type: "array",
  items: { type: "string" },
  ...(description && { description }),
});
const PROJECT = s("string", "Absolute path of the repository's primary checkout.");
const AGENT = s("string", "Your registered agent name.");
const MESSAGE = s("integer", "Message id.");
const tool = (
  name: string,
  description: string,
  properties: Record<string, Schema>,
  required: string[],
) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
  ...(READ_ONLY.has(name) && { annotations: { readOnlyHint: true } }),
});

// Tools that never write, not even agent activity, so hosts may treat them as safe to run.
const READ_ONLY = new Set([
  "health_check",
  "whois",
  "list_agents",
  "get_message_delivery_receipt",
  "search_messages",
  "summarize_thread",
]);

export const TOOL_DEFINITIONS = [
  tool("health_check", "Report whether the server and its database answer.", {}, []),
  tool(
    "ensure_project",
    "Create the project for a repository path if it does not exist, and return it.",
    { human_key: PROJECT },
    ["human_key"],
  ),
  tool(
    "register_agent",
    "Register or update an agent identity in a project. Omit name to get a generated " +
      "adjective+noun name; re-registering an existing name updates its program, model and task.",
    {
      project_key: PROJECT,
      program: s("string"),
      model: s("string"),
      name: s("string"),
      task_description: s("string"),
    },
    ["project_key", "program", "model"],
  ),
  tool(
    "macro_start_session",
    "Start a session in one call: ensure the project, register the agent, optionally " +
      "reserve paths, and return the latest inbox without marking it read.",
    {
      human_key: PROJECT,
      program: s("string"),
      model: s("string"),
      agent_name: s("string"),
      task_description: s("string"),
      file_reservation_paths: strings(),
      file_reservation_reason: s("string"),
      file_reservation_ttl_seconds: s("integer"),
      inbox_limit: s("integer", "Positive page size; default 10, capped at 1000."),
    },
    ["human_key", "program", "model"],
  ),
  tool("whois", "Return one agent's profile.", { project_key: PROJECT, agent_name: s("string") }, [
    "project_key",
    "agent_name",
  ]),
  tool(
    "list_agents",
    "List a project's agents that are not retired, most recently active first.",
    {
      project_key: PROJECT,
      active_within_days: s("number"),
      limit: s("integer", "Positive page size; default 250, capped at 1000."),
    },
    ["project_key"],
  ),
  tool(
    "retire_agent",
    "Retire an agent so it no longer appears in list_agents.",
    { project_key: PROJECT, agent_name: s("string") },
    ["project_key", "agent_name"],
  ),
  tool(
    "unretire_agent",
    "Bring a retired agent back.",
    { project_key: PROJECT, agent_name: s("string") },
    ["project_key", "agent_name"],
  ),
  tool(
    "send_message",
    "Send a Markdown message to agents in the same project. Unknown recipients fail the whole " +
      "send. Returns the message, including its id. An idempotency_key makes a retry return the first result instead of sending twice.",
    {
      project_key: PROJECT,
      sender_name: AGENT,
      to: strings(),
      cc: strings(),
      bcc: strings(),
      subject: s("string"),
      body_md: s("string"),
      importance: s("string", "low, normal, high or urgent"),
      ack_required: s("boolean"),
      topic: s("string"),
      thread_id: s("string"),
      idempotency_key: s("string"),
    },
    ["project_key", "sender_name", "to", "subject", "body_md"],
  ),
  tool(
    "reply_message",
    "Reply in a message's thread. Defaults: to the original sender, the original's topic, " +
      "importance and ack_required, and a 'Re:' subject. Returns the message with reply_to.",
    {
      project_key: PROJECT,
      message_id: MESSAGE,
      sender_name: AGENT,
      body_md: s("string"),
      to: strings(),
      cc: strings(),
      bcc: strings(),
      subject_prefix: s("string"),
      importance: s("string"),
      ack_required: s("boolean"),
      idempotency_key: s("string"),
    },
    ["project_key", "message_id", "sender_name", "body_md"],
  ),
  tool(
    "fetch_inbox",
    "Return your latest messages, newest first, and mark them read unless mark_read is false.",
    {
      project_key: PROJECT,
      agent_name: AGENT,
      limit: s("integer", "Positive page size; default 20, capped at 1000."),
      unread_only: s("boolean"),
      urgent_only: s("boolean", "Only high and urgent."),
      ack_overdue_only: s(
        "boolean",
        "Only unacknowledged ack_required messages older than 30 minutes.",
      ),
      since_ts: s("string", "ISO-8601; only newer messages."),
      topic: s("string"),
      include_bodies: s("boolean"),
      mark_read: s("boolean"),
    },
    ["project_key", "agent_name"],
  ),
  tool(
    "mark_message_read",
    "Mark one message read for you.",
    { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    ["project_key", "agent_name", "message_id"],
  ),
  tool(
    "acknowledge_message",
    "Acknowledge one message (also marks it read).",
    { project_key: PROJECT, agent_name: AGENT, message_id: MESSAGE },
    ["project_key", "agent_name", "message_id"],
  ),
  tool(
    "get_message_delivery_receipt",
    "Show, per recipient, whether a message was read and acknowledged.",
    { project_key: PROJECT, message_id: MESSAGE },
    ["project_key", "message_id"],
  ),
  tool(
    "search_messages",
    "Full-text search over subjects and bodies in a project, best match first " +
      "(ranking: 'recency' for newest first). Results include an excerpt of up to 512 Unicode " +
      "code points from the best matching subject or body, with >>>matched text<<< markers. " +
      "Pass next_cursor back as cursor for the next page.",
    {
      project_key: PROJECT,
      query: s("string"),
      sender_name: s("string"),
      thread_id: s("string"),
      importance: s("string"),
      since: s("string", "ISO-8601"),
      until: s("string", "ISO-8601"),
      limit: s("integer", "Positive page size; default 20, capped at 1000."),
      cursor: s("string"),
      ranking: s("string"),
      include_body_md: s("boolean"),
    },
    ["project_key", "query"],
  ),
  tool(
    "summarize_thread",
    "Return a thread's participants and messages, oldest first, for you to summarize.",
    {
      project_key: PROJECT,
      thread_id: s("string", "The first message's id, or the thread_id its replies carry."),
      per_thread_limit: s(
        "integer",
        "Newest messages to return; positive page size, default 50, capped at 1000.",
      ),
    },
    ["project_key", "thread_id"],
  ),
  tool(
    "file_reservation_paths",
    "Advisory reservation of paths or globs so other agents know what you are editing. " +
      "Paths another agent holds come back as conflicts, not grants.",
    {
      project_key: PROJECT,
      agent_name: AGENT,
      paths: strings(),
      ttl_seconds: s("integer", "Default 3600."),
      exclusive: s("boolean", "Default true."),
      reason: s("string"),
      idempotency_key: s("string"),
    },
    ["project_key", "agent_name", "paths"],
  ),
  tool(
    "renew_file_reservations",
    "Extend your active reservations, all or those matching paths or ids.",
    {
      project_key: PROJECT,
      agent_name: AGENT,
      extend_seconds: s("integer", "Default 1800."),
      paths: strings(),
      file_reservation_ids: { type: "array", items: { type: "integer" } },
    },
    ["project_key", "agent_name"],
  ),
  tool(
    "release_file_reservations",
    "Release your active reservations, all or those matching paths or ids.",
    {
      project_key: PROJECT,
      agent_name: AGENT,
      paths: strings(),
      file_reservation_ids: { type: "array", items: { type: "integer" } },
    },
    ["project_key", "agent_name"],
  ),
];

// Tools that can give a waiting session unread mail: new messages, or a newly tagged or unretired recipient.
const WAKES = new Set([
  "send_message",
  "reply_message",
  "register_agent",
  "macro_start_session",
  "unretire_agent",
]);

const result = (id: unknown, value: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/** Answers one MCP JSON-RPC POST; tools/call goes to callTool. */
async function rpc(
  req: Request,
  callTool: (name: string, args: Record<string, unknown>) => unknown,
): Promise<Response> {
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return failure(null, -32700, "parse error");
  }
  if (Array.isArray(msg)) {
    return failure(null, -32600, "batches are not supported");
  }
  if (typeof msg !== "object" || msg === null) {
    return failure(null, -32600, "invalid request");
  }
  if (msg.id === undefined) {
    return new Response(null, { status: 202 });
  }
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "swarmail", version: buildSource ?? "source" },
      });
    }
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, { tools: TOOL_DEFINITIONS });
    case "tools/call":
      return result(msg.id, callTool(String(msg.params?.name), msg.params?.arguments ?? {}));
    default:
      return failure(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function waitResponse(req: Request, url: URL, waiters: ReturnType<typeof createWaiters>) {
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_RE.test(session)) {
    return new Response("invalid session identifier", { status: 400 });
  }
  const rawAfter = url.searchParams.get("after");
  const after = rawAfter === null ? undefined : Number(rawAfter);
  if (rawAfter !== null && (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after))) {
    return new Response("after must be a nonnegative safe integer", { status: 400 });
  }
  const seconds = Math.min(Math.max(Number(url.searchParams.get("timeout")) || 600, 1), 86_400);
  let offer;
  try {
    offer = await waiters.wait(session, seconds * 1000, req.signal, {
      retry: url.searchParams.has("retry"),
      after,
    });
  } catch {
    return new Response("acknowledgement exceeds offered mail", { status: 409 });
  }
  if (offer === false) {
    return new Response("replaced by a newer wait\n", { status: 409 });
  }
  return offer
    ? new Response(offer.hint + "\n", { headers: { "x-swarmail-event-id": String(offer.eventId) } })
    : new Response(null, { status: 204 });
}

export function createServer(
  databasePath: string,
  port: number,
  {
    wakePollMs = 30_000,
    retireIdleDays = 7,
    registry,
  }: { wakePollMs?: number; retireIdleDays?: number; registry?: string } = {},
) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);
  // Sessions end without retiring, so the roster fills with dead names; any tool call as the agent brings it back.
  const sweep = () => {
    if (retireIdleDays > 0) {
      retireIdleAgents(db, retireIdleDays);
      pruneGoneProjects(db);
    }
    pruneIdempotencyKeys(db, 7);
    if (registry) {
      pruneEndedRegistrations(registry);
    }
  };
  sweep();
  setInterval(sweep, 3_600_000).unref();
  const tools = createTools(db, { databasePath });
  const waiters = createWaiters(db, wakePollMs);

  const callTool = (name: string, args: Record<string, unknown>) => {
    const fn = Object.hasOwn(tools, name) ? tools[name] : undefined;
    try {
      if (!fn) {
        throw new ToolError("NOT_FOUND", `Unknown tool '${name}'`);
      }
      const text = JSON.stringify(fn(args));
      if (WAKES.has(name)) {
        waiters.notify();
      }
      return { content: [{ type: "text", text }] };
    } catch (e) {
      const err =
        e instanceof ToolError
          ? e
          : new ToolError("INTERNAL", e instanceof Error ? e.message : String(e));
      const error = {
        type: err.type,
        message: err.message,
        recoverable: err.type !== "INTERNAL",
        data: err.data,
      };
      return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/healthz") {
        return Response.json({ status: "alive", source: buildSource });
      }
      // MCP requires Origin validation; only local pages may call, which blocks DNS-rebinding from a browser.
      const origin = req.headers.get("origin");
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
        return new Response("forbidden origin", { status: 403 });
      }
      if (path === "/wait") {
        server.timeout(req, 0);
        return waitResponse(req, url, waiters);
      }
      if (path !== "/mcp" && path !== "/mcp/") {
        return new Response("not found", { status: 404 });
      }
      if (req.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      return rpc(req, callTool);
    },
  });
  return { server, db };
}

/** Retires agents with no activity for `days`; returns how many. */
export function retireIdleAgents(db: Database, days: number, now = nowUs()): number {
  return db.run(
    "UPDATE agents SET retired_at = ? WHERE retired_at IS NULL AND last_active_ts < ?",
    [now, now - days * 86_400_000_000],
  ).changes;
}

/** Forgets idempotency keys older than `days`, so a retry after that sends again. */
export function pruneIdempotencyKeys(db: Database, days: number, now = nowUs()): number {
  return db.run("DELETE FROM idempotency_keys WHERE created_ts < ?", [now - days * 86_400_000_000])
    .changes;
}

/**
 * Deletes projects whose checkout under `home` no longer exists (a removed worktree, a test repo)
 * and that hold nothing worth keeping: no mail sent or received by their agents, no active file
 * reservation and no agent activity for a day. Paths outside `home` are never judged gone, so an
 * unmounted drive does not look deleted. A project that comes back registers again on its next edit.
 */
export function pruneGoneProjects(
  db: Database,
  { home = homedir(), exists = existsSync, now = nowUs() } = {},
): number {
  const dayAgo = now - 86_400_000_000;
  const ids = db
    .query<{ id: number; human_key: string }, [number, number]>(
      `SELECT p.id, p.human_key FROM projects p
       WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.project_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM agents a JOIN messages m ON m.sender_id = a.id WHERE a.project_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM agents a JOIN message_recipients r ON r.agent_id = a.id WHERE a.project_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM file_reservations f
                         WHERE f.project_id = p.id AND f.released_ts IS NULL AND f.expires_ts > ?)
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.project_id = p.id AND a.last_active_ts > ?)`,
    )
    .all(now, dayAgo)
    .filter((p) => p.human_key.startsWith(`${home}/`) && !exists(p.human_key))
    .map((p) => p.id);
  db.transaction(() => {
    for (const id of ids) {
      db.run(
        "DELETE FROM idempotency_keys WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)",
        [id],
      );
      db.run("DELETE FROM file_reservations WHERE project_id = ?", [id]);
      db.run("DELETE FROM agents WHERE project_id = ?", [id]);
      db.run("DELETE FROM projects WHERE id = ?", [id]);
    }
  })();
  return ids.length;
}

/** Starts the Swarmail server. */
export function main(args: string[]): void {
  if (args.length) {
    throw new Error("usage: bun server.ts");
  }
  const env = (name: string) => process.env[`SWARMAIL_${name}`];
  const databasePath = env("DB") ?? join(homedir(), ".local", "share", "swarmail", "mail.sqlite3");
  const { server } = createServer(databasePath, Number(env("PORT") ?? 18765), {
    retireIdleDays: Number(env("RETIRE_DAYS") ?? 7),
    registry: registryDir(),
  });
  console.log(`swarmail listening on ${server.url} (${databasePath})`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
