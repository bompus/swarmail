// Swarmail's default locations, each overridden by its environment variable. Two places spell the state home
// themselves because they cannot import this module: claude-wake-mod.js runs inside Claude Code's plugin runtime, and
// scripts/configure-hooks.ts writes a shell hook command.
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 18765;

/** The server's database: SWARMAIL_DB, else ~/.local/share/swarmail/mail.sqlite3. */
export const databasePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_DB || join(homedir(), ".local", "share", "swarmail", "mail.sqlite3");

/** Where hooks keep per-session state: XDG_STATE_HOME, else ~/.local/state. */
export const stateHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.XDG_STATE_HOME || join(homedir(), ".local", "state");

/** Swarmail's MCP endpoint. Hooks run without the shell profile, so the default is the local server. */
export const swarmailUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_URL || `http://127.0.0.1:${DEFAULT_PORT}/mcp/`;

/** The base URL wake hooks long-poll for /wait. */
export const wakeUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SWARMAIL_WAKE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
