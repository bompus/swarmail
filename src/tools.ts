// Swarmail tools; shared lookups and writes live in store.ts.
import type { Database } from "bun:sqlite";
import { iso, nowUs } from "./db.ts";
import {
  type Agent,
  type Args,
  type Row,
  agentOut,
  list,
  MailStore,
  projectOut,
  pageLimit,
  str,
  time,
  ToolError,
} from "./store.ts";

export { ToolError } from "./store.ts";

type Tools = Record<string, (a: Args) => unknown>;

const identityTools = (s: MailStore, info: { databasePath: string }): Tools => ({
  health_check: () => {
    // Read a real table so a closed, locked or unreadable database fails the check.
    s.db.query("SELECT 1 FROM projects LIMIT 1").get();
    return { status: "ok", database_path: info.databasePath };
  },

  ensure_project: (a) => projectOut(s.ensureProject(a.human_key)),

  register_agent: (a) => agentOut(s.register(s.ensureProject(a.project_key), a)),

  macro_start_session: (a) => {
    const limit = pageLimit(a.inbox_limit, "inbox_limit", 10);
    const p = s.ensureProject(a.human_key);
    const who = s.register(p, { ...a, name: a.agent_name });
    const reservations = list(a.file_reservation_paths).length
      ? s.reserve(p, who, {
          paths: a.file_reservation_paths,
          reason: a.file_reservation_reason,
          ttl_seconds: a.file_reservation_ttl_seconds,
        })
      : { granted: [], conflicts: [] };
    return {
      project: projectOut(p),
      agent: agentOut(who),
      file_reservations: reservations,
      inbox: s.inbox(p, who, { limit }, false),
    };
  },

  whois: (a) => agentOut(s.agent(s.project(a.project_key), a.agent_name)),

  list_agents: (a) => {
    const p = s.project(a.project_key);
    const since = a.active_within_days ? nowUs() - a.active_within_days * 86_400_000_000 : 0;
    return s.db
      .query<Agent, [number, number, number]>(
        `SELECT * FROM agents WHERE project_id = ? AND retired_at IS NULL AND last_active_ts >= ?
         ORDER BY last_active_ts DESC, id DESC LIMIT ?`,
      )
      .all(p.id, since, pageLimit(a.limit, "limit", 250))
      .map((r) => ({
        name: r.name,
        program: r.program,
        model: r.model,
        task_description: r.task_description,
        inception_ts: iso(r.inception_ts),
        last_active_ts: iso(r.last_active_ts),
      }));
  },

  retire_agent: (a) => {
    // Localhost callers can register directly.
    const p = s.project(a.project_key),
      who = s.agent(p, a.agent_name),
      now = nowUs();
    s.db.run("UPDATE agents SET retired_at = ? WHERE id = ?", [now, who.id]);
    return { agent_name: who.name, retired: true, retired_at: iso(now) };
  },

  unretire_agent: (a) => {
    const p = s.project(a.project_key),
      who = s.agent(p, a.agent_name);
    s.db.run("UPDATE agents SET retired_at = NULL, last_active_ts = ? WHERE id = ?", [
      nowUs(),
      who.id,
    ]);
    return { agent_name: who.name, retired: false };
  },
});

