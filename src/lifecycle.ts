// Authoritative app lifecycle is independent of activity and manual retirement.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { noticeOwners } from "./wake-notices.ts";

export interface LifecycleConfig {
  /** Stable local profile name. Changing its database or event table requires explicit rebinding. */
  profile: string;
  databasePath: string;
  /** T3 Code 0.1.0 and later write `orchestration_events`; `orchestration_v2_events` is for earlier releases. */
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

/**
 * A thread row as readSnapshot selects it. SQLite reads the two payload fields: parsing every thread's whole payload
 * here cost more than the query. `*_type` is SQLite's JSON type name ("null", "text", ...), or NULL when the field is
 * missing or the payload is not a JSON object. A field is a string only when its type is "text".
 */
type ThreadRow = {
  thread_id: string;
  archived_at: unknown;
  deleted_at: unknown;
  payload_type: string | null;
  settled_at_type: string | null;
  settled_at: unknown;
  settled_override_type: string | null;
  settled_override: unknown;
};

/** The field's value, or undefined when it is missing or neither null nor a string. */
const fieldOf = (type: string | null, value: unknown) =>
  type === "null" ? null : type === "text" ? value : undefined;

function stateOf(row: ThreadRow): State {
  if (row.payload_type !== "object") {
    throw new Error("invalid thread projection");
  }
  const settledAt = fieldOf(row.settled_at_type, row.settled_at);
  const settledOverride = fieldOf(row.settled_override_type, row.settled_override);
  for (const value of [row.archived_at, row.deleted_at, settledAt]) {
    if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
      throw new Error("unknown thread lifecycle schema");
    }
  }
  if (![null, "active", "settled"].includes(settledOverride as string | null)) {
    throw new Error("unknown settlement override");
  }
  if (row.deleted_at !== null) {
    return "deleted";
  }
  if (row.archived_at !== null) {
    return "archived";
  }
  return settledOverride === "settled" || settledAt !== null ? "settled" : "active";
}

/** Read lifecycle, projection watermark and continuity anchors in one source transaction. */
function readSnapshot(
  config: LifecycleConfig,
  previous: Cursor | null,
  threads: string[],
  verified: Set<string>,
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
      const located = source.query<{ sequence: number }, [string]>(
        `SELECT sequence FROM ${config.eventTable} WHERE event_id = ?`,
      );
      // T3 compaction deletes events that a newer event of the same thread supersedes, so the saved anchor may be
      // gone. Sequences are never reused, so a missing anchor whose event id appears nowhere else is a deletion; a
      // different event at that sequence, the anchor at another sequence or a lower watermark is a rewrite.
      if (previous) {
        const atPrevious = anchor.get(previous.sequence)?.event_id;
        if (
          meta.last_sequence < previous.sequence ||
          (atPrevious === undefined
            ? located.get(previous.event_id) !== null
            : atPrevious !== previous.event_id)
        ) {
          throw new Error("source history changed");
        }
      }
      // The watermark is the newest projected event, which compaction keeps until a newer one moves the watermark.
      const eventId = anchor.get(meta.last_sequence)?.event_id;
      if (typeof eventId !== "string" || !eventId) {
        throw new Error("missing history anchor");
      }
      const states = new Map<string, State>();
      // Text that is not valid JSON, or is not text, reads as no payload: its row is invalid, as JSON.parse would find it.
      // A key repeated in one object resolves to its first value here, its last in JSON.parse; T3 never writes one.
      const rows = source
        .query<ThreadRow, [string]>(
          `SELECT thread_id, archived_at, deleted_at,
            json_type(payload) AS payload_type,
            json_type(payload, '$.settledAt') AS settled_at_type,
            json_extract(payload, '$.settledAt') AS settled_at,
            json_type(payload, '$.settledOverride') AS settled_override_type,
            json_extract(payload, '$.settledOverride') AS settled_override
          FROM (
            SELECT thread_id, archived_at, deleted_at,
              CASE WHEN typeof(payload_json) = 'text' AND json_valid(payload_json) THEN payload_json END AS payload
            FROM orchestration_v2_projection_threads
            WHERE thread_id IN (SELECT value FROM json_each(?))
          )`,
        )
        .all(JSON.stringify(threads));
      for (const row of rows) {
        try {
          states.set(row.thread_id, stateOf(row));
        } catch (error) {
          if (verified.has(row.thread_id)) {
            throw error;
          }
          // An unverified registration holds only itself, not the configured profile.
        }
      }
      if (threads.some((thread) => verified.has(thread) && !states.has(thread))) {
        throw new Error("missing verified thread");
      }
      return { sequence: meta.last_sequence, eventId, states };
    })();
  } finally {
    source.close();
  }
}

