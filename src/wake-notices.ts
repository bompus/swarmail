// Generic notice ownership follows receiving sessions, independently of transport cursors.
import type { Database } from "bun:sqlite";
import type { Identity } from "./tag.ts";

export const PING_SUBJECT = "swarmail ping";

/** T3 threads retain their identity across provider replacement; standalone IDs include their host. */
export function noticeOwner(
  db: Database,
  agent: Pick<Identity, "host" | "session_id" | "t3_thread">,
): string | null {
  if (agent.t3_thread) {
    return JSON.stringify(["t3", agent.t3_thread]);
  }
  if (!agent.host || !agent.session_id) {
    return null;
  }
  const threads = db
    .query<{ t3_thread: string }, [string, string]>(
      "SELECT DISTINCT t3_thread FROM agents WHERE host = ? AND session_id = ? AND t3_thread IS NOT NULL LIMIT 2",
    )
    .all(agent.host, agent.session_id);
  return threads.length === 1
    ? JSON.stringify(["t3", threads[0]!.t3_thread])
    : JSON.stringify(["native", agent.host, agent.session_id]);
}

export function noticeOwners(db: Database, session: string): string[] {
  const owners = db
    .query<Identity, [string]>(
      "SELECT host, session_id, t3_thread FROM agents WHERE session_id = ?1 OR t3_thread = ?1",
    )
    .all(session)
    .map((agent) => noticeOwner(db, agent))
    .filter((owner): owner is string => owner !== null);
  return [...new Set(owners)];
}

const OWNER_MATCH = `(
  (json_extract(?1, '$[0]') = 't3' AND (a.t3_thread = json_extract(?1, '$[1]') OR
    (a.t3_thread IS NULL AND EXISTS (SELECT 1 FROM agents linked
      WHERE linked.host = a.host AND linked.session_id = a.session_id AND linked.t3_thread = json_extract(?1, '$[1]'))
      AND NOT EXISTS (SELECT 1 FROM agents other
        WHERE other.host = a.host AND other.session_id = a.session_id AND other.t3_thread <> json_extract(?1, '$[1]'))))) OR
  (json_extract(?1, '$[0]') = 'native' AND a.t3_thread IS NULL AND a.host = json_extract(?1, '$[1]')
    AND a.session_id = json_extract(?1, '$[2]'))
)`;

export function newestUnread(
  db: Database,
  owner: string,
  through = Number.MAX_SAFE_INTEGER,
): number | null {
  return db
    .query<{ id: number | null }, [string, string, number]>(`
    SELECT max(m.id) AS id FROM agents a
    JOIN message_recipients r ON r.agent_id = a.id JOIN messages m ON m.id = r.message_id
    WHERE ${OWNER_MATCH} AND r.read_ts IS NULL AND m.subject <> ?2 AND m.id <= ?3
  `)
    .get(owner, PING_SUBJECT, through)!.id;
}

/** Run inside the transaction that reads mail or changes routing. Unknown older-build reads also release covered mail. */
export function reconcileNotices(db: Database): void {
  const clear = db.query("DELETE FROM wake_notices WHERE owner = ?");
  const extend = db.query(
    "UPDATE wake_notices SET covered_through = max(covered_through, ?) WHERE owner = ?",
  );
  const unread = db.query<
    { covered: number | null; latest: number | null },
    [string, string, number, number]
  >(`
    SELECT max(CASE WHEN m.id <= ?3 THEN m.id END) AS covered,
           max(CASE WHEN m.id <= ?4 THEN m.id END) AS latest
    FROM agents a
    JOIN message_recipients r ON r.agent_id = a.id JOIN messages m ON m.id = r.message_id
    WHERE ${OWNER_MATCH} AND r.read_ts IS NULL AND m.subject <> ?2
  `);
  for (const row of db
    .query<{ owner: string; covered_through: number }, []>(
      "SELECT owner, covered_through FROM wake_notices",
    )
    .all()) {
    const { covered, latest } = unread.get(
      row.owner,
      PING_SUBJECT,
      row.covered_through,
      Number.MAX_SAFE_INTEGER,
    )!;
    if (covered === null) {
      clear.run(row.owner);
    } else {
      extend.run(latest, row.owner);
    }
  }
}

/** Preserve a standalone notice when registration adds its T3 identity. */
function rekeyNotice(db: Database, from: string | null, to: string | null): void {
  if (!from || !to || from === to) {
    return;
  }
  db.query(`INSERT INTO wake_notices(owner, session, event_id, covered_through)
    SELECT ?1, session, event_id, covered_through FROM wake_notices WHERE owner = ?2
    ON CONFLICT(owner) DO UPDATE SET covered_through = max(covered_through, excluded.covered_through)
  `).run(to, from);
  db.query("DELETE FROM wake_notices WHERE owner = ?").run(from);
  db.query("UPDATE wake_notice_offers SET owner = ? WHERE owner = ?").run(to, from);
}

/** Retain ownership after a notice drains, so an old cursor cannot be assigned to another receiver. */
export function recordNoticeOffer(
  db: Database,
  session: string,
  owner: string,
  eventId: number,
): void {
  db.query(`INSERT INTO wake_notice_offers VALUES (?, ?, ?)
    ON CONFLICT(session) DO UPDATE SET owner = excluded.owner, event_id = excluded.event_id
  `).run(session, owner, eventId);
}

/** Registration in another repository can identify a previously standalone notice. */
export function linkNotice(db: Database, agent: Identity): void {
  if (agent.host && agent.session_id) {
    rekeyNotice(
      db,
      JSON.stringify(["native", agent.host, agent.session_id]),
      noticeOwner(db, { ...agent, t3_thread: null }),
    );
  }
}

/** Repairs routing that an older binary changed without maintaining notice ownership. */
export function repairNoticeOwners(db: Database): void {
  for (const row of db
    .query<{ host: string; session_id: string }, []>(`
    SELECT json_extract(owner, '$[1]') AS host, json_extract(owner, '$[2]') AS session_id
    FROM (
      SELECT owner FROM wake_notices UNION SELECT owner FROM wake_notice_offers
    ) WHERE json_extract(owner, '$[0]') = 'native'
  `)
    .all()) {
    linkNotice(db, { ...row, t3_thread: null, build: null, cwd: null });
  }
}

/** Recover released cursors only when they still cover unread mail, after identity repair. */
export function backfillOutstandingNotices(db: Database): void {
  const set = db.query("INSERT OR IGNORE INTO wake_notices VALUES (?, ?, ?, ?)");
  for (const row of db
    .query<
      { session: string; event: number; known_owner: string | null; known_event: number | null },
      []
    >(`
    SELECT c.session, max(c.announced, coalesce(c.offered, 0)) AS event,
      known.owner AS known_owner, known.event_id AS known_event
    FROM wake_cursors c LEFT JOIN wake_notice_offers known ON known.session = c.session
    WHERE max(c.announced, coalesce(c.offered, 0)) > 0 ORDER BY event
  `)
    .all()) {
    const owners = noticeOwners(db, row.session);
    if (
      owners.length === 1 &&
      !(row.known_event === row.event && row.known_owner !== owners[0]) &&
      newestUnread(db, owners[0]!, row.event) !== null
    ) {
      set.run(owners[0]!, row.session, row.event, newestUnread(db, owners[0]!));
      recordNoticeOffer(db, row.session, owners[0]!, row.event);
    }
  }
}
