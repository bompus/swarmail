// One configured backend, one rotating credential, existing durable bridge per eligible T3 thread.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isT3V2, T3_V2_THREADS, t3StatePath } from "./t3-state.ts";
import {
  checkT3Target,
  BridgeError,
  TargetAuthenticationError,
  localUrl,
  T3_TYPES,
} from "./wake-target.ts";
import type { WakeTarget } from "./wake-target.ts";
import { primaryCheckout } from "./checkout.ts";
import { swarmailUrl } from "./client.ts";
import { processIdentity } from "./proc.ts";
import {
  openRegistry,
  REGISTRATION_DAYS,
  registryDir,
  serverRegister,
  type RegisterState,
} from "./registry.ts";
import { sessionTag } from "./tag.ts";
import { openWakeState } from "./wake-state.ts";
import { bridgeBinding, runBridge } from "./wake-bridge.ts";
import { followT3Backend } from "./wake-t3-backend.ts";
import { pause } from "./wake-loop.ts";
import { SESSION_RE } from "./wake.ts";

/** Runs one read against T3's state database. */
export type T3StateReader = <T>(read: (db: Database) => T) => T;

/** A registration this service enrolled for automatic wake, naming the T3 thread it belongs to. */
type AutoState = RegisterState & { wakeThread?: string };

/**
 * Providers whose T3 V2 threads this service wakes. Claude is left out because Claude in T3
 * already waits on its own session id (the wake mod, or the stop hook without it). A bridge would
 * wait on the same id, and the server keeps one waiter per id, so each would replace the other
 * with a 409. Under T3's Cursor SDK, Cursor's stop hook stops waiting when the turn ends. V1 stays
 * Codex-only.
 */
const WAKE_PROVIDERS = "('codex','cursor')";

// The pinned public projection reports provider availability, not app settlement. Correlated on
// the outer row `v`, so it parses only rows the other filters keep instead of every thread.
const UNSETTLED_V2 = `EXISTS (
  SELECT 1 FROM orchestration_v2_projection_threads s
  WHERE s.thread_id = v.thread_id
    AND json_extract(s.payload_json, '$.settledAt') IS NULL
    AND json_extract(s.payload_json, '$.settledOverride') IS NOT 'settled'
)`;

