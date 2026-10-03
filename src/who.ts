#!/usr/bin/env bun
// Which Swarmail name is which session, for "coordinate with the other session on repo X".
// The roster alone cannot say: rows registered before the session tag carry no thread or worktree.
// This joins the roster with the register hook's per-session state (whose host process shows whether
// the session is still running) and, when T3 Code runs the session, its thread table; live sessions
// first. Read-only.
//
// Usage: swarmail who [repository path or bare name] [--all] [--json]
// A bare name (no slash) that is not a path resolves to the one registered project whose folder has
// that name; none or several is an error listing the candidates.
// Without --all, rows with no live host process or running T3 Code thread and no activity in the last day are left out.
// Names this session registered under (selfNames in registry.ts) are marked "(you)", and `self` in --json.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildSource } from "./build.ts";
import { iso } from "./db.ts";
import { primaryCheckout } from "./checkout.ts";
import { callTool } from "./client.ts";
import { hostAlive } from "./proc.ts";
import { t3ThreadId } from "./register-hook.ts";
import { registryDir, selfNames, type RegisterState } from "./registry.ts";
import { isT3V2, T3_V2_THREADS, t3StatePath } from "./t3-state.ts";
import { parseTag, withoutTag } from "./tag.ts";

/** A roster row from `list_agents`. */
export interface RosterAgent {
  name: string;
  task_description?: string;
  last_active_ts?: string;
}

interface T3Thread {
  thread_id: string;
  title: string | null;
  cwd: string | null;
  status: string | null;
  last_seen_at: string | null;
}

interface LiveRoom {
  heartbeatAt: string;
  agentName?: string;
  hostSessionId?: string;
  t3Thread?: string;
}

interface Queue {
  unread: number;
  oldest: string | null;
}

export interface WhoRow {
  name: string | null;
  sessionId: string | null;
  t3: string | null;
  title: string | null;
  status: string | null;
  seen: string | null;
  cwd: string | null;
  build: string | null;
  lastActive: string | null;
  hostAlive: boolean | null;
  /** When the session's host reported it ended (register-hook SessionEnd), else null. */
  ended: string | null;
  roomOwner: boolean;
  task: string;
  sameSessionAs: string[];
  unread: number;
  oldestUnread: string | null;
}

const LIVE_ROOM_FRESH_MS = 5 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

/** The register hook's state for each session (file name = session id). */
export function hookStates(stateDir: string): Array<RegisterState & { sessionId: string }> {
  if (!existsSync(stateDir)) {
    return [];
  }
  return readdirSync(stateDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        return [
          {
            sessionId: file.slice(0, -".json".length),
            ...JSON.parse(readFileSync(join(stateDir, file), "utf8")),
          },
        ];
      } catch {
        return [];
      }
    });
}

/** Registered project keys (primary checkout paths), read from the server's database. */
function projectKeys(dbPath: string): string[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ human_key: string }, []>("select human_key from projects")
      .all()
      .map((row) => row.human_key);
  } finally {
    db.close();
  }
}

/** Unread mail per agent in a project: how many messages, and when the oldest arrived. */
export function unreadQueues(dbPath: string, project: string): Map<string, Queue> {
  if (!existsSync(dbPath)) {
    return new Map();
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Map(
      db
        .query<{ name: string; unread: number; oldest: number }, [string]>(
          `SELECT a.name, count(*) AS unread, min(r.created_ts) AS oldest
           FROM message_recipients r JOIN agents a ON a.id = r.agent_id JOIN projects p ON p.id = a.project_id
           WHERE p.human_key = ? AND r.read_ts IS NULL GROUP BY a.id`,
        )
        .all(project)
        .map((row) => [row.name, { unread: row.unread, oldest: iso(row.oldest) }]),
    );
  } finally {
    db.close();
  }
}

