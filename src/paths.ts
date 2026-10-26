// Swarmail's default locations, each overridden by its environment variable. Two places spell the state home
// themselves because they cannot import this module: claude-wake-mod.js runs inside Claude Code's plugin runtime, and
// scripts/configure-hooks.ts writes a shell hook command. Windows keeps the same layout under the user's profile,
// as Claude Code's own Windows install does with ~/.local/bin.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/** T3 Code's data directory: T3CODE_HOME, resolved the way T3 Code resolves it (a leading `~` is the home), else ~/.t3. */
export function t3Home(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const configured = env.T3CODE_HOME?.trim();
  if (!configured) {
    return join(home, ".t3");
  }
  if (configured === "~") {
    return home;
  }
  const relative = configured.startsWith("~/") || configured.startsWith("~\\");
  return resolve(relative ? join(home, configured.slice(2)) : configured);
}

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

/**
 * The running server's PID and start time, which Windows has no service manager to keep (scripts/enable-windows.ts).
 * It sits under the user profile, not HOME or XDG_STATE_HOME, because the setup shell and the logon task can see
 * different values of those but always the same profile.
 */
export const serverRecordPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.USERPROFILE || homedir(), ".local", "state", "swarmail-server.json");

/** Swarmail's MCP endpoint. Hooks run without the shell profile, so the default is the local server. */
export const swarmailUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_URL || `http://127.0.0.1:${DEFAULT_PORT}/mcp/`;

/** The base URL wake hooks long-poll for /wait. */
export const wakeUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_WAKE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * The bearer token a remote server asks for: the first line of the file SWARMAIL_TOKEN_FILE names, or null when
 * unset. A named file that cannot be read, or holds under 32 characters, throws instead of sending no token.
 */
export function bearerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.SWARMAIL_TOKEN_FILE;
  if (!file) {
    return null;
  }
  const token = readFileSync(file, "utf8").split("\n")[0]!.trim();
  if (token.length < 32) {
    throw new Error(`${file} must start with a token of at least 32 characters`);
  }
  return token;
}

/** Whether `url` names the local listener (127.0.0.1, localhost or [::1]), which asks for no token. */
export const isLoopbackUrl = (url: string): boolean =>
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);

/**
 * The Authorization header for a server at `url`. The local listener asks for no token, so a loopback URL gets none
 * and an unreadable token file cannot break local clients.
 */
export const authHeaders = (
  env: NodeJS.ProcessEnv = process.env,
  url = swarmailUrl(env),
): Record<string, string> => {
  if (isLoopbackUrl(url)) {
    return {};
  }
  const token = bearerToken(env);
  return token ? { authorization: `Bearer ${token}` } : {};
};
