// Wake delivery: an idle session's hook long-polls GET /wait?session=<host session id> and gets a
// one-line hint when unread mail arrives for any agent whose roster tag names that session or T3 thread
// (`[t3:… claude:<session id> cwd:…]`, written by the register hook and stored as columns by the store). The hint names recipients and
// senders only, never a subject or body: hosts show it to the model as hook output. Recipients with
// urgent or high mail come first, with that count, so the woken session reads those first.
//
// A message with subject PING_SUBJECT never wakes the model: while the recipient's hook waits, the
// server marks it read and replies PONG_SUBJECT on the same thread, already read so the pong wakes
// no one either. `swarmail ping` uses this to prove a session's wake path is alive.
import type { Database } from "bun:sqlite";
import { nowUs } from "./db.ts";

export const SESSION_RE = /^[\w:-]+$/;
export const PING_SUBJECT = "swarmail ping";
export const PONG_SUBJECT = "swarmail pong";

interface WakeOffer {
  hint: string;
  eventId: number;
}

interface Unread {
  id: number;
  sender: string;
  sender_id: number;
  recipient: string;
  recipient_id: number;
  project: string;
  project_id: number;
  subject: string;
  importance: string;
  thread_id: string | null;
}

/**
 * One line naming each recipient's unread count and senders, safe to embed in a JSON string. A Windows project path
 * keeps its separators as forward slashes.
 */