/** The primary checkout for a path, or for a bare name the one project key with that basename. */
export function resolveProject(target: string, keys: string[], checkout = primaryCheckout): string {
  const project = checkout(target);
  if (project) {
    return project;
  }
  if (target.includes("/")) {
    throw new Error(`${target} is not inside a git repository`);
  }
  const matches = keys.filter((key) => basename(key).toLowerCase() === target.toLowerCase());
  const [only] = matches;
  if (only && matches.length === 1) {
    return only;
  }
  const candidates = matches.length ? matches : keys.map((key) => basename(key));
  throw new Error(
    `${target} ${matches.length ? "matches several projects" : "matches no project"}; candidates: ${[...new Set(candidates)].sort().join(", ") || "none"}`,
  );
}

/** T3's threads by id; none while the database is missing or mid-copy on V2's first start. */
function t3Threads(dbPath: string): Map<string, T3Thread> {
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return new Map();
  }
  try {
    const rows = db
      .query<T3Thread, []>(
        isT3V2(db)
          ? `
      select thread_id, title, cwd, status, last_seen_at from (${T3_V2_THREADS})
      where deleted_at is null`
          : `
      select t.thread_id, t.title, coalesce(t.worktree_path, p.workspace_root) as cwd,
             r.status, r.last_seen_at
      from projection_threads t
      left join projection_projects p on p.project_id = t.project_id
      left join provider_session_runtime r on r.thread_id = t.thread_id
      where t.deleted_at is null`,
      )
      .all();
    return new Map(rows.map((row) => [row.thread_id, row]));
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

function liveRoom(path: string): LiveRoom | null {
  try {
    const room = JSON.parse(readFileSync(path, "utf8")) as LiveRoom;
    return Date.now() - Date.parse(room.heartbeatAt) < LIVE_ROOM_FRESH_MS ? room : null;
  } catch {
    return null;
  }
}

function ago(iso: string | null, now: number): string {
  if (!iso) {
    return "—";
  }
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 48 * 60) {
    return `${Math.round(minutes / 60)}h ago`;
  }
  return `${Math.round(minutes / 1440)}d ago`;
}

/**
 * One row per roster agent plus one per running T3 thread in this repository with no agent,
 * running sessions first, then by last activity.
 */
export function whoRows(
  {
    project,
    roster,
    stateDir,
    threads,
    room,
    queues = new Map(),
    checkout = primaryCheckout,
  }: {
    project: string;
    roster: RosterAgent[];
    stateDir: string;
    threads: Map<string, T3Thread>;
    room: LiveRoom | null;
    queues?: Map<string, Queue>;
    checkout?: (dir: string) => string | null;
  },
  threadOf = t3ThreadId,
  alive = hostAlive,
): WhoRow[] {
  const states = hookStates(stateDir);
  const rows = roster.map((agent): WhoRow => {
    const tag = parseTag(agent.task_description);
    const sessionId =
      tag?.sessionId ??
      states.find((st) => st.name === agent.name && st.projects.includes(project))?.sessionId ??
      null;
    const state = states.find((st) => st.sessionId === sessionId);
    const t3 = tag?.t3 ?? (sessionId ? threadOf(sessionId) : null);
    const thread = t3 ? threads.get(t3) : null;
    const roomOwner =
      !!room &&
      [agent.name, sessionId, t3].some(
        (id) => id && [room.agentName, room.hostSessionId, room.t3Thread].includes(id),
      );
    return {
      name: agent.name,
      sessionId,
      t3,
      title: thread?.title ?? null,
      status: thread?.status ?? null,
      seen: thread?.last_seen_at ?? null,
      cwd: thread?.cwd ?? tag?.cwd ?? null,
      build: tag?.build ?? null,
      lastActive: agent.last_active_ts ?? null,
      hostAlive: state?.host ? alive(state.host) : null,
      ended: state?.ended ?? null,
      roomOwner,
      task: withoutTag(agent.task_description),
      sameSessionAs: [],
      unread: queues.get(agent.name)?.unread ?? 0,
      oldestUnread: queues.get(agent.name)?.oldest ?? null,
    };
  });
  for (const row of rows) {
    const twins = rows.filter(
      (other) => other !== row && other.sessionId && other.sessionId === row.sessionId,
    );
    row.sameSessionAs = twins.flatMap((other) => (other.name ? [other.name] : []));
  }
  const claimed = new Set(rows.map((row) => row.t3).filter(Boolean));
  for (const thread of threads.values()) {
    if (thread.status !== "running" || claimed.has(thread.thread_id) || !thread.cwd) {
      continue;
    }
    if (checkout(thread.cwd) !== project) {
      continue;
    }
    rows.push({
      name: null,
      sessionId: null,
      t3: thread.thread_id,
      title: thread.title,
      status: thread.status,
      seen: thread.last_seen_at,
      cwd: thread.cwd,
      build: null,
      lastActive: null,
      hostAlive: null,
      ended: null,
      roomOwner: false,
      task: "not registered: mail cannot reach it",
      sameSessionAs: [],
      unread: 0,
      oldestUnread: null,
    });
  }
  const rank = (row: WhoRow) => (!row.ended && (row.status === "running" || row.hostAlive) ? 1 : 0);
  return rows.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      String(b.seen ?? b.lastActive ?? "").localeCompare(String(a.seen ?? a.lastActive ?? "")),
  );
}