const messageTools = (s: MailStore): Tools => ({
  send_message: (a) => {
    const p = s.project(a.project_key),
      sender = s.acting(p, a.sender_name, "sender_name");
    return s.idempotent("send_message", sender.id, a, () => s.deliver(p, sender, a));
  },

  reply_message: (a) => {
    const p = s.project(a.project_key),
      sender = s.acting(p, a.sender_name, "sender_name");
    const original = s.message(p, a.message_id);
    const prefix = a.subject_prefix ?? "Re:";
    const subject = original.subject.toLowerCase().startsWith(prefix.toLowerCase())
      ? original.subject
      : `${prefix} ${original.subject}`;
    const to = a.to ?? [s.q.agentById.get(original.sender_id)!.name];
    return s.idempotent("reply_message", sender.id, a, () => {
      const m = s.deliver(
        p,
        sender,
        { ...a, to, subject: undefined, thread_id: undefined, topic: undefined },
        {
          thread_id: original.thread_id ?? String(original.id),
          topic: original.topic,
          subject,
          importance: original.importance,
          ack_required: !!original.ack_required,
        },
      );
      return { ...m, reply_to: original.id };
    });
  },

  fetch_inbox: (a) => {
    a = { ...a, limit: pageLimit(a.limit, "limit", 20) };
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name);
    return s.db.transaction(() => s.inbox(p, who, a, a.mark_read ?? true))();
  },

  mark_message_read: (a) => {
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name);
    const { id, r } = s.recipientRow(p, who, a.message_id);
    const readTs = r.read_ts ?? nowUs();
    if (r.read_ts == null) {
      s.db.run("UPDATE message_recipients SET read_ts = ? WHERE message_id = ? AND agent_id = ?", [
        readTs,
        id,
        who.id,
      ]);
    }
    return { message_id: id, read: true, read_at: iso(readTs) };
  },

  acknowledge_message: (a) => {
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name);
    const { id, r } = s.recipientRow(p, who, a.message_id);
    const now = nowUs(),
      ackTs = r.ack_ts ?? now,
      readTs = r.read_ts ?? now;
    s.db.run(
      "UPDATE message_recipients SET ack_ts = ?, read_ts = ? WHERE message_id = ? AND agent_id = ?",
      [ackTs, readTs, id, who.id],
    );
    return {
      message_id: id,
      acknowledged: true,
      acknowledged_at: iso(ackTs),
      read_at: iso(readTs),
    };
  },
});

// FTS limits tokens, but a token or the punctuation between tokens can be arbitrarily long.
function boundedExcerpt(value: string, startMarker: string, endMarker: string): string {
  const match = Array.from(value.slice(0, Math.max(0, value.indexOf(startMarker)))).length;
  value = value.replaceAll(startMarker, ">>>").replaceAll(endMarker, "<<<");
  const chars = Array.from(value);
  if (chars.length <= 512) {
    return value;
  }
  const start = Math.max(0, match - 120);
  return (start ? "…" : "") + chars.slice(start, start + 510).join("") + "…";
}

function searchMessages(s: MailStore, a: Args) {
  const p = s.project(a.project_key);
  const terms = String(a.query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "query needs at least one word", {
      field: "query",
    });
  }
  const match = terms.map((t) => `"${t}"`).join(" ");
  const marker = crypto.randomUUID();
  const startMarker = `start-${marker}`;
  const endMarker = `end-${marker}`;
  const from = a.sender_name ?? null;
  const after = time(a.since, "since");
  const before = time(a.until, "until", true);
  const importance =
    a.importance == null
      ? null
      : JSON.stringify(
          String(a.importance)
            .split(",")
            .map((x) => x.trim()),
        );
  const limit = pageLimit(a.limit, "limit", 20);
  if (a.cursor !== undefined && (typeof a.cursor !== "string" || !/^o\d+$/.test(a.cursor))) {
    throw new ToolError("INVALID_ARGUMENT", "cursor must be a search continuation cursor", {
      field: "cursor",
    });
  }
  const offset = Number(a.cursor?.slice(1) ?? 0);
  if (!Number.isSafeInteger(offset) || offset > Number.MAX_SAFE_INTEGER - limit) {
    throw new ToolError("INVALID_ARGUMENT", "cursor exceeds the supported search range", {
      field: "cursor",
    });
  }
  const rows = s.db
    .query<Row, any[]>(
      `SELECT m.id, m.subject, m.importance, m.ack_required, m.created_ts, m.thread_id, m.topic, s.name AS "from",
                m.body_md, m.recipients_json,
                snippet(messages_fts, -1, ?10, ?11, ' … ', 32) AS excerpt
         FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN agents s ON s.id = m.sender_id
         WHERE messages_fts MATCH ?1 AND m.project_id = ?2 AND (?3 IS NULL OR s.name = ?3 COLLATE NOCASE)
           AND (?4 IS NULL OR m.thread_id = ?4 OR CAST(m.id AS TEXT) = ?4) AND (?5 IS NULL OR m.importance IN (SELECT value FROM json_each(?5)))
           AND (?6 IS NULL OR m.created_ts >= ?6) AND (?7 IS NULL OR m.created_ts <= ?7)
         ORDER BY ${a.ranking === "recency" ? "" : "bm25(messages_fts, 4.0, 1.0),"} m.created_ts DESC, m.id DESC
         LIMIT ?8 OFFSET ?9`,
    )
    .all(
      match,
      p.id,
      from,
      a.thread_id == null ? null : String(a.thread_id),
      importance,
      after,
      before,
      limit + 1,
      offset,
      startMarker,
      endMarker,
    );
  const result = rows.slice(0, limit).map(({ body_md, recipients_json, ...m }) => {
    const r = JSON.parse(recipients_json || "{}");
    // Omit an unset topic.
    const { topic, from, ...rest } = m;
    return {
      ...rest,
      created_ts: iso(m.created_ts),
      excerpt: boundedExcerpt(m.excerpt, startMarker, endMarker),
      ...(topic != null && { topic }),
      from,
      to: r.to ?? [],
      cc: r.cc ?? [],
      ...(a.include_body_md && { body_md }),
    };
  });
  return { result, ...(rows.length > limit && { next_cursor: `o${offset + limit}` }) };
}

