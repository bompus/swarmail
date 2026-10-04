// Session registration: the register hook's per-session state, one JSON file per session id written
// under a lock file, and the server calls that register a session. The hook and the T3 supervisor
// register through `openRegistry`; `who`, the guard and the wake hook only read.
import { renameOver } from "./files.ts";
import { stateHome } from "./paths.ts";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { callTool, swarmailUrl } from "./client.ts";
import { hostProcess, type HostProcess } from "./proc.ts";
import { leadingTag, parseTag, sameSessionRow, withoutTag, type Tag } from "./tag.ts";

/** Per-session state under ~/.local/state/swarmail-register/<session id>.json. */
export interface RegisterState {
  name: string | null;
  projects: string[];
  tags?: Record<string, string>;
  worktrees?: Record<string, string>;
  pending?: { project: string; tag: string; worktree?: string };
  host?: HostProcess | null;
  /** When the host reported the session ended (SessionEnd); its next prompt or edit clears it. */
  ended?: string;
}

/** The agent session a registration is for. */
export interface Session {
  host: string;
  program: string;
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
}

/** A `list_agents` roster row, as far as registration reads it. */
export interface RosterRow {
  name?: string;
  task_description?: string;
}

/** Registers in `project`, reusing `name` when set; returns the agent name, or null when the server did not answer. */
export type Register = (project: string, name: string | null) => string | null;

export const registryDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(stateHome(env), "swarmail-register");

/** Days a registration outlives its session's end before the server's sweep deletes it. */
export const REGISTRATION_DAYS = 14;

/**
 * Runs `fn` holding an exclusive lock file, so two hooks of one session (parallel first edits, or
 * the hook configured twice) do not both register. Waits up to `waitMs`, then gives up and returns
 * false; a lock older than `staleMs` is left from a killed hook and is taken over.
 */
export function withLock(
  lockPath: string,
  fn: () => void,
  { waitMs = 9000, staleMs = 30000 } = {},
): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
        }
      } catch {
        // Released meanwhile.
      }
      if (Date.now() >= deadline) {
        return false;
      }
      Bun.sleepSync(50);
    }
  }
  try {
    fn();
    return true;
  } finally {
    unlinkSync(lockPath);
  }
}

/**
 * Registers `session` under `project` unless its state already lists it with this `tag`. A changed
 * tag or edit checkout, or state from before they were recorded, registers again under the same
 * name so the roster row carries the current location and tag. Returns the new state, or the old one when nothing changed or the
 * server failed.
 */
export function ensureRegistered<S extends RegisterState>(
  state: S,
  project: string,
  tag: string,
  register: Register,
  worktree?: string,
): S {
  if (
    state.projects.includes(project) &&
    state.tags?.[project] === tag &&
    (worktree === undefined || state.worktrees?.[project] === worktree)
  ) {
    return state;
  }
  const name = register(project, state.name);
  if (!name) {
    return state;
  }
  const projects = state.projects.includes(project) ? state.projects : [...state.projects, project];
  return {
    ...state,
    name,
    projects,
    tags: { ...state.tags, [project]: tag },
    ...(worktree !== undefined && { worktrees: { ...state.worktrees, [project]: worktree } }),
  };
}

/**
 * `ensureRegistered` that remembers a failure: when the server did not answer, the state keeps a
 * `pending` registration so the next prompt retries it, instead of the session staying
 * unregistered until an edit that may never come. Success clears it.
 */
function settleRegistration<S extends RegisterState>(
  state: S,
  project: string,
  tag: string,
  register: Register,
  worktree?: string,
): S {
  // A supervisor without an edit checkout cannot complete a pending location update.
  if (
    worktree === undefined &&
    state.pending?.project === project &&
    state.pending.worktree !== undefined
  ) {
    return state;
  }
  const next = ensureRegistered(state, project, tag, register, worktree);
  if (
    next.projects.includes(project) &&
    next.tags?.[project] === tag &&
    (worktree === undefined || next.worktrees?.[project] === worktree)
  ) {
    const { pending, ...rest } = next;
    return pending?.project === project ? (rest as S) : next;
  }
  return { ...next, pending: { project, tag, ...(worktree !== undefined && { worktree }) } };
}

