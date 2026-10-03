import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";

test("identity columns are backfilled from each tag, and every open repairs rows an older build wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-db-"));
  const path = join(dir, "mail.sqlite3");
  try {
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, human_key TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, program TEXT NOT NULL, model TEXT NOT NULL, task_description TEXT NOT NULL DEFAULT '',
        inception_ts INTEGER NOT NULL, last_active_ts INTEGER NOT NULL, retired_at INTEGER);
      INSERT INTO projects VALUES (1, 'p', '/p', 1);
      INSERT INTO agents (id, project_id, name, program, model, task_description, inception_ts, last_active_ts) VALUES
        (1, 1, 'GreenCastle', 'claude', 'm', '[t3:th-1 claude:s-1 build:abc cwd:~/w x] review', 1, 1),
        (2, 1, 'TanOwl', 'codex', 'm', '[WIP] fix', 1, 1),
        (3, 1, 'PinkFox', 'codex', 'm', 'plain task', 1, 1);
    `);
    old.close();

    let db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get().user_version).toBe(1);
    expect(
      db.query("SELECT host, session_id, t3_thread, build, cwd FROM agents ORDER BY id").all(),
    ).toEqual([
      { host: "claude", session_id: "s-1", t3_thread: "th-1", build: "abc", cwd: "~/w x" },
      { host: null, session_id: null, t3_thread: null, build: null, cwd: null },
      { host: null, session_id: null, t3_thread: null, build: null, cwd: null },
    ]);
    // The wake lookup reads the indexes instead of scanning every description.
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT id FROM agents WHERE retired_at IS NULL AND (session_id = ?1 OR t3_thread = ?1)",
      )
      .all("s-1")
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_agents_session");
    expect(plan).toContain("idx_agents_t3_thread");
    db.close();

    // A build from before the columns, run after a rollback, writes descriptions and leaves the columns as they were.
    db = new Database(path);
    db.exec(`
      UPDATE agents SET task_description = '[claude:s-2 cwd:~/w] moved' WHERE id = 1;
      INSERT INTO agents (id, project_id, name, program, model, task_description, inception_ts, last_active_ts)
        VALUES (4, 1, 'JadeOwl', 'cursor', 'm', '[t3:th-4 cursor:c-4] new', 1, 1);
    `);
    db.close();
    db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get().user_version).toBe(1);
    expect(
      db
        .query("SELECT id, host, session_id, t3_thread FROM agents WHERE id IN (1, 4) ORDER BY id")
        .all(),
    ).toEqual([
      { id: 1, host: "claude", session_id: "s-2", t3_thread: null },
      { id: 4, host: "cursor", session_id: "c-4", t3_thread: "th-4" },
    ]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
