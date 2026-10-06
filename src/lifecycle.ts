// Authoritative app lifecycle is independent of activity and manual retirement.
import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { noticeOwners } from "./wake-notices.ts";

export interface LifecycleConfig {
  /** Stable local profile name. Changing its database or event table requires explicit rebinding. */
  profile: string;
  databasePath: string;
  eventTable: "orchestration_events" | "orchestration_v2_events";
}

type State = "active" | "settled" | "archived" | "deleted";
type Cursor = { database_path: string; event_table: string; sequence: number; event_id: string };
type Snapshot = { sequence: number; eventId: string; states: Map<string, State> };
export type Reconciliation = { status: "ready" | "unavailable"; changed: number };

/** Legacy registrations stay eligible. Bound identities require a verified active lifecycle. */
export const lifecycleEligible = (alias: string) => `(${alias}.lifecycle_profile IS NULL OR EXISTS (
  SELECT 1 FROM session_lifecycle l WHERE l.profile = ${alias}.lifecycle_profile
    AND l.thread_id = ${alias}.lifecycle_thread AND l.state = 'active'
))`;

function stateOf(row: { archived_at: unknown; deleted_at: unknown; payload_json: string }): State {
  const payload = JSON.parse(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid thread projection");
  }
  for (const value of [row.archived_at, row.deleted_at, payload.settledAt]) {
    if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
      throw new Error("unknown thread lifecycle schema");
    }
  }
  if (![null, "active", "settled"].includes(payload.settledOverride)) {
    throw new Error("unknown settlement override");
  }
  if (row.deleted_at !== null) {
    return "deleted";
  }
  if (row.archived_at !== null) {
    return "archived";
  }
  return payload.settledOverride === "settled" || payload.settledAt !== null ? "settled" : "active";
}

