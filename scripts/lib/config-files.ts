// Side-effect-free helpers for reading and rewriting user config files.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { renameOver } from "../../src/files.ts";
import { within } from "../../src/paths.ts";
import { isDeepStrictEqual } from "node:util";
import type { Stats } from "node:fs";

export function present(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected an object: " + label);
  }
  return value as Record<string, unknown>;
}

// Reads a config under home, refusing symlinked or non-directory parents and
// non-regular files; a missing file reads as "".
export function readConfig(path: string, home: string): string {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const stat = present(dir);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error("Expected a real directory: " + dir);
    }
    if (within(dir, home) === "" || dirname(dir) === dir) {
      break;
    }
  }
  const stat = present(path);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error("Expected a regular config: " + path);
  }
  return stat ? readFileSync(path, "utf8") : "";
}

/** Backups of one file kept per tag; installers rerun often, so older ones are deleted. */
export const keptBackups = 3;

// Deletes all but the newest `keep` `<path>.<tag>-<ms>` backups.
export function pruneBackups(path: string, backupTag: string, keep = keptBackups): void {
  const prefix = basename(path) + "." + backupTag + "-";
  const stamped = readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const name of stamped.slice(keep)) {
    unlinkSync(join(dirname(path), name));
  }
}

// Backs up an existing file, then replaces it atomically, keeping the newest
// few backups. Returns the backup path, or null when nothing was written or
// there was nothing to back up.
export function writeChanged(
  path: string,
  original: string,
  next: string,
  backupTag: string,
): string | null {
  if (next === original) {
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  const backup = existsSync(path) ? path + "." + backupTag + "-" + Date.now() : null;
  if (backup) {
    copyFileSync(path, backup);
    pruneBackups(path, backupTag);
  }
  const temporary = path + "." + backupTag + "-" + process.pid + ".tmp";
  writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  renameOver(temporary, path);
  return backup;
}

/**
 * Puts `entry` into the `hooks.<event>` list in place of the one `owned` matches, keeping every
 * other hook where it was. Replacing in place keeps list indexes stable, and Codex keys a hook's
 * trust by its index, so moving one would ask the user to trust every hook after it again.
 */
export function withHook(
  config: Record<string, unknown>,
  event: string,
  entry: object,
  owned: RegExp,
): Record<string, unknown> {
  const hooks = config.hooks === undefined ? {} : object(config.hooks, "hooks");
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const next: unknown[] = [];
  let placed = false;
  for (const item of list) {
    if (!owned.test(JSON.stringify(item))) {
      next.push(item);
    } else if (!placed) {
      next.push(entry);
      placed = true;
    }
  }
  return { ...config, hooks: { ...hooks, [event]: placed ? next : [...next, entry] } };
}

/** The planned rewrite of one JSON config: its current text and the text `update` makes of it. */
export function planJson(
  path: string,
  home: string,
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): { path: string; original: string; next: string } {
  const original = readConfig(path, home);
  const config = original.trim() ? object(JSON.parse(original), path) : {};
  const updated = update(config);
  const next =
    original.trim() && isDeepStrictEqual(JSON.parse(original), updated)
      ? original
      : JSON.stringify(updated, null, 2) + "\n";
  return { path, original, next };
}