type SidecarFingerprint = { value: string } | { missing: true } | null;

/**
 * Identity and access state of one source file: device, inode, mode and owner, plus the database's
 * size and ctime when wanted. The WAL's content timestamps are left out because a commit changes
 * them legitimately; `data_version` reports the commit. A missing file is reported separately; any
 * other stat failure returns null and forces the full read.
 */
function sidecarFingerprint(path: string, content: boolean): SidecarFingerprint {
  try {
    const stat = statSync(path, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`;
    return { value: content ? `${identity}:${stat.size}:${stat.ctimeNs}` : identity };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : null;
  }
}

/** One configured local T3 V2 profile, shared by tools and wake boundaries. No timers or provider inference. */
export class Lifecycle {
  private readonly db: Database;
  private readonly config: LifecycleConfig;
  /**
   * The engine-level commit check needs a persistent read-only connection. It is Linux-only: the
   * handle behaviour on Windows is untested, so Windows and every other platform keep the full read.
   */
  private readonly gateEnabled = process.platform === "linux";
  private gate?: Database;
  private gateVersion: number | null = null;
  private gateIdentity = "";
  private gateThreads = "";
  /** Successful source reads; tests use it to prove a skip did not read. */
  private reads = 0;
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

  /**
   * `PRAGMA data_version` changes when another connection commits, which is the engine's commit
   * point. The database and its WAL sidecar are both fingerprinted, including their access modes,
   * so a replacement or permission change on either reopens the connection and forces the full
   * read. A missing WAL is normal; a dead connection, a stat or query error, or any other failure
   * returns null and forces the full read.
   */
  private gateCheck(
    threads: string[],
  ): { skip: boolean; version: number | null; threads: string } | null {
    if (!this.gateEnabled) {
      return null;
    }
    try {
      const database = sidecarFingerprint(this.config.databasePath, true);
      if (database === null || "missing" in database) {
        return null;
      }
      const wal = sidecarFingerprint(`${this.config.databasePath}-wal`, false);
      if (wal === null) {
        return null;
      }
      const identity = `${database.value}|${"missing" in wal ? "none" : wal.value}`;
      if (!this.gate || this.gateIdentity !== identity) {
        this.gate?.close();
        this.gate = new Database(this.config.databasePath, { readonly: true, strict: true });
        this.gate.run("PRAGMA busy_timeout = 1000");
        this.gateIdentity = identity;
        this.gateVersion = null;
        this.gateThreads = "";
      }
      const version = (this.gate.query("PRAGMA data_version").get() as { data_version: number })
        .data_version;
      const key = JSON.stringify([...threads].sort());
      return {
        skip: this.gateVersion === version && this.gateThreads === key,
        version,
        threads: key,
      };
    } catch {
      this.gate?.close();
      this.gate = undefined;
      this.gateVersion = null;
      this.gateThreads = "";
      return null;
    }
  }

  reconcile(): Reconciliation {
    // A tool wraps its work in an outer transaction. A skip inside one is safe: it writes nothing
    // and reuses the last version recorded by a committed reconcile. A full read inside one must
    // not record a new version, because the outer transaction can roll back the rows.
    const cacheable = !this.db.inTransaction;
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
          const gate = this.gateCheck(threads);
          if (prior && gate?.skip) {
            return { status: "ready", changed: 0 };
          }
          const verified = new Set(
            this.db
              .query<{ thread_id: string }, [string]>(
                "SELECT thread_id FROM session_lifecycle WHERE profile = ?",
              )
              .all(this.config.profile)
              .map((row) => row.thread_id),
          );
          const snapshot = readSnapshot(this.config, prior, threads, verified);
          this.reads += 1;
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
          if (cacheable && gate && gate.version !== null) {
            this.gateVersion = gate.version;
            this.gateThreads = gate.threads;
          }
          return { status: "ready", changed };
        })
        .immediate();
    } catch {
      // No source contents, paths or partial observations escape this boundary.
      this.gateVersion = null;
      this.gateThreads = "";
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