/**
 * The roster row naming the same session as `tag`, so a session registered by hand keeps its name. Under T3, a row
 * tagged with the same thread counts even with another provider session id: T3 can start a new provider session in a
 * thread, which keeps the thread's name instead of registering a second one. The server matches re-registrations by
 * the same rule (sameSessionRow). Rows come most recently active first.
 */
export function rowForSession(rows: RosterRow[], tag: Tag | null): RosterRow | null {
  return sameSessionRow(rows, tag, (row) =>
    parseTag(leadingTag(String(row.task_description ?? ""))),
  );
}

/**
 * The task text of a roster description without its session tag, so a re-registration keeps what
 * the agent wrote. The hook's own placeholder, current or legacy, counts as no task.
 */
export function keptTask(description: unknown): string {
  const text = withoutTag(description)
    .replace(/^(?:.* session [\w-]+ \()?registered (?:by hook|on first edit)\)?$/, "")
    .trim();
  return text || "registered by hook";
}

/** Registers `session` with the server, keeping the name its roster row or state already has. */
export function serverRegister(
  session: Session,
  tag: string,
  url = swarmailUrl(),
  worktree?: string,
): Register {
  return (project, name) => {
    try {
      let rows: RosterRow[] = [];
      try {
        const listed = callTool("list_agents", { project_key: project, limit: 1000 }, url);
        if (Array.isArray(listed)) {
          rows = listed;
        }
      } catch {
        // No roster read: register with the placeholder task.
      }
      const row = name ? rows.find((r) => r.name === name) : rowForSession(rows, parseTag(tag));
      const reuse = name ?? row?.name;
      return (
        (
          callTool(
            "register_agent",
            {
              project_key: project,
              program: session.program,
              model: session.model || session.host,
              task_description: `${tag} ${keptTask(row?.task_description)}`,
              ...(reuse && { name: reuse }),
              ...(worktree !== undefined && { worktree }),
            },
            url,
          ) as { name?: string }
        ).name ?? null
      );
    } catch {
      return null;
    }
  };
}

export interface Registry<S extends RegisterState = RegisterState> {
  /** The session's state, or null when it has none or the file is unreadable. */
  read(sessionId: string): S | null;
  /** Every readable state, with its session id. */
  all(): Array<S & { sessionId: string }>;
  /**
   * Registers the session in `project` under `tag` while holding its lock, and writes the state
   * with `extra` merged in, clearing `ended` and keeping a `pending` retry on failure. Skipped,
   * returning null, when the session ended at or after `since` (ms): the end arrived while this
   * caller was deciding to register.
   */
  settle(
    sessionId: string,
    opts: {
      since: number;
      project: string;
      tag: string;
      register: Register;
      extra?: Partial<S>;
      worktree?: string;
    },
  ): { before: S; after: S } | null;
  /**
   * A new prompt: clears `ended` after a resume and returns the pending registration to retry.
   * Does nothing when the session ended at or after `since`.
   */
  resume(sessionId: string, since: number): RegisterState["pending"];
  /**
   * SessionEnd: records when the session ended, then releases its file reservations in every
   * project it registered in, so `who` can say it ended and its claims stop blocking peers. The
   * name stays registered: a resumed session keeps its session id, and with it its name.
   */
  end(sessionId: string, release?: (project: string, name: string) => unknown, now?: Date): void;
  /** Deletes registrations whose session ended more than `days` ago; returns how many. */
  prune(days?: number, now?: number): number;
}

const fresh = (): RegisterState => ({ name: null, projects: [] });

/** A state file's contents, or null when it is missing, torn, or not a JSON object. */
function readState<S>(file: string): S | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return Array.isArray(value.projects) ? value : { ...value, projects: [] };
  } catch {
    return null;
  }
}

// Rename over the old file, so a reader that skips the lock sees the old state or the new one.
function writeState(file: string, state: RegisterState): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(state) + "\n");
  renameOver(`${file}.tmp`, file);
}

function stateFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

function pruneEnded(dir: string, days: number, now: number): number {
  let pruned = 0;
  for (const file of stateFiles(dir)) {
    const full = join(dir, file);
    // A file is rewritten when its session ends, so one modified within `days` cannot be due. Skipping it unread
    // keeps the startup sweep from costing about 6 MiB of idle memory on a host with a few hundred registrations.
    try {
      if (now - statSync(full).mtimeMs <= days * 86_400_000) {
        continue;
      }
    } catch {
      continue;
    }
    // No waiting: the server runs this, and a held lock means the session is active.
    withLock(
      `${full}.lock`,
      () => {
        const state = readState<RegisterState>(full);
        if (state?.ended && now - Date.parse(state.ended) > days * 86_400_000) {
          try {
            unlinkSync(full);
            pruned++;
          } catch {
            // Gone meanwhile.
          }
        }
      },
      { waitMs: 0 },
    );
  }
  return pruned;
}

export function openRegistry<S extends RegisterState = RegisterState>(
  dir = registryDir(),
): Registry<S> {
  const path = (sessionId: string) => join(dir, `${sessionId}.json`);
  const current = (file: string) => readState<S>(file) ?? (fresh() as S);
  const locked = (sessionId: string, fn: (file: string) => void) => {
    mkdirSync(dir, { recursive: true });
    const file = path(sessionId);
    return withLock(`${file}.lock`, () => fn(file));
  };
  const endedSince = (state: S, since: number) => !!state.ended && Date.parse(state.ended) >= since;

  return {
    read: (sessionId) => readState<S>(path(sessionId)),

    all: () =>
      stateFiles(dir).flatMap((file) => {
        const state = readState<S>(join(dir, file));
        return state ? [{ ...state, sessionId: file.slice(0, -".json".length) }] : [];
      }),

    settle(sessionId, { since, project, tag, register, extra, worktree }) {
      let result: { before: S; after: S } | null = null;
      locked(sessionId, (file) => {
        const before = current(file);
        if (endedSince(before, since)) {
          return;
        }
        const { ended, ...settled } = settleRegistration(before, project, tag, register, worktree);
        const after = { ...settled, ...extra } as S;
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          writeState(file, after);
        }
        result = { before, after };
      });
      return result;
    },

    resume(sessionId, since) {
      let pending: RegisterState["pending"];
      locked(sessionId, (file) => {
        const state = current(file);
        if (endedSince(state, since)) {
          return;
        }
        pending = state.pending;
        if (state.ended) {
          const { ended, ...rest } = state;
          writeState(file, rest as S);
        }
      });
      return pending;
    },

    end(
      sessionId,
      release = (project, name) =>
        callTool("release_file_reservations", { project_key: project, agent_name: name }),
      now = new Date(),
    ) {
      let state: S | undefined;
      // Serialize the end record with registration; release network calls run after unlocking.
      locked(sessionId, (file) => {
        state = { ...current(file), ended: now.toISOString() };
        writeState(file, state);
      });
      if (!state?.name) {
        return;
      }
      for (const project of state.projects) {
        try {
          release(project, state.name);
        } catch {
          // Server down: the reservations expire on their own.
        }
      }
    },

    prune: (days = REGISTRATION_DAYS, now = Date.now()) => pruneEnded(dir, days, now),
  };
}

/** Names this session registered under: SWARMAIL_AGENT, else the register hook's state for the agent host above this process. */
export function selfNames(env: NodeJS.ProcessEnv = process.env, host = hostProcess()): Set<string> {
  if (env.SWARMAIL_AGENT) {
    return new Set([env.SWARMAIL_AGENT]);
  }
  const names = new Set<string>();
  if (!host) {
    return names;
  }
  for (const state of openRegistry(registryDir(env)).all()) {
    const owner = state.host;
    if (owner?.pid === host.pid && owner.start === host.start && state.name) {
      names.add(state.name);
    }
  }
  return names;
}
