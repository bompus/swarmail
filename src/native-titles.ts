// Display titles from native session metadata. Only registered host/session pairs are returned;
// transcripts are never read. Missing, locked or incompatible stores leave the title unknown.
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./paths.ts";

export interface NativeSession {
  host?: string | null;
  session_id?: string | null;
}

const title = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function modified(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string") {
    return 0;
  }
  // SQLite DATETIME values omit the zone but describe UTC, unlike local-time Date.parse input.
  const utc = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  return Date.parse(utc) || 0;
}

function textFile(path: string): string {
  // These are metadata files, not transcripts. Skip unexpectedly large stores.
  return statSync(path).size <= 16 * 1024 * 1024 ? readFileSync(path, "utf8") : "";
}

function jsonFile(path: string): any {
  try {
    return JSON.parse(textFile(path));
  } catch {
    return null;
  }
}

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** One read-only connection per store; queries select only the requested session's title. */
function databaseTitles(
  path: string,
  ids: Set<string>,
  queries: string[],
): Map<string, { title: string; updated: number }> {
  const result = new Map<string, { title: string; updated: number }>();
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return result;
  }
  try {
    for (const sql of queries) {
      let rows: { id: string; title: unknown; updated?: unknown }[];
      try {
        const query = db.query<{ title: unknown; updated?: unknown }, [string]>(sql);
        rows = [...ids].map((id) => ({ id, title: null, ...query.get(id) }));
      } catch {
        // Another schema generation or a store being replaced; try the next known schema.
        continue;
      }
      for (const row of rows) {
        const value = title(row.title);
        const updated = modified(row.updated);
        if (value && (!result.has(row.id) || updated > (result.get(row.id)?.updated ?? 0))) {
          result.set(row.id, { title: value, updated });
        }
      }
    }
  } finally {
    db.close();
  }
  return result;
}

function codexTitles(base: string, ids: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  try {
    // Codex appends renames; the last usable entry wins, even if timestamps disagree.
    for (const line of textFile(join(base, "session_index.jsonl")).split("\n")) {
      try {
        const row = JSON.parse(line);
        const value = title(row?.thread_name);
        if (ids.has(row?.id) && value) {
          found.set(row.id, value);
        }
      } catch {
        // A partial trailing write does not hide earlier entries.
      }
    }
  } catch {
    // Older installations may have only SQLite metadata.
  }
  const databases = entries(base)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)));
  for (const name of databases) {
    const missing = new Set([...ids].filter((id) => !found.has(id)));
    if (!missing.size) {
      break;
    }
    for (const [id, value] of databaseTitles(join(base, name), missing, [
      "select coalesce(nullif(trim(name), ''), title) as title from threads where id = ?",
      "select title from threads where id = ?",
    ])) {
      found.set(id, value.title);
    }
  }

  return found;
}

function grokTitles(base: string, ids: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  const times = new Map<string, number>();
  // Workspace names may be URL-encoded paths or shortened hashes. Session ids stay exact.
  for (const workspace of entries(base)) {
    for (const id of ids) {
      const row = jsonFile(join(base, workspace, id, "summary.json"));
      if (!row || row.info?.id !== id) {
        continue;
      }
      const value = title(row.generated_title) ?? title(row.session_summary);
      const updated = Math.max(modified(row.updated_at), modified(row.last_active_at));
      if (value && (!found.has(id) || updated > (times.get(id) ?? 0))) {
        found.set(id, value);
        times.set(id, updated);
      }
    }
  }

  return found;
}

/** Current profile's metadata, aligned with the supplied registered sessions. T3 precedence is the caller's. */
export function nativeTitles(
  sessions: NativeSession[],
  env: NodeJS.ProcessEnv = process.env,
): (string | null)[] {
  const home = homeDir(env);
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  const groups = new Map<string, Set<string>>();
  for (const { host, session_id: id } of sessions) {
    if (host && id && /^[\w-]+$/.test(id)) {
      const ids = groups.get(host) ?? new Set<string>();
      ids.add(id);
      groups.set(host, ids);
    }
  }
  const titles = new Map<string, Map<string, string>>();
  for (const [host, ids] of groups) {
    const found = new Map<string, string>();
    const times = new Map<string, number>();
    const fill = (values: Map<string, { title: string; updated: number }>, newer = false) => {
      for (const [id, value] of values) {
        if (!found.has(id) || (newer && value.updated > (times.get(id) ?? 0))) {
          found.set(id, value.title);
          times.set(id, value.updated);
        }
      }
    };
    if (host === "codex") {
      titles.set(host, codexTitles(env.CODEX_HOME || join(home, ".codex"), ids));
      continue;
    } else if (host === "grok") {
      titles.set(host, grokTitles(join(env.GROK_HOME || join(home, ".grok"), "sessions"), ids));
      continue;
    } else if (host === "opencode") {
      fill(
        databaseTitles(join(data, "opencode", "opencode.db"), ids, [
          "select title, time_updated as updated from session where id = ?",
          "select title, time_updated as updated from session_v2 where id = ?",
        ]),
      );
    } else if (host === "devin") {
      const base =
        process.platform === "win32"
          ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Devin")
          : join(data, "devin");
      for (const harness of ["cli-next", "cli"]) {
        fill(
          databaseTitles(join(base, harness, "sessions.db"), ids, [
            "select title, last_activity_at as updated from sessions where id = ?",
          ]),
          true,
        );
      }
    } else if (host === "agy") {
      const base = join(home, ".gemini", "antigravity-cli");
      fill(
        databaseTitles(join(base, "conversation_summaries.db"), ids, [
          "select title, last_modified_time as updated from conversation_summaries where conversation_id = ?",
        ]),
      );
      const cache = jsonFile(join(base, "cache", "conversation_metadata.json"));
      for (const id of ids) {
        const row = cache?.conversations?.[id];
        if (row?.summary?.ID && row.summary.ID !== id) {
          continue;
        }
        const value = title(row?.summary?.Title);
        const updated = Math.max(
          modified(row?.summary?.UpdatedAt),
          modified(row?.last_modified_time),
        );
        if (value && (!found.has(id) || updated > (times.get(id) ?? 0))) {
          found.set(id, value);
        }
      }
    }
    titles.set(host, found);
  }
  return sessions.map(({ host, session_id: id }) =>
    host && id ? (titles.get(host)?.get(id) ?? null) : null,
  );
}
