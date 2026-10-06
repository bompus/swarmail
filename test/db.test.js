import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";

test("opening waits for another process that holds the database instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-db-"));
  const path = join(dir, "mail.sqlite3");
  try {
    new Database(path, { create: true }).close();
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(process.argv[1]);
         db.run("BEGIN EXCLUSIVE");
         console.log("locked");
         Bun.sleepSync(300);
         db.run("COMMIT");`,
        path,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    const db = openDatabase(path);
    expect(db.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    db.close();
    expect(await holder.exited).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(db.query("PRAGMA user_version").get().user_version).toBe(5);
    expect(
      db.query("SELECT host, session_id, t3_thread, build, cwd FROM agents ORDER BY id").all(),
    ).toEqual([
      { host: "claude", session_id: "s-1", t3_thread: "th-1", build: "abc", cwd: "~/w x" },
      { host: null, session_id: null, t3_thread: null, build: null, cwd: null },
      { host: null, session_id: null, t3_thread: null, build: null, cwd: null },
    ]);
    expect(db.query("SELECT worktree FROM agents WHERE id = 1").get().worktree).toBeNull();
    expect(db.query("SELECT sender_location FROM messages").all()).toEqual([]);
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
      UPDATE agents SET worktree = '/w/edit', task_description = '[claude:s-2 cwd:~/w] moved' WHERE id = 1;
      INSERT INTO agents (id, project_id, name, program, model, task_description, inception_ts, last_active_ts)
        VALUES (4, 1, 'JadeOwl', 'cursor', 'm', '[t3:th-4 cursor:c-4] new', 1, 1);
    `);
    db.close();
    db = openDatabase(path);
    expect(db.query("PRAGMA user_version").get().user_version).toBe(5);
    expect(db.query("SELECT worktree FROM agents WHERE id = 1").get().worktree).toBe("/w/edit");
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

test("migrating a released database preserves messages without inventing sender history", () => {
  const dir = mkdtempSync(join(tmpdir(), "db-location-"));
  const path = join(dir, "mail.sqlite3");
  try {
    let db = openDatabase(path);
    db.exec(`ALTER TABLE agents DROP COLUMN worktree;
      ALTER TABLE messages DROP COLUMN sender_location;
      DROP TABLE wake_notices;
      DROP TABLE wake_notice_offers;
      DROP TABLE lifecycle_sources;
      DROP TABLE session_lifecycle;
      ALTER TABLE agents DROP COLUMN lifecycle_profile;
      ALTER TABLE agents DROP COLUMN lifecycle_thread;
      ALTER TABLE message_recipients DROP COLUMN admission_json;
      PRAGMA user_version = 1;
      INSERT INTO wake_cursors(session, announced, offered) VALUES('previous-session',10,12);
      INSERT INTO projects VALUES (1,'repo','/r',1);
      INSERT INTO agents (id,project_id,name,program,model,inception_ts,last_active_ts) VALUES(1,1,'BlueLake','claude','m',1,1);
      INSERT INTO messages (id,project_id,sender_id,subject,body_md,created_ts) VALUES(1,1,1,'old','hello',1);`);
    db.close();
    for (let round = 0; round < 2; round++) {
      db = openDatabase(path);
      expect(db.query("SELECT id,subject,body_md,sender_location FROM messages").all()).toEqual([
        { id: 1, subject: "old", body_md: "hello", sender_location: null },
      ]);
      expect(db.query("SELECT worktree FROM agents").get().worktree).toBeNull();
      expect(db.query("SELECT * FROM wake_cursors WHERE session='previous-session'").get()).toEqual(
        { session: "previous-session", announced: 10, offered: 12 },
      );
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