/** Read lifecycle, projection watermark and continuity anchors in one source transaction. */
function readSnapshot(
  config: LifecycleConfig,
  previous: Cursor | null,
  threads: string[],
): Snapshot {
  const source = new Database(config.databasePath, { readonly: true, strict: true });
  try {
    source.run("PRAGMA busy_timeout = 1000");
    return source.transaction(() => {
      const meta = source
        .query<{ schema_version: number; last_sequence: number }, []>(
          "SELECT schema_version, last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'",
        )
        .get();
      if (
        meta?.schema_version !== 2 ||
        !Number.isSafeInteger(meta.last_sequence) ||
        meta.last_sequence < 1
      ) {
        throw new Error("unsupported projection watermark");
      }
      // The configured event table is an allowlisted schema choice, never caller-supplied SQL.
      const anchor = source.query<{ event_id: string }, [number]>(
        `SELECT event_id FROM ${config.eventTable} WHERE sequence = ?`,
      );
      if (
        previous &&
        (meta.last_sequence < previous.sequence ||
          anchor.get(previous.sequence)?.event_id !== previous.event_id)
      ) {
        throw new Error("source history changed");
      }
      const eventId = anchor.get(meta.last_sequence)?.event_id;
      if (typeof eventId !== "string" || !eventId) {
        throw new Error("missing history anchor");
      }
      const states = new Map<string, State>();
      const rows = source
        .query<
          { thread_id: string; archived_at: unknown; deleted_at: unknown; payload_json: string },
          [string]
        >(
          `SELECT thread_id, archived_at, deleted_at, payload_json FROM orchestration_v2_projection_threads
         WHERE thread_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(threads));
      for (const row of rows) {
        states.set(row.thread_id, stateOf(row));
      }
      if (states.size !== threads.length) {
        throw new Error("missing registered thread");
      }
      return { sequence: meta.last_sequence, eventId, states };
    })();
  } finally {
    source.close();
  }
}

/** One configured local T3 V2 profile, shared by tools and wake boundaries. No timers or provider inference. */
export class Lifecycle {
  private readonly db: Database;
  private readonly config: LifecycleConfig;
  constructor(db: Database, config: LifecycleConfig) {
    this.db = db;
    this.config = config;
    if (
      !config.profile ||
      config.profile.length > 200 ||
      !isAbsolute(config.databasePath) ||
      !["orchestration_events", "orchestration_v2_events"].includes(config.eventTable)
    ) {
      throw new Error("invalid local T3 lifecycle configuration");
    }
  }

  reconcile(): Reconciliation {
    // Bind before source access: unverified initial identities must never become deliverable.
    this.db
      .query(
        "UPDATE agents SET lifecycle_profile = ?, lifecycle_thread = t3_thread WHERE t3_thread IS NOT NULL AND lifecycle_profile IS NULL",
      )
      .run(this.config.profile);
    // Existing notice ownership already links exact native IDs to one app thread across projects.
    this.db
      .query(`UPDATE agents AS a SET lifecycle_profile = ?1,
      lifecycle_thread = (SELECT min(linked.lifecycle_thread) FROM agents linked
        WHERE linked.host = a.host AND linked.session_id = a.session_id AND linked.lifecycle_profile = ?1)
      WHERE a.lifecycle_profile IS NULL AND a.t3_thread IS NULL AND a.host IS NOT NULL AND a.session_id IS NOT NULL
        AND (SELECT count(DISTINCT linked.t3_thread) FROM agents linked
          WHERE linked.host = a.host AND linked.session_id = a.session_id AND linked.t3_thread IS NOT NULL) = 1
        AND EXISTS (SELECT 1 FROM agents linked WHERE linked.host = a.host AND linked.session_id = a.session_id
          AND linked.lifecycle_profile = ?1 AND linked.lifecycle_thread IS NOT NULL)`)
      .run(this.config.profile);
    try {
      return this.db
        .transaction((): Reconciliation => {
          if (
            this.db
              .query("SELECT 1 FROM lifecycle_sources WHERE profile <> ? LIMIT 1")
              .get(this.config.profile)
          ) {
            throw new Error("source profile changed");
          }
          const prior = this.db
            .query<Cursor, [string]>(
              "SELECT database_path, event_table, sequence, event_id FROM lifecycle_sources WHERE profile = ?",
            )
            .get(this.config.profile);
          if (
            prior &&
            (prior.database_path !== this.config.databasePath ||
              prior.event_table !== this.config.eventTable)
          ) {
            throw new Error("source binding changed");
          }
          const threads = this.db
            .query<{ t3_thread: string }, [string]>(
              "SELECT DISTINCT lifecycle_thread AS t3_thread FROM agents WHERE lifecycle_profile = ? AND lifecycle_thread IS NOT NULL",
            )
            .all(this.config.profile)
            .map((row) => row.t3_thread);
          const snapshot = readSnapshot(this.config, prior, threads);
          let changed = 0;
          const get = this.db.query<{ state: State; revision: number }, [string, string]>(
            "SELECT state, revision FROM session_lifecycle WHERE profile = ? AND thread_id = ?",
          );
          const set = this.db.query(`INSERT INTO session_lifecycle VALUES (?, ?, ?, ?)
          ON CONFLICT(profile, thread_id) DO UPDATE SET state = excluded.state, revision = excluded.revision`);
          for (const [thread, state] of snapshot.states) {
            const current = get.get(this.config.profile, thread);
            if (current && snapshot.sequence < current.revision) {
              throw new Error("regressed identity revision");
            }
            if (current?.state === state) {
              continue;
            }
            if (
              current &&
              (current.revision === snapshot.sequence || prior?.sequence === snapshot.sequence)
            ) {
              throw new Error("conflicting lifecycle revision");
            }
            set.run(this.config.profile, thread, state, snapshot.sequence);
            changed++;
            // T3 reservations have no activation provenance. Keep them until their existing expiry.
          }
          if (!prior || prior.sequence !== snapshot.sequence) {
            this.db
              .query(`INSERT INTO lifecycle_sources VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(profile) DO UPDATE SET sequence = excluded.sequence, event_id = excluded.event_id`)
              .run(
                this.config.profile,
                this.config.databasePath,
                this.config.eventTable,
                snapshot.sequence,
                snapshot.eventId,
              );
          }
          return { status: "ready", changed };
        })
        .immediate();
    } catch {
      // No source contents, paths or partial observations escape this boundary.
      return { status: "unavailable", changed: 0 };
    }
  }
}

function ownerThread(db: Database, session: string): string | null {
  const owners = noticeOwners(db, session);
  if (owners.length !== 1) {
    return null;
  }
  const owner = JSON.parse(owners[0]!);
  return owner[0] === "t3" ? owner[1] : null;
}

/** Linked native registrations share the app thread's authoritative delivery gate. */
export function sessionLifecycleBound(db: Database, session: string): boolean {
  const thread = ownerThread(db, session);
  return (
    thread !== null &&
    db
      .query(
        "SELECT 1 FROM agents WHERE lifecycle_thread = ? AND lifecycle_profile IS NOT NULL LIMIT 1",
      )
      .get(thread) !== null
  );
}

/** A transport id must resolve only to eligible registrations; ambiguous or unknown ids hold delivery. */
export function sessionEligible(db: Database, session: string): boolean {
  const rows = db
    .query<{ eligible: number }, [string]>(
      `SELECT CASE WHEN retired_at IS NULL AND ${lifecycleEligible("agents")} THEN 1 ELSE 0 END AS eligible
     FROM agents WHERE session_id = ?1 OR t3_thread = ?1`,
    )
    .all(session);
  if (noticeOwners(db, session).length !== 1) {
    return false;
  }
  const thread = ownerThread(db, session);
  const blocked =
    thread !== null &&
    db
      .query(`SELECT 1 FROM agents a WHERE a.lifecycle_thread = ?
    AND a.lifecycle_profile IS NOT NULL AND NOT ${lifecycleEligible("a")} LIMIT 1`)
      .get(thread) !== null;
  return !blocked && rows.some((row) => row.eligible === 1);
}
