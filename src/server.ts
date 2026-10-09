#!/usr/bin/env bun
// Swarmail server: MCP over streamable HTTP (stateless JSON responses) on 127.0.0.1.
//   bun server.ts                      serve (SWARMAIL_DB, SWARMAIL_PORT, SWARMAIL_SYNCHRONOUS, SWARMAIL_RETIRE_DAYS: 0 keeps idle agents and gone projects); GET /wait is the wake long poll (wake.ts)
import { databasePath, DEFAULT_PORT, homeDir, serverRecordPath, within } from "./paths.ts";
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { processIdentity } from "./proc.ts";
import { nowUs, openDatabase } from "./db.ts";
import { buildSource } from "./build.ts";
import { AGENT_GUIDANCE } from "./guidance.ts";
import { createTools, TOOL_DEFINITIONS, ToolError, WAKES } from "./tools.ts";
import {
  Lifecycle,
  sessionEligible,
  sessionLifecycleBound,
  type LifecycleConfig,
  type Reconciliation,
} from "./lifecycle.ts";
import { createWaiters, SESSION_RE } from "./wake.ts";
import { openRegistry, registryDir } from "./registry.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const definitions = (protocol: string) =>
  protocol === "2025-06-18" || protocol === "2025-11-25"
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.map(({ outputSchema: _output, ...tool }) => tool);
const toolRevisions = new Map(
  PROTOCOL_VERSIONS.map((protocol) => [
    protocol,
    createHash("sha256")
      .update(JSON.stringify(definitions(protocol)))
      .digest("hex"),
  ]),
);

function versionsResponse(req: Request, url: URL): Response {
  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  const protocol = url.searchParams.get("protocolVersion") ?? "2025-11-25";
  if (!PROTOCOL_VERSIONS.includes(protocol)) {
    return new Response("unsupported MCP protocol version", { status: 400 });
  }
  return Response.json({
    server_build: buildSource,
    tools_revision: toolRevisions.get(protocol),
    protocol_version: protocol,
  });
}

const result = (id: unknown, value: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

const toolSuccess = (name: string, value: unknown, structured: boolean) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(structured &&
    TOOL_DEFINITIONS.some((t) => t.name === name && t.outputSchema) && {
      structuredContent: value,
    }),
});

/** Answers one MCP JSON-RPC POST; tools/call goes to callTool. */
async function rpc(
  req: Request,
  callTool: (name: string, args: Record<string, unknown>, structured: boolean) => unknown,
): Promise<Response> {
  const protocol = req.headers.get("MCP-Protocol-Version") ?? "2025-03-26";
  if (!PROTOCOL_VERSIONS.includes(protocol)) {
    return new Response("unsupported MCP protocol version", { status: 400 });
  }
  const structured = protocol === "2025-06-18" || protocol === "2025-11-25";
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
        instructions: AGENT_GUIDANCE,
      });
    }
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, {
        tools: definitions(protocol),
      });
    case "tools/call":
      return result(
        msg.id,
        callTool(String(msg.params?.name), msg.params?.arguments ?? {}, structured),
      );
    default:
      return failure(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function waitResponse(
  req: Request,
  url: URL,
  waiters: ReturnType<typeof createWaiters>,
  eligible: (session: string) => boolean,
) {
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_RE.test(session)) {
    return new Response("invalid session identifier", { status: 400 });
  }
  if (url.pathname === "/wait/peek") {
    try {
      return Response.json(waiters.peek(session));
    } catch {
      return new Response("unread mailbox snapshot unavailable", { status: 503 });
    }
  }
  const rawAfter = url.searchParams.get("after");
  const after = rawAfter === null ? undefined : Number(rawAfter);
  if (rawAfter !== null && (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after))) {
    return new Response("after must be a nonnegative safe integer", { status: 400 });
  }
  const timeout = url.searchParams.get("timeout");
  const seconds = timeout === "0" ? 0 : Math.min(Math.max(Number(timeout) || 600, 1), 86_400);
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
  return offer && eligible(session)
    ? new Response(offer.hint + "\n", { headers: { "x-swarmail-event-id": String(offer.eventId) } })
    : new Response(null, { status: 204 });
}

async function lifecycleResponse(
  req: Request,
  url: URL,
  reconcile: () => Reconciliation,
  eligible: (session: string) => boolean,
): Promise<Response> {
  if (url.pathname === "/lifecycle/reconcile") {
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    if ((await req.text()).trim()) {
      return new Response("reconciliation takes no arguments", { status: 400 });
    }
    return Response.json(reconcile());
  }
  if (url.pathname === "/wait/status") {
    const session = url.searchParams.get("session") ?? "";
    if (!SESSION_RE.test(session)) {
      return new Response("invalid session identifier", { status: 400 });
    }
    return Response.json({ eligible: eligible(session) });
  }
  return new Response("not found", { status: 404 });
}

