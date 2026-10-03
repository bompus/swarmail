// T3 Code's state database. Orchestrator V2 copies V1's `state.sqlite` to `statev2.sqlite` on its
// first start, then writes only the copy and keeps threads in `orchestration_v2_*` tables; the
// copied V1 tables stay behind, frozen. V1 keeps writing `state.sqlite`.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