/** Opens T3's state database for one read. */
function readOnce(baseDir: string): T3StateReader {
  return (read) => {
    const db = new Database(t3StatePath(baseDir), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
}

/**
 * Keeps one read-only connection to T3's state database. The caller closes it when T3 restarts,
 * since T3 can replace the file; a failed read also closes it, and the next read reopens. Single
 * statements hold no read transaction, so T3's checkpoints are not blocked between reads.
 */
export function heldT3State(baseDir: string): T3StateReader & { close(): void; version(): string } {
  let db: Database | undefined;
  let opened = 0;
  const close = () => {
    db?.close();
    db = undefined;
  };
  const reader = <T>(read: (db: Database) => T): T => {
    if (!db) {
      db = new Database(t3StatePath(baseDir), { readonly: true });
      opened++;
    }
    try {
      return read(db);
    } catch (error) {
      close();
      throw error;
    }
  };
  // Changes when another connection commits to T3's database, or when this one reopens.
  const version = () =>
    `${reader((d) => d.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version)}@${opened}`;
  return Object.assign(reader, { close, version });
}

/** Changes whenever a registration is written or removed: the registry renames each write into place. */
function registryVersion(registry: string): string {
  try {
    return String(statSync(registry, { bigint: true }).mtimeNs);
  } catch {
    return "missing";
  }
}

/** A full scan still runs this often, so time-based enrollment windows and missed signals catch up. */
const RESCAN_MS = 60_000;

/**
 * True when T3's threads need scanning again: T3's database or the registry changed since the last
 * true, or RESCAN_MS passed. Inputs are stamped before the scan, so a change during it, including
 * enrollment's own registry writes, makes the next call true.
 */
export function rescanDue(t3State: { version(): string }, registry: string, now = Date.now) {
  let scanned = "";
  let rescanAt = 0;
  return () => {
    const inputs = `${t3State.version()}:${registryVersion(registry)}`;
    if (inputs === scanned && now() < rescanAt) {
      return false;
    }
    scanned = inputs;
    rescanAt = now() + RESCAN_MS;
    return true;
  };
}

/**
 * Where enrollment starts reading T3 runtime rows: the configured start, or the registration
 * retention window if that is later. The server's sweep deletes a registration once its session
 * has been over that long, and with it the `ended` stamp that stops a stale "running" row from
 * enrolling the session again; any such row was last seen before the session ended, so it falls
 * outside the window too.
 */
export function enrollSince(enrollAfter: string, now = Date.now()): string {
  const window = new Date(now - REGISTRATION_DAYS * 86_400_000).toISOString();
  return Date.parse(enrollAfter) > Date.parse(window) ? enrollAfter : window;
}

/** Enroll new/resumed T3 sessions even when a long-running app-server cached older native hooks. */
export function enrollT3Threads(
  registry: string,
  baseDir: string,
  after: string,
  url = swarmailUrl(),
  readT3 = readOnce(baseDir),
): void {
  const states = openRegistry<AutoState>(registry);
  const rows = readT3((db) =>
    db
      .query<
        {
          thread_id: string;
          session: unknown;
          cwd: string;
          last_seen_at: string;
          provider_name: string;
        },
        [string]
      >(
        isT3V2(db)
          ? `
      SELECT thread_id, session, last_seen_at, cwd, provider_name FROM (${T3_V2_THREADS}) v
      WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT coalesce(subagent, 0)
        AND ${UNSETTLED_V2}
        AND cwd IS NOT NULL AND provider_name IN ${WAKE_PROVIDERS} AND status='running'
        AND julianday(last_seen_at) >= julianday(?)
    `
          : `
      SELECT t.thread_id, CASE WHEN json_valid(r.resume_cursor_json)
             THEN json_extract(r.resume_cursor_json,'$.threadId') END AS session, r.last_seen_at,
             coalesce(t.worktree_path,p.workspace_root) AS cwd, 'codex' AS provider_name
      FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id=t.thread_id
      JOIN projection_projects p ON p.project_id=t.project_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.settled_at IS NULL AND t.settled_override IS NOT 'settled'
        AND r.provider_name='codex' AND r.status='running' AND julianday(r.last_seen_at) >= julianday(?)
    `,
      )
      .all(after),
  );
  for (const row of rows) {
    const session = row.session;
    if (
      typeof session !== "string" ||
      !SESSION_RE.test(session) ||
      !SESSION_RE.test(row.thread_id)
    ) {
      continue;
    }
    const known = states.read(session) ?? { name: null, projects: [] };
    const context = {
      host: row.provider_name,
      program: row.provider_name,
      model: null,
      sessionId: session,
      cwd: row.cwd,
    };
    const tag = sessionTag({ ...context, t3: row.thread_id }, row.cwd);
    if (
      known.wakeThread === row.thread_id &&
      !known.ended &&
      known.name &&
      known.projects.some(
        (project) => known.tags?.[project] === tag && known.pending?.project !== project,
      )
    ) {
      continue;
    }
    const project = primaryCheckout(row.cwd);
    if (!project) {
      continue;
    }
    states.settle(session, {
      since: Date.parse(row.last_seen_at),
      project,
      tag,
      register: serverRegister(context, tag, url),
      extra: { wakeThread: row.thread_id },
    });
  }
}

/** Only eligible registrations whose T3 Codex or Cursor thread is neither settled nor archived. */
export function automaticT3Threads(
  registry: string,
  baseDir: string,
  readT3 = readOnce(baseDir),
): Set<string> {
  const states = openRegistry<AutoState>(registry);
  const rows = readT3((db) =>
    db
      .query<{ thread_id: string; session: unknown; provider_name: string }, []>(
        isT3V2(db)
          ? `
      SELECT thread_id, session, provider_name FROM (${T3_V2_THREADS}) v
      WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT coalesce(subagent, 0)
        AND ${UNSETTLED_V2}
        AND provider_name IN ${WAKE_PROVIDERS}
    `
          : `
      SELECT t.thread_id, CASE WHEN json_valid(r.resume_cursor_json)
             THEN json_extract(r.resume_cursor_json,'$.threadId') END AS session,
             'codex' AS provider_name
      FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id=t.thread_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.settled_at IS NULL AND t.settled_override IS NOT 'settled' AND r.provider_name='codex'
    `,
      )
      .all(),
  );
  const threads = new Set<string>();
  // Only the registration named by each thread's provider session can match it.
  for (const row of rows) {
    try {
      const session = row.session;
      if (
        typeof session !== "string" ||
        !SESSION_RE.test(session) ||
        !SESSION_RE.test(row.thread_id)
      ) {
        continue;
      }
      const state = states.read(session);
      if (
        state?.name &&
        !state.ended &&
        state.wakeThread === row.thread_id &&
        state.projects.some(
          (project) =>
            state.tags?.[project]?.startsWith(
              `[t3:${row.thread_id} ${row.provider_name}:${session} `,
            ) && state.pending?.project !== project,
        )
      ) {
        threads.add(row.thread_id);
      }
    } catch {
      // No registration, or a concurrent hook is writing it. Retry on the next scan.
    }
  }
  return threads;
}

export function automaticT3Configuration(path: string) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (
    !T3_TYPES.includes(config.target?.type) ||
    (config.target.delivery !== undefined &&
      (config.target.type !== "t3-v2-queue" || config.target.delivery !== "auto")) ||
    config.rotation?.verifyBackend !== true ||
    typeof config.rotation?.baseDir !== "string" ||
    typeof config.enrollAfter !== "string" ||
    !Number.isFinite(Date.parse(config.enrollAfter))
  ) {
    throw new BridgeError(
      "automatic T3 wake requires an explicit protocol and verified backend rotation",
    );
  }
  config.swarmailUrl = localUrl(config.swarmailUrl);
  if (config.target.url !== undefined) {
    config.target.url = localUrl(config.target.url); // Used only without T3's runtime file.
  }
  return config as {
    swarmailUrl: string;
    target: Omit<WakeTarget, "url"> & { url?: string };
    rotation: { baseDir: string };
    enrollAfter: string;
  };
}

/**
 * Supervisor state binding: where deliveries go. The discovered T3 port, the T3 binary and version
 * (both change on every upgrade) and the credential file are not part of it.
 */
export function automaticBinding(config: ReturnType<typeof automaticT3Configuration>): string {
  const { url, authorizationFile, delivery, ...target } = config.target;
  const { executable, version, ...rotation } = config.rotation as typeof config.rotation & {
    executable?: string;
    version?: string;
  };
  // Spreading keeps the saved key order; stringify drops the undefined enrollAfter.
  return JSON.stringify({ ...config, target, rotation, enrollAfter: undefined });
}

/** One thread's bridge running in the supervisor, with the same mailbox lock and journal as `wake-bridge`. */
interface Bridge {
  stop: AbortController;
  done: Promise<void>;
  close: () => void;
  failure?: BridgeError;
}

async function startBridge(
  config: ReturnType<typeof automaticT3Configuration>,
  url: string,
  id: string,
  signal: AbortSignal,
): Promise<Bridge | null> {
  const target: WakeTarget = {
    type: config.target.type,
    id,
    url,
    authorizationFile: config.target.authorizationFile,
    ...(config.target.delivery === "auto" ? { delivery: "auto" } : {}),
  };
  try {
    await checkT3Target(target);
  } catch (error) {
    if (error instanceof TargetAuthenticationError) {
      throw error;
    }
    if (!(error instanceof BridgeError) || !error.retryable) {
      throw new BridgeError(`thread ${id} preflight failed; reconcile its protocol/configuration`);
    }
    console.error(`swarmail wake-auto-t3: thread ${id} preflight unavailable; retrying`);
    return null;
  }
  if (signal.aborted) {
    return null;
  }
  let state: ReturnType<typeof openWakeState>;
  try {
    state = openWakeState(config.swarmailUrl, id, bridgeBinding(target));
  } catch (error) {
    throw new BridgeError(`thread ${id}: ${(error as Error).message}`);
  }
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      state.close();
    }
  };
  const stop = new AbortController();
  const bridge: Bridge = { stop, close, done: Promise.resolve() };
  const label = `swarmail wake-auto-t3: thread ${id}`;
  bridge.done = runBridge({ swarmailUrl: config.swarmailUrl, target }, state, stop, label)
    .catch((error: unknown) => {
      // Like a standalone bridge, report only messages written for the journal.
      bridge.failure =
        error instanceof BridgeError ? error : new BridgeError("unexpected bridge error");
    })
    .finally(close);
  console.error(`swarmail wake-auto-t3: subscribed ${id}`);
  return bridge;
}