const readTools = (s: MailStore): Tools => ({
  get_message_delivery_receipt: (a) => {
    const p = s.project(a.project_key);
    const m = s.message(p, a.message_id);
    const rows = s.db
      .query<Row, [number]>(
        `SELECT a.name, r.kind, r.read_ts, r.ack_ts FROM message_recipients r JOIN agents a ON a.id = r.agent_id
         WHERE r.message_id = ? ORDER BY a.name`,
      )
      .all(m.id);
    // read_at tells a sender whether each recipient has fetched the message yet.
    return {
      message_id: m.id,
      project_id: p.id,
      persisted_at: iso(m.created_ts),
      recipients: rows.map((r) => ({
        recipient: r.name,
        kind: r.kind,
        read_at: iso(r.read_ts),
        acknowledged: r.ack_ts != null,
        acknowledged_at: iso(r.ack_ts),
      })),
    };
  },

  search_messages: (a) => searchMessages(s, a),

  summarize_thread: (a) => {
    // Returns the thread for the caller to summarize.
    const p = s.project(a.project_key),
      threadId = str(a.thread_id == null ? a.thread_id : String(a.thread_id), "thread_id");
    const rows = s.thread(p, threadId);
    const limit = pageLimit(a.per_thread_limit, "per_thread_limit", 50);
    return {
      thread_id: threadId,
      summary: {
        participants: [...new Set(rows.map((r) => r.sender))],
        total_messages: rows.length,
      },
      messages: rows.slice(-limit).map((m) => ({
        id: m.id,
        from: m.sender,
        subject: m.subject,
        importance: m.importance,
        created_ts: iso(m.created_ts),
        body_md: m.body_md,
      })),
    };
  },
});

const reservationTools = (s: MailStore): Tools => ({
  file_reservation_paths: (a) => {
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name);
    return s.idempotent("file_reservation_paths", who.id, a, () => s.reserve(p, who, a));
  },

  renew_file_reservations: (a) => {
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name);
    const extend = Number(a.extend_seconds ?? 1800) * 1_000_000;
    return s.db.transaction(() => {
      const renewed = s.ownActive(p, who, a).map((r) => {
        const next = r.expires_ts + extend;
        s.db.run("UPDATE file_reservations SET expires_ts = ? WHERE id = ?", [next, r.id]);
        return {
          id: r.id,
          path_pattern: r.path_pattern,
          old_expires_ts: iso(r.expires_ts),
          new_expires_ts: iso(next),
        };
      });
      return { renewed: renewed.length, file_reservations: renewed };
    })();
  },

  release_file_reservations: (a) => {
    const p = s.project(a.project_key),
      who = s.acting(p, a.agent_name),
      now = nowUs();
    return s.db.transaction(() => {
      const rows = s.ownActive(p, who, a);
      for (const r of rows) {
        s.db.run("UPDATE file_reservations SET released_ts = ? WHERE id = ?", [now, r.id]);
      }
      return { released: rows.length, released_at: iso(now) };
    })();
  },
});

export function createTools(db: Database, info: { databasePath: string }): Tools {
  const s = new MailStore(db);
  return {
    ...identityTools(s, info),
    ...messageTools(s),
    ...readTools(s),
    ...reservationTools(s),
  };
}
