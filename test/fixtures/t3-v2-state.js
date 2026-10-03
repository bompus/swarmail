// T3 Code Orchestrator V2's thread tables, as its migrations leave them (055_OrchestrationV2 plus
// OrchestrationV2/Foundation), for tests of what Swarmail reads from `statev2.sqlite`.

/** Adds V2's thread, provider-thread and project tables to `db`. */
export function createT3V2Tables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT,
      provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL,
      first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT);
  `);
}

/** One app thread whose current root provider thread runs `nativeId` on `driver`. */
export function addT3V2Thread(
  db,
  {
    threadId,
    projectId = "project-1",
    title = threadId,
    worktreePath = null,
    relationshipToParent = null,
    archivedAt = null,
    driver = "codex",
    nativeId,
    status = "idle",
    updatedAt = "2026-10-03T02:00:00.000Z",
  },
) {
  const providerThreadId = `provider-${threadId}`;
  db.query(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,'full-access','default',?,?,?,?,NULL,?,?)",
  ).run(
    threadId,
    projectId,
    title,
    driver,
    providerThreadId,
    updatedAt,
    updatedAt,
    archivedAt,
    JSON.stringify({
      id: threadId,
      worktreePath,
      lineage: { parentThreadId: null, relationshipToParent, rootThreadId: threadId },
    }),
    driver,
  );
  db.query(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,NULL,?,NULL,?,1,1,?,?,?,?)",
  ).run(
    providerThreadId,
    threadId,
    driver,
    status,
    updatedAt,
    JSON.stringify({
      id: providerThreadId,
      driver,
      nativeThreadRef: { driver, nativeId, strength: "strong" },
    }),
    driver,
    driver,
  );
}
