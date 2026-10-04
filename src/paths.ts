// Swarmail's default locations, each overridden by its environment variable. Two places spell the state home
// themselves because they cannot import this module: claude-wake-mod.js runs inside Claude Code's plugin runtime, and
// scripts/configure-hooks.ts writes a shell hook command. Windows keeps the same layout under the user's profile,
// as Claude Code's own Windows install does with ~/.local/bin.
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 18765;

/**
 * The user's home: HOME when set, else the account's home. Bun and Node ignore HOME on Windows; Git for Windows
 * honours it, and so does Swarmail, so a test or a second profile can move it on every platform.
 */
export const homeDir = (env: NodeJS.ProcessEnv = process.env): string => env.HOME || homedir();

/** The swarmail binary that the service, the host hooks and the git guard run. */
export const binaryPath = (
  home: string = homeDir(),
  platform: NodeJS.Platform = process.platform,
): string => join(home, ".local", "bin", platform === "win32" ? "swarmail.exe" : "swarmail");

/** T3 Code's data directory. */
export const t3Home = (env: NodeJS.ProcessEnv = process.env): string => join(homeDir(env), ".t3");

/**
 * The rest of `path` after `base` (empty, or starting with a separator) when `path` is `base` or lies inside it,
 * else null. Windows paths compare without regard to case or slash direction.
 */
export function within(
  base: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const form = (p: string) => (platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p);
  const root = form(base).replace(/[\\/]+$/, "");
  const target = form(path);
  if (target === root) {
    return "";
  }
  return target.startsWith(root + (platform === "win32" ? "\\" : "/"))
    ? path.slice(root.length)
    : null;
}

/** `path` with a leading home written as `~`. */
export const tildePath = (home: string, path: string): string => {
  const rest = within(home, path);
  return rest === null ? path : "~" + rest;
};

/** The server's database: SWARMAIL_DB, else ~/.local/share/swarmail/mail.sqlite3. */
export const databasePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_DB || join(homeDir(env), ".local", "share", "swarmail", "mail.sqlite3");

/** Where hooks keep per-session state: XDG_STATE_HOME, else ~/.local/state. */
export const stateHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.XDG_STATE_HOME || join(homeDir(env), ".local", "state");

/** Swarmail's MCP endpoint. Hooks run without the shell profile, so the default is the local server. */
export const swarmailUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_URL || `http://127.0.0.1:${DEFAULT_PORT}/mcp/`;

/** The base URL wake hooks long-poll for /wait. */
export const wakeUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_WAKE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