export function hintFor(rows: Unread[]): string {
  const groups = new Map<
    string,
    { recipient: string; project: string; count: number; urgent: number; senders: Set<string> }
  >();
  for (const row of rows) {
    const key = `${row.recipient}\n${row.project}`;
    const group = groups.get(key) ?? {
      recipient: row.recipient,
      project: row.project,
      count: 0,
      urgent: 0,
      senders: new Set(),
    };
    group.count++;
    if (row.importance === "urgent" || row.importance === "high") {
      group.urgent++;
    }
    group.senders.add(row.sender);
    groups.set(key, group);
  }
  const parts = [...groups.values()]
    .sort((a, b) => b.urgent - a.urgent)
    .map(
      (g) =>
        `${g.count} new message${g.count === 1 ? "" : "s"}${g.urgent ? ` (${g.urgent} urgent or high)` : ""}` +
        ` for ${g.recipient} in ${g.project} from ${[...g.senders].join(", ")}`,
    );
  // Hook scripts wrap the hint in JSON without an encoder.
  // oxlint-disable-next-line no-control-regex -- strips control characters on purpose
  const unsafe = /["\\\x00-\x1f\x7f]/g;
  return `Swarmail: ${parts.join("; ")}. Call fetch_inbox to read them.`
    .replaceAll("\\", "/")
    .replace(unsafe, "");
}

/**
 * Answers the pings among unread rows and returns the rest. Each ping is marked read and gets a pong on
 * its thread, stored read so it wakes no one.
 */
function pingAnswerer(db: Database): (rows: Unread[]) => Unread[] {
  const markRead = db.query<unknown, [number, number, number]>(
    "UPDATE message_recipients SET read_ts = ?1 WHERE message_id = ?2 AND agent_id = ?3",
  );
  const pong = db.query<
    { id: number; created_ts: number },
    [number, number, string | null, string, number]
  >(`
    INSERT INTO messages (project_id, sender_id, thread_id, subject, body_md, created_ts, recipients_json)
    VALUES (?1, ?2, ?3, '${PONG_SUBJECT}', 'pong', ?5, json_object('to', json_array(?4), 'cc', json_array(), 'bcc', json_array()))
    RETURNING id, created_ts`);
  const pongTo = db.query<unknown, [number, number, number]>(
    "INSERT INTO message_recipients (message_id, agent_id, created_ts, read_ts) VALUES (?1, ?2, ?3, ?3)",
  );
  const answer = db.transaction((ping: Unread) => {
    const now = nowUs();
    markRead.run(now, ping.id, ping.recipient_id);
    const reply = pong.get(ping.project_id, ping.recipient_id, ping.thread_id, ping.sender, now)!;
    pongTo.run(reply.id, ping.sender_id, reply.created_ts);
  });
  return (rows) =>
    rows.filter((row) => {
      if (row.subject !== PING_SUBJECT) {
        return true;
      }
      answer(row);
      return false;
    });
}

function wakeCursor(db: Database) {
  const cursor = db.query<{ announced: number; offered: number | null }, [string]>(
    "SELECT announced, offered FROM wake_cursors WHERE session = ?",
  );
  const promote = db.query<unknown, [string]>(`
    INSERT INTO wake_cursors (session) VALUES (?1)
    ON CONFLICT (session) DO UPDATE SET announced = max(announced, coalesce(offered, 0)), offered = NULL`);
  const keep = db.query<unknown, [string]>(
    "INSERT OR IGNORE INTO wake_cursors (session) VALUES (?)",
  );
  const acknowledge = db.query<unknown, [number, string]>(
    "UPDATE wake_cursors SET announced = max(announced, ?1) WHERE session = ?2",
  );
  const offer = db.query<unknown, [number, string]>(
    "UPDATE wake_cursors SET offered = ?1 WHERE session = ?2",
  );
  return {
    get: (session: string) => cursor.get(session),
    offer: (eventId: number, session: string) => offer.run(eventId, session),
    begin(session: string, retry: boolean, after?: number) {
      const current = cursor.get(session);
      if (after !== undefined && after > Math.max(current?.announced ?? 0, current?.offered ?? 0)) {
        throw new Error("acknowledgement exceeds offered mail");
      }
      (retry || after !== undefined ? keep : promote).run(session);
      if (after !== undefined) {
        acknowledge.run(after, session);
      }
    },
  };
}

// Sends and registrations call notify(), so a waiter wakes as soon as its mail commits. The poll is only a fallback
// for writes this process does not see, such as another server on the same database.
export function createWaiters(db: Database, pollMs = 30_000) {
  // A waiter names its host session or its T3 thread (tag.ts); the identity columns hold both, indexed.
  const tagged = db.query<{ id: number }, [string]>(
    "SELECT id FROM agents WHERE retired_at IS NULL AND (session_id = ?1 OR t3_thread = ?1)",
  );
  const unread = db.query<Unread, [string, number]>(`
    SELECT m.id, s.name AS sender, s.id AS sender_id, a.name AS recipient, a.id AS recipient_id,
           p.human_key AS project, p.id AS project_id, m.subject, m.importance, m.thread_id
    FROM message_recipients r
    JOIN messages m ON m.id = r.message_id
    JOIN agents s ON s.id = m.sender_id
    JOIN agents a ON a.id = r.agent_id
    JOIN projects p ON p.id = a.project_id
    WHERE r.agent_id IN (SELECT value FROM json_each(?)) AND r.read_ts IS NULL AND m.id > ?
    ORDER BY m.id`);

  const cursor = wakeCursor(db);
  const withoutPings = pingAnswerer(db);
  const waiting = new Map<string, (value: null | false) => void>();
  const checks = new Map<string, () => void>();
  let scheduled = false;

  function pending(session: string): WakeOffer | null {
    const ids = tagged.all(session).map((a) => a.id);
    if (!ids.length) {
      return null;
    }
    const rows = withoutPings(unread.all(JSON.stringify(ids), cursor.get(session)?.announced ?? 0));
    if (!rows.length) {
      return null;
    }
    cursor.offer(rows.at(-1)!.id, session);
    return { hint: hintFor(rows), eventId: rows.at(-1)!.id };
  }

  /** Resolves with a hint once mail arrives, null on timeout or abort, or false when a newer wait for the same session replaces it. */
  function wait(
    session: string,
    timeoutMs: number,
    signal?: AbortSignal,
    { retry = false, after }: { retry?: boolean; after?: number } = {},
  ): Promise<WakeOffer | null | false> {
    cursor.begin(session, retry, after);
    waiting.get(session)?.(false);
    return new Promise((resolve) => {
      const done = (value: WakeOffer | null | false) => {
        clearInterval(timer);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", stop);
        if (waiting.get(session) === done) {
          waiting.delete(session);
          checks.delete(session);
        }
        resolve(value);
      };
      const stop = () => done(null);
      const check = () => {
        const hint = pending(session);
        if (hint) {
          done(hint);
        }
      };
      const timer = setInterval(check, pollMs);
      const timeout = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop);
      waiting.set(session, done);
      checks.set(session, check);
      if (signal?.aborted) {
        stop();
      } else {
        check();
      }
    });
  }

  /** Checks every waiting session once, after the current request's response has gone out. */
  function notify(): void {
    if (scheduled || !checks.size) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      for (const check of [...checks.values()]) {
        check();
      }
    }, 0);
  }

  return { wait, notify };
}