function initializeLifecycle(db: Database, config?: LifecycleConfig): Lifecycle | undefined {
  if (!config) {
    return undefined;
  }
  try {
    const lifecycle = new Lifecycle(db, config);
    if (lifecycle.reconcile().status !== "ready") {
      throw new Error("unavailable");
    }
    return lifecycle;
  } catch {
    db.close();
    throw new Error("T3 lifecycle initialization unavailable; server activation held");
  }
}

/**
 * A lifecycle change, or a source that is available again, can release held mail, so it rechecks
 * every waiter. An unchanged reconcile does not: each recheck reconciles again, and a client may
 * call /lifecycle/reconcile every few seconds.
 */
function reconcileAndNotify(lifecycle: Lifecycle | undefined, notify: () => void) {
  let ready = true;
  return (): Reconciliation => {
    const state = lifecycle?.reconcile() ?? { status: "ready", changed: 0 };
    const recovered = !ready && state.status === "ready";
    ready = state.status === "ready";
    if (state.changed || recovered) {
      notify();
    }
    return state;
  };
}

export function createServer(
  databasePath: string,
  port: number,
  {
    wakePollMs = 30_000,
    retireIdleDays = 7,
    registry,
    t3Lifecycle,
    mutationsEnabled = false,
  }: {
    wakePollMs?: number;
    retireIdleDays?: number;
    registry?: string;
    t3Lifecycle?: LifecycleConfig;
    mutationsEnabled?: boolean;
  } = {},
) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);
  const lifecycle = initializeLifecycle(db, t3Lifecycle);
  const reconcile = reconcileAndNotify(lifecycle, () => waiters.notify());
  const eligible = (session: string) => {
    const bound = sessionLifecycleBound(db, session);
    return (!bound || reconcile().status === "ready") && sessionEligible(db, session);
  };
  // Sessions end without retiring, so the roster fills with dead names; any tool call as the agent brings it back.
  const sweep = () => {
    if (retireIdleDays > 0) {
      retireIdleAgents(db, retireIdleDays);
      pruneGoneProjects(db);
    }
    pruneIdempotencyKeys(db, 7);
    if (registry) {
      openRegistry(registry).prune();
    }
  };
  sweep();
  setInterval(sweep, 3_600_000).unref();
  const tools = createTools(db, { databasePath, lifecycle, registry, mutationsEnabled });
  const waiters = createWaiters(db, wakePollMs, eligible);

  const callTool = (name: string, args: Record<string, unknown>, structured: boolean) => {
    const fn = Object.hasOwn(tools, name) ? tools[name] : undefined;
    try {
      if (!fn) {
        throw new ToolError("NOT_FOUND", `Unknown tool '${name}'`);
      }
      const value = fn(args);
      const answer = toolSuccess(name, value, structured);
      if (WAKES.has(name)) {
        waiters.notify();
      }
      return answer;
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
      if (path === "/versions") {
        return versionsResponse(req, url);
      }
      if (path === "/lifecycle/reconcile" || path === "/wait/status") {
        return lifecycleResponse(req, url, reconcile, eligible);
      }
      if (path === "/wait" || path === "/wait/peek") {
        server.timeout(req, 0);
        return waitResponse(req, url, waiters, eligible);
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
  { home = homeDir(), exists = existsSync, now = nowUs() } = {},
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
    .filter((p) => !!within(home, p.human_key) && !exists(p.human_key))
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
  const enabled = env("ENABLE_MUTATIONS");
  if (enabled !== undefined && enabled !== "0" && enabled !== "1") {
    throw new Error("SWARMAIL_ENABLE_MUTATIONS must be 0 or 1");
  }
  const database = databasePath();
  const { server } = createServer(database, Number(env("PORT") ?? DEFAULT_PORT), {
    retireIdleDays: Number(env("RETIRE_DAYS") ?? 7),
    mutationsEnabled: enabled === "1",
    registry: registryDir(),
    ...(env("T3_LIFECYCLE") ? { t3Lifecycle: JSON.parse(env("T3_LIFECYCLE")!) } : {}),
  });
  console.log(`swarmail listening on ${server.url} (${database})`);
  if (process.platform === "win32") {
    // Stopping the scheduled task leaves this process running, so scripts/enable-windows.ts stops it by this record.
    const record = serverRecordPath();
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify(processIdentity(process.pid)) + "\n");
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
