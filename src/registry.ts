// The register hook's per-session state: one JSON file per session id, written under a lock file.
import { closeSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostProcess, type HostProcess } from "./proc.ts";

/** Per-session state under ~/.local/state/swarmail-register/<session id>.json. */
export interface RegisterState {
  name: string | null;
  projects: string[];
  tags?: Record<string, string>;
  pending?: { project: string; tag: string };
  host?: HostProcess | null;
  /** When the host reported the session ended (SessionEnd); its next prompt or edit clears it. */
  ended?: string;
}

export const registryDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "swarmail-register");

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
 * Deletes registrations whose session ended more than `days` ago; a session resumed after that
 * registers under a new name.
 */
export function pruneEndedRegistrations(
  dir: string,
  days = REGISTRATION_DAYS,
  now = Date.now(),
): number {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const file of files) {
    const path = join(dir, file);
    // A file is rewritten when its session ends, so one modified within `days` cannot be due. Skipping it unread
    // keeps the startup sweep from costing about 6 MiB of idle memory on a host with a few hundred registrations.
    try {
      if (now - statSync(path).mtimeMs <= days * 86_400_000) {
        continue;
      }
    } catch {
      continue;
    }
    // No waiting: the server runs this, and a held lock means the session is active.
    withLock(
      `${path}.lock`,
      () => {
        try {
          const state = JSON.parse(readFileSync(path, "utf8")) as RegisterState;
          if (state.ended && now - Date.parse(state.ended) > days * 86_400_000) {
            unlinkSync(path);
            pruned++;
          }
        } catch {
          // Gone, or being written; the next sweep looks again.
        }
      },
      { waitMs: 0 },
    );
  }
  return pruned;
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
  const dir = registryDir(env);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return names;
  }
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (state.host?.pid === host.pid && state.host?.start === host.start && state.name) {
        names.add(state.name);
      }
    } catch {
      // A state file mid-write or foreign: not this session's.
    }
  }
  return names;
}
