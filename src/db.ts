// Swarmail storage with microsecond timestamps, SQLite WAL and FTS5 search.
import { Database } from "bun:sqlite";

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  human_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_human_key ON projects(human_key);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  program TEXT NOT NULL,
  model TEXT NOT NULL,
  task_description TEXT NOT NULL DEFAULT '',
  inception_ts INTEGER NOT NULL,
  last_active_ts INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_name ON agents(project_id, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  sender_id INTEGER NOT NULL REFERENCES agents(id),
  thread_id TEXT,
  topic TEXT COLLATE NOCASE,
  subject TEXT NOT NULL,
  body_md TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal',
  ack_required INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_ts);
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL DEFAULT 'to',
  read_ts INTEGER,
  ack_ts INTEGER,
  -- The message's created_ts, copied so fetch_inbox reads an inbox newest-first from the index instead of sorting it.
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_message_recipients_inbox ON message_recipients(agent_id, created_ts, message_id);
CREATE TABLE IF NOT EXISTS file_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  path_pattern TEXT NOT NULL,
  exclusive INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL,
  released_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_reservations_active ON file_reservations(project_id, released_ts, expires_ts);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tool TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(tool, agent_id, key)
);
-- Wake delivery (wake.ts): per host session, the newest message id announced in a hint the session has had a
-- turn since (announced), and the newest id in the last hint sent (offered), confirmed by the next wait.
CREATE TABLE IF NOT EXISTS wake_cursors (
  session TEXT PRIMARY KEY,
  announced INTEGER NOT NULL DEFAULT 0,
  offered INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, body_md, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_md) VALUES (NEW.id, NEW.subject, NEW.body_md);
END;
`;

export function openDatabase(
  path: string,
  synchronous = process.env.SWARMAIL_SYNCHRONOUS || "normal",
): Database {
  // normal: WAL syncs at checkpoints, not every commit, so sends take ~0.5 ms instead of ~3 ms (measured 2026-09-28).
  // A hard stop of the OS or VM can lose the last commits; the database itself stays intact. full syncs every commit.
  if (synchronous !== "normal" && synchronous !== "full") {
    throw new Error(`SWARMAIL_SYNCHRONOUS must be normal or full, not ${synchronous}`);
  }
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`PRAGMA synchronous = ${synchronous.toUpperCase()}`);
  db.run("PRAGMA foreign_keys = ON");
  db.exec(schema);
  // Keep durable retries in the current message format without changing their keys or fingerprints.
  db.run(`UPDATE idempotency_keys
    SET result = json_remove(
      CASE WHEN tool = 'send_message' AND json_type(result, '$.deliveries') = 'array'
        THEN json_extract(result, '$.deliveries[0].payload') ELSE result END,
      '$.deliveries', '$.count', '$.attachments')
    WHERE tool IN ('send_message', 'reply_message') AND
      (json_type(result, '$.deliveries') IS NOT NULL OR json_type(result, '$.attachments') IS NOT NULL)`);
  return db;
}

let lastUs = 0;
/** Microseconds since the epoch, wall-clock, strictly increasing within the process. */
export function nowUs(): number {
  lastUs = Math.max(Date.now() * 1000, lastUs + 1);
  return lastUs;
}

/** Formats stored microseconds as UTC: `2026-09-28T02:38:34.788002Z`. */
export function iso(us: number | null | undefined): string | null {
  if (us == null) {
    return null;
  }
  const s = Math.floor(us / 1_000_000);
  return (
    new Date(s * 1000).toISOString().slice(0, 19) +
    "." +
    String(us % 1_000_000).padStart(6, "0") +
    "Z"
  );
}

export class InvalidTimestamp extends Error {}

export function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new InvalidTimestamp(`not an ISO-8601 timestamp: ${value}`);
  }
  const frac = /\.(\d+)/.exec(value)?.[1] ?? "";
  return Math.floor(ms / 1000) * 1_000_000 + Number((frac + "000000").slice(0, 6));
}