/** Stop polling and retain ownership until the bounded T3 delivery completes. */
async function stopBridge(bridge: Bridge) {
  bridge.stop.abort();
  await bridge.done;
  bridge.close();
}

/** Retain failed threads across backend moves and supervisor restarts until explicit recovery. */
export function automaticFailures(context: Record<string, unknown> | null): Map<string, string> {
  if (context !== null && (typeof context !== "object" || Array.isArray(context))) {
    throw new BridgeError("automatic supervisor failure state is invalid; inspect retained state");
  }
  const value = context?.failures === undefined ? {} : context.failures;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError("automatic supervisor failure state is invalid; inspect retained state");
  }
  const entries = Object.entries(value);
  if (entries.some(([id, reason]) => !id || typeof reason !== "string")) {
    throw new BridgeError("automatic supervisor failure state is invalid; inspect retained state");
  }
  return new Map(entries as [string, string][]);
}

async function quarantineFailed(
  bridges: Map<string, Bridge>,
  quarantine: (id: string, reason: string) => void,
) {
  for (const [id, bridge] of bridges) {
    if (bridge.failure !== undefined) {
      if (bridge.failure instanceof TargetAuthenticationError) {
        throw bridge.failure;
      }
      quarantine(id, bridge.failure.message);
      await stopBridge(bridge);
      bridges.delete(id);
    }
  }
}

