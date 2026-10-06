// Wake delivery: an idle session's hook long-polls GET /wait?session=<host session id> and gets a
// one-line instruction when unread mail arrives for any agent whose roster tag names that session or T3 thread
// (`[t3:… claude:<session id> cwd:…]`, written by the register hook and stored as columns by the store). The hint carries
// no mailbox names, paths, subjects or bodies: hosts show it as hook output and the CLI discovers inboxes.
//
// A message with subject PING_SUBJECT never wakes the model: while the recipient's hook waits, the
// server marks it read and replies PONG_SUBJECT on the same thread, already read so the pong wakes
// no one either. `swarmail ping` uses this to prove a session's wake path is alive.
import { lifecycleEligible, sessionEligible } from "./lifecycle.ts";
import type { Database } from "bun:sqlite";
import { nowUs } from "./db.ts";
import {
  reconcileNotices,
  newestUnread,
  noticeOwners,
  recordNoticeOffer,
  PING_SUBJECT,
} from "./wake-notices.ts";
export { PING_SUBJECT } from "./wake-notices.ts";

export const SESSION_RE = /^[\w:-]+$/;
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

export const INBOX_NOTICE = "Swarmail: Fetch all unread mail with swarmail inbox --session.";

function receivingOwner(db: Database, session: string): string | null {
  const owners = noticeOwners(db, session);
  return owners.length === 1 ? owners[0]! : null;
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
    "UPDATE wake_cursors SET offered = max(coalesce(offered, 0), ?1) WHERE session = ?2",
  );
  const saveNotice = db.query("INSERT INTO wake_notices VALUES (?, ?, ?, ?)");
  return {
    get: (session: string) => cursor.get(session),
    offer(eventId: number, session: string, owner: string) {
      saveNotice.run(owner, session, eventId, newestUnread(db, owner) ?? eventId);
      offer.run(eventId, session);
      recordNoticeOffer(db, session, owner, eventId);
    },
    validate(session: string, after?: number) {
      const current = cursor.get(session);
      if (after !== undefined && after > Math.max(current?.announced ?? 0, current?.offered ?? 0)) {
        throw new Error("acknowledgement exceeds offered mail");
      }
    },
    begin(session: string, retry: boolean, after?: number) {
      (retry || after !== undefined ? keep : promote).run(session);
      if (after !== undefined) {
        acknowledge.run(after, session);
      }
    },
  };
}

function mailboxSnapshot(db: Database) {
  const mailboxes = db.query<{ recipient: string; project: string }, [string, string]>(`
    SELECT a.name AS recipient, p.human_key AS project
    FROM agents a
    JOIN projects p ON p.id = a.project_id
    JOIN message_recipients r ON r.agent_id = a.id
    JOIN messages m ON m.id = r.message_id
    WHERE a.retired_at IS NULL AND ${lifecycleEligible("a")} AND (a.session_id = ?1 OR a.t3_thread = ?1)
      AND r.read_ts IS NULL AND m.subject <> ?2
    GROUP BY a.id
    ORDER BY min(CASE WHEN m.importance IN ('urgent', 'high') THEN 0 ELSE 1 END), p.human_key, a.name
    LIMIT 1001`);

  /** Current unread mailbox identities, including mail already offered. No cursor, ping or receipt writes. */
  return (session: string) => {
    const rows = mailboxes.all(session, PING_SUBJECT);
    if (rows.length > 1000) {
      throw new Error("too many unread mailboxes");
    }
    return { mailboxes: rows };
  };
}

function pendingMail(db: Database, eligible: (session: string) => boolean) {
  // A waiter names its host session or its T3 thread (tag.ts); the identity columns hold both, indexed.
  const tagged = db.query<{ id: number }, [string]>(
    `SELECT id FROM agents WHERE retired_at IS NULL AND ${lifecycleEligible("agents")} AND (session_id = ?1 OR t3_thread = ?1)`,
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
  const pending = db.transaction((session: string): WakeOffer | null => {
    if (!eligible(session)) {
      return null;
    }
    reconcileNotices(db);
    const ids = tagged.all(session).map((a) => a.id);
    if (!ids.length) {
      return null;
    }
    const owner = receivingOwner(db, session);
    if (!owner) {
      return null;
    }
    const current = cursor.get(session)!;
    const rows = withoutPings(unread.all(JSON.stringify(ids), current.announced));
    const notice = db
      .query<{ session: string; event_id: number }, [string]>(
        "SELECT session, event_id FROM wake_notices WHERE owner = ?",
      )
      .get(owner);
    if (notice?.session === session) {
      // Uncertain transport admission must replay the original event, even as its inbox grows.
      return current.announced >= notice.event_id
        ? null
        : { hint: INBOX_NOTICE, eventId: notice.event_id };
    }
    if (notice || !rows.length) {
      return null;
    }
    const eventId = rows.at(-1)!.id;
    cursor.offer(eventId, session, owner);
    return { hint: INBOX_NOTICE, eventId };
  });

  return { cursor, pending };
}

// Sends and registrations call notify(), so a waiter wakes as soon as its mail commits. The poll is only a fallback
// for writes this process does not see, such as another server on the same database.
export function createWaiters(
  db: Database,
  pollMs = 30_000,
  eligible = (session: string) => sessionEligible(db, session),
) {
  const { cursor, pending } = pendingMail(db, eligible);
  const waiting = new Map<string, (value: null | false) => void>();
  const checks = new Map<string, () => void>();
  let scheduled = false;

  /** Resolves with a hint once mail arrives, null on timeout or abort, or false when a newer wait for the same session replaces it. */
  function wait(
    session: string,
    timeoutMs: number,
    signal?: AbortSignal,
    { retry = false, after }: { retry?: boolean; after?: number } = {},
  ): Promise<WakeOffer | null | false> {
    cursor.validate(session, after);
    let started = false;
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
        if (!eligible(session)) {
          return;
        }
        if (!started) {
          cursor.begin(session, retry, after);
          started = true;
        }
        const hint = pending.immediate(session);
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

  return { wait, notify, peek: mailboxSnapshot(db) };
}
