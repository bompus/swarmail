// T3 Code's state database, `statev2.sqlite`. T3 creates it on its first start by copying its
// older database, then keeps threads in `orchestration_v2_*` tables.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { t3Home } from "./paths.ts";

/** T3's state database under `baseDir`; it may not exist yet. */
export function t3StatePath(baseDir: string): string {
  return join(baseDir, "userdata", "statev2.sqlite");
}

/** Whether `db` has its thread tables yet; while T3 is still creating it, it holds no threads. */
export function t3StateReady(db: Database): boolean {
  return (
    db
      .query(
        "select 1 from sqlite_master where type = 'table' and name = 'orchestration_v2_projection_threads'",
      )
      .get() !== null
  );
}

/**
 * V2's app threads with their current root provider thread. `session` is the provider's own
 * session id, `status` is `running` while that provider thread is loaded (V2 `idle` or `active`),
 * and `last_seen_at` is its last update.
 */
export const T3_V2_THREADS = `
  select t.thread_id, t.title, t.project_id, t.archived_at, t.deleted_at,
         coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) as cwd,
         pt.driver as provider_name,
         json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') as session,
         case when pt.status in ('idle', 'active') then 'running' else pt.status end as status,
         pt.updated_at as last_seen_at,
         json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent' as subagent
  from orchestration_v2_projection_threads t
  left join projection_projects p on p.project_id = t.project_id
  left join orchestration_v2_projection_provider_threads pt
    on pt.provider_thread_id = t.active_provider_thread_id`;

/**
 * The T3 Code thread that runs provider session `sessionId`, or null outside T3. T3 passes no
 * thread id to the provider process, but the provider thread's native reference holds the
 * session id. With `host`, the provider must match too.
 */
export function t3ThreadId(
  sessionId: string,
  dbPath = t3StatePath(t3Home()),
  host?: string,
): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      if (!t3StateReady(db)) {
        return null;
      }
      if (host !== undefined) {
        const driver = host === "claude" ? "claudeAgent" : host === "agy" ? "antigravity" : host;
        const rows = db
          .query<{ thread_id: string }, [string, string]>(
            "SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id IS NOT NULL AND driver = ?1 AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ?2 LIMIT 2",
          )
          .all(driver, sessionId);
        if (rows.length > 1) {
          throw new Error("ambiguous provider session");
        }
        return rows[0]?.thread_id ?? null;
      }
      const row = db
        .query<{ thread_id: string }, [string]>(
          "select thread_id from orchestration_v2_projection_provider_threads where thread_id is not null and json_extract(payload_json, '$.nativeThreadRef.nativeId') = ? order by updated_at desc limit 1",
        )
        .get(sessionId);
      return row?.thread_id ?? null;
    } finally {
      db.close();
    }
  } catch {
    if (host !== undefined) {
      throw new Error("cannot identify one T3 thread for this provider session");
    }
    return null;
  }
}

export interface T3Thread {
  thread_id: string;
  title: string | null;
  cwd: string | null;
  status: string | null;
  last_seen_at: string | null;
}

/** T3's threads by id; none while the database is missing or T3 is still creating it. */
export function t3Threads(dbPath: string): Map<string, T3Thread> {
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
    if (!t3StateReady(db)) {
      return new Map();
    }
    const rows = db
      .query<T3Thread, []>(
        `select thread_id, title, cwd, status, last_seen_at from (${T3_V2_THREADS})
         where deleted_at is null`,
      )
      .all();
    return new Map(rows.map((row) => [row.thread_id, row]));
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}