/** Stop bridges for threads no longer wanted and start the missing ones. */
async function reconcileBridges(
  bridges: Map<string, Bridge>,
  wanted: Set<string>,
  start: (id: string) => Promise<Bridge | null>,
  failures: Map<string, string>,
  quarantine: (id: string, reason: string) => void,
) {
  await quarantineFailed(bridges, quarantine);
  for (const [id, bridge] of bridges) {
    if (!wanted.has(id)) {
      await stopBridge(bridge);
      // A sibling may fail while this stop awaits an outstanding delivery.
      await quarantineFailed(bridges, quarantine);
      bridges.delete(id);
    }
  }
  for (const id of wanted) {
    if (!bridges.has(id) && !failures.has(id)) {
      try {
        const bridge = await start(id);
        if (bridge) {
          bridges.set(id, bridge);
        }
      } catch (error) {
        if (!(error instanceof BridgeError) || error instanceof TargetAuthenticationError) {
          throw error;
        }
        quarantine(id, error.message);
      }
    }
  }
}

function rememberFailures(bridges: Map<string, Bridge>, failures: Map<string, string>) {
  for (const [id, bridge] of bridges) {
    if (bridge.failure !== undefined && !(bridge.failure instanceof TargetAuthenticationError)) {
      failures.set(id, bridge.failure.message);
    }
  }
}

/** Why a reconcile call failed, without exposing response bodies or error text. */
function holdReason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "no answer within 2 s";
  }
  return error instanceof SyntaxError ? "unexpected response" : "connection failed";
}

