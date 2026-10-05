// T3 Code's state database. Orchestrator V2 copies V1's `state.sqlite` to `statev2.sqlite` on its
// first start, then writes only the copy and keeps threads in `orchestration_v2_*` tables; the
// copied V1 tables stay behind, frozen. V1 keeps writing `state.sqlite`.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { t3Home } from "./paths.ts";

/** V2's database once a V2 server has created it, else V1's. */
export function t3StatePath(baseDir: string): string {
  const v2 = join(baseDir, "userdata", "statev2.sqlite");
  return existsSync(v2) ? v2 : join(baseDir, "userdata", "state.sqlite");
}

/** Whether `db` holds V2's thread tables. */
export function isT3V2(db: Database): boolean {
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
 * as V1's runtime rows reported it, and `last_seen_at` is its last update.
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
 * thread id to the provider process, but V1's resume cursor for the thread and V2's native
 * thread reference hold the session id.
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
      if (host !== undefined) {
        // V1 resume cursors do not establish the native provider. Use the registration tag there.
        if (!isT3V2(db)) {
          return null;
        }
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
      const row = isT3V2(db)
        ? db
            .query<{ thread_id: string }, [string]>(
              "select thread_id from orchestration_v2_projection_provider_threads where thread_id is not null and json_extract(payload_json, '$.nativeThreadRef.nativeId') = ? order by updated_at desc limit 1",
            )
            .get(sessionId)
        : db
            .query<{ thread_id: string }, [string]>(
              "select thread_id from provider_session_runtime where instr(resume_cursor_json, ?) > 0 order by last_seen_at desc limit 1",
            )
            .get(JSON.stringify(sessionId));
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

/** T3's threads by id; none while the database is missing or mid-copy on V2's first start. */
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