export function main(args: string[]): void {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const target = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
  const dbPath =
    process.env.SWARMAIL_DB || join(homedir(), ".local", "share", "swarmail", "mail.sqlite3");
  const project = resolveProject(target, projectKeys(dbPath));
  const roster = callTool("list_agents", { project_key: project, limit: 1000 }) as RosterAgent[];
  const home = homedir();
  const now = Date.now();
  const rows = whoRows({
    project,
    roster,
    stateDir: registryDir(),
    threads: t3Threads(t3StatePath(join(home, ".t3"))),
    room: process.env.SWARMAIL_LIVE_ROOM ? liveRoom(process.env.SWARMAIL_LIVE_ROOM) : null,
    queues: unreadQueues(dbPath, project),
  }).filter(
    (row) =>
      all ||
      row.status === "running" ||
      row.hostAlive ||
      (row.lastActive !== null && now - Date.parse(row.lastActive) < RECENT_MS),
  );
  const self = selfNames();
  if (json) {
    const marked = rows.map((row) => ({ ...row, self: row.name !== null && self.has(row.name) }));
    console.log(JSON.stringify(marked, null, 2));
    return;
  }
  console.log(`${basename(project)} (${project}), ${new Date(now).toISOString()}`);
  for (const row of rows) {
    const who =
      row.name === null ? "(unregistered)" : `${row.name}${self.has(row.name) ? " (you)" : ""}`;
    const live =
      [
        row.ended && `session ended ${ago(row.ended, now)}`,
        row.status && `${row.status}, seen ${ago(row.seen, now)}`,
        row.hostAlive !== null && `host process ${row.hostAlive ? "alive" : "gone"}`,
      ]
        .filter(Boolean)
        .join(", ") || "liveness unknown";
    const queue = row.unread
      ? ` · ${row.unread} unread (oldest ${ago(row.oldestUnread, now)})`
      : "";
    const flags = [
      row.roomOwner && "LIVE ROOM OWNER",
      row.sameSessionAs.length && `same session as ${row.sameSessionAs.join(", ")}`,
      buildSource &&
        row.build &&
        row.build !== buildSource &&
        `registered by build ${row.build}, not ${buildSource}`,
    ]
      .filter(Boolean)
      .join("; ");
    console.log(
      `- ${who}: ${row.title ? `"${row.title}"` : "untitled"} (${live}) · last active ${ago(row.lastActive, now)}${queue}` +
        ` · ${row.cwd?.replace(home, "~") ?? "cwd unknown"}${flags ? ` · ${flags}` : ""}\n    ${row.task}`,
    );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