function lifecycleReconciliation(swarmailUrl: string, signal: AbortSignal) {
  let heldSince: number | undefined;
  return async () => {
    let reason: string | undefined;
    try {
      const response = await fetch(new URL("/lifecycle/reconcile", swarmailUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (response.ok) {
        const result = await response.json();
        if (typeof result === "object" && result !== null && "status" in result) {
          reason = result.status === "ready" ? undefined : "core reported unavailable";
        } else {
          reason = "unexpected response";
        }
      } else {
        reason = `HTTP ${response.status}`;
      }
    } catch (error) {
      // Unavailable or incompatible cores hold the scan without exposing response bodies.
      reason = holdReason(error);
    }
    if (reason === undefined) {
      if (heldSince !== undefined && !signal.aborted) {
        const seconds = Math.round((Date.now() - heldSince) / 1000);
        console.error(
          `swarmail wake-auto-t3: lifecycle reconciliation ready; scan resumed after ${seconds} s`,
        );
      }
      heldSince = undefined;
      return true;
    }
    if (heldSince === undefined) {
      heldSince = Date.now();
      if (!signal.aborted) {
        console.error(
          `swarmail wake-auto-t3: lifecycle reconciliation unavailable; holding scan (${reason})`,
        );
      }
    }
    return false;
  };
}

/** Enrolls running T3 threads, then returns the threads to wake. */
function scanT3Threads(
  config: ReturnType<typeof automaticT3Configuration>,
  registry: string,
  t3State: T3StateReader,
): Set<string> {
  enrollT3Threads(
    registry,
    config.rotation.baseDir,
    enrollSince(config.enrollAfter),
    config.swarmailUrl + "/mcp/",
    t3State,
  );
  return automaticT3Threads(registry, config.rotation.baseDir, t3State);
}

async function superviseBridges(
  config: ReturnType<typeof automaticT3Configuration>,
  path: string,
  lock: ReturnType<typeof openWakeState>,
  failures: Map<string, string>,
  signal: AbortSignal,
) {
  const bridges = new Map<string, Bridge>();
  const abortBridges = () => {
    for (const bridge of bridges.values()) {
      bridge.stop.abort();
    }
  };
  signal.addEventListener("abort", abortBridges, { once: true });
  const registry = registryDir();
  mkdirSync(registry, { recursive: true });
  const { baseDir } = config.rotation;
  const follow = followT3Backend(path, { baseDir, url: config.target.url }, signal);
  const reconcile = lifecycleReconciliation(config.swarmailUrl, signal);
  const t3State = heldT3State(config.rotation.baseDir);
  try {
    let status = "";
    let heartbeat = 0;
    const owner = processIdentity(process.pid);
    if (!owner) {
      throw new BridgeError("automatic supervisor process identity unavailable");
    }
    const saveStatus = () => {
      const subscriptions = Object.fromEntries(
        [...bridges]
          .filter(([, bridge]) => bridge.failure === undefined)
          .map(([id]) => [id, owner]),
      );
      lock.saveContext({
        running: true,
        owner,
        subscriptions,
        failures: Object.fromEntries(failures),
        updatedAt: Date.now(),
      });
      return JSON.stringify(subscriptions);
    };
    const quarantine = (id: string, reason: string) => {
      failures.set(id, reason);
      saveStatus(); // A failed write remains a global error; never lose the recovery boundary.
      console.error(
        `swarmail wake-auto-t3: bridge ${id} quarantined: ${reason}; inspect its retained journal before retry`,
      );
    };
    let wanted = new Set<string>();
    const due = rescanDue(t3State, registry);
    while (!signal.aborted) {
      await quarantineFailed(bridges, quarantine);
      // Reconcile before backend discovery: app closure still matters while T3 restarts.
      const backend = (await reconcile()) ? await follow() : undefined;
      if (!backend) {
        await pause(2000, signal);
        continue;
      }
      if (backend.moved) {
        // Bridges keep the URL they started with; restart them on the new port.
        await Promise.all([...bridges.values()].map(stopBridge));
        await quarantineFailed(bridges, quarantine);
        bridges.clear();
      }
      if (backend.restarted) {
        t3State.close(); // T3 restarted; read its database afresh.
      }
      if (due()) {
        wanted = scanT3Threads(config, registry, t3State);
      }
      await reconcileBridges(
        bridges,
        wanted,
        (id) =>
          signal.aborted ? Promise.resolve(null) : startBridge(config, backend.url, id, signal),
        failures,
        quarantine,
      );
      // Bridges run in this process, so each subscription names the supervisor.
      const subscriptions = Object.fromEntries(
        [...bridges]
          .filter(([, bridge]) => bridge.failure === undefined)
          .map(([id]) => [id, owner]),
      );
      const nextStatus = JSON.stringify(subscriptions);
      if (nextStatus !== status || Date.now() >= heartbeat) {
        saveStatus();
        status = nextStatus;
        heartbeat = Date.now() + 60_000;
      }
      await pause(2000, signal);
    }
  } finally {
    await Promise.all([...bridges.values()].map(stopBridge));
    rememberFailures(bridges, failures);
    signal.removeEventListener("abort", abortBridges);
    t3State.close();
  }
}

export async function wakeAutoT3(args: string[]): Promise<number> {
  const retryThread = args.length === 3 && args[1] === "--retry-thread" ? args[2] : undefined;
  if (
    args.length !== 1 &&
    !(args.length === 2 && args[1] === "--check") &&
    !(retryThread && SESSION_RE.test(retryThread))
  ) {
    console.error("usage: swarmail wake-auto-t3 <config.json> [--check | --retry-thread <id>]");
    return 64;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let lock: ReturnType<typeof openWakeState> | undefined;
  let failures = new Map<string, string>();
  let failuresLoaded = false;
  try {
    const path = resolve(args[0]!);
    const config = automaticT3Configuration(path);
    if (args[1] === "--check") {
      return 0;
    }
    // Singleton supervisor; each bridge keeps its own mailbox lock and journal.
    lock = openWakeState(
      config.swarmailUrl,
      "t3-auto",
      automaticBinding(config),
      "swarmail-auto-t3",
    );
    failures = automaticFailures(lock.readContext());
    failuresLoaded = true;
    if (retryThread) {
      failures.delete(retryThread);
      return 0;
    }
    await superviseBridges(config, path, lock, failures, abort.signal);
    return 0;
  } catch (error) {
    if (
      abort.signal.aborted &&
      error instanceof BridgeError &&
      error.message === "T3 backend check cancelled"
    ) {
      return 0;
    }
    console.error(
      `swarmail wake-auto-t3: ${error instanceof BridgeError ? error.message : "configuration or local registry unavailable"}`,
    );
    return 1;
  } finally {
    if (lock) {
      try {
        if (failuresLoaded) {
          lock.saveContext({
            running: false,
            subscriptions: {},
            failures: Object.fromEntries(failures),
            updatedAt: Date.now(),
          });
        }
      } finally {
        lock.close();
      }
    }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
