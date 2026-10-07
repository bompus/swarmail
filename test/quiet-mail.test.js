import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";
import { join } from "node:path";
import { testScratch } from "./fixtures/test-scratch.js";
import { isMessageResult } from "../src/message-validation.ts";

const scratch = testScratch();
function fixture(path = ":memory:") {
  const db = openDatabase(path);
  const tools = createTools(db, { databasePath: ":memory:", mutationsEnabled: true });
  const project_key = "/quiet/repo";
  for (const name of ["BlueLake", "GreenCastle"]) {
    tools.register_agent({
      project_key,
      name,
      program: "codex",
      model: "test",
      task_description:
        name === "GreenCastle" ? "[t3:quiet-thread codex:quiet-session] receiver" : "sender",
    });
  }
  const common = { project_key, sender_name: "BlueLake" };
  let waiters = createWaiters(db);
  return {
    db,
    tools,
    common,
    send: (extra = {}) =>
      tools.send_message({
        ...common,
        to: ["GreenCastle"],
        subject: "informational",
        body_md: "retained evidence",
        notification_policy: "wake",
        ...extra,
      }),
    inbox: (extra = {}) =>
      tools.fetch_inbox({
        project_key,
        agent_name: "GreenCastle",
        include_bodies: true,
        mark_read: false,
        ...extra,
      }),
    peek: () => waiters.peek("quiet-thread"),
    restart: () => {
      waiters = createWaiters(db);
    },
    wait: async (after = 0) => {
      const stop = new AbortController();
      const pending = waiters.wait("quiet-thread", 60000, stop.signal, { retry: true, after });
      stop.abort();
      return await pending;
    },
  };
}

test("quiet mail stays readable and searchable without offers, cursors or mailbox wake snapshots", async () => {
  const f = fixture();
  try {
    const quiet = f.send({ notification_policy: "quiet", idempotency_key: "quiet-send" });
    expect(quiet.notification_policy).toBe("quiet");
    expect(isMessageResult(quiet)).toBe(true);
    expect(await f.wait()).toBeNull();
    expect(f.peek()).toEqual({ mailboxes: [] });
    expect(f.db.query("SELECT * FROM wake_notice_offers").all()).toEqual([]);
    expect(f.inbox()).toMatchObject([
      { id: quiet.id, notification_policy: "quiet", body_md: "retained evidence" },
    ]);
    expect(
      f.tools.fetch_session_inbox({ host: "codex", session_id: "quiet-session", mark_read: false }),
    ).toMatchObject([{ id: quiet.id, notification_policy: "quiet" }]);
    expect(
      f.tools.search_messages({ project_key: f.common.project_key, query: "evidence" }).result,
    ).toHaveLength(1);
    expect(f.send({ notification_policy: "quiet", idempotency_key: "quiet-send" })).toMatchObject({
      id: quiet.id,
      idempotent_replay: true,
    });
    expect(() => f.send({ notification_policy: "wake", idempotency_key: "quiet-send" })).toThrow(
      "different arguments",
    );
    f.restart();
    expect(await f.wait()).toBeNull();
    const wake = f.send();
    expect(wake.notification_policy).toBe("wake");
    expect((await f.wait()).eventId).toBe(wake.id);
    expect(f.peek().mailboxes).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("unread quiet remainder cannot retain an admitted notice or suppress the next wake", async () => {
  const f = fixture();
  try {
    const wake = f.send();
    const first = await f.wait();
    const quiet = f.send({ notification_policy: "quiet" });
    expect(f.db.query("SELECT covered_through FROM wake_notices").get().covered_through).toBe(
      wake.id,
    );
    f.tools.mark_message_read({
      project_key: f.common.project_key,
      agent_name: "GreenCastle",
      message_id: wake.id,
    });
    expect(f.db.query("SELECT * FROM wake_notices").all()).toEqual([]);
    f.restart();
    expect(f.peek()).toEqual({ mailboxes: [] });
    expect(await f.wait(first.eventId)).toBeNull();
    expect(f.inbox({ unread_only: true })).toMatchObject([{ id: quiet.id }]);
    const next = f.send({ importance: "urgent", ack_required: true });
    expect((await f.wait(first.eventId)).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

test("quiet rejects urgent or acknowledgement requests before storage, including reply inheritance and priority mutations", () => {
  const f = fixture();
  try {
    for (const args of [
      { importance: "high" },
      { importance: "urgent" },
      { ack_required: true },
      { importance: "invalid" },
    ]) {
      expect(() => f.send({ notification_policy: "quiet", ...args })).toThrow(
        "quiet mail requires",
      );
    }
    for (const notification_policy of [null, "silent", true]) {
      expect(() => f.send({ notification_policy })).toThrow("notification_policy must be");
    }
    expect(f.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(0);
    const quiet = f.send({ notification_policy: "quiet", importance: "low" });
    const replyArgs = {
      project_key: f.common.project_key,
      sender_name: "GreenCastle",
      message_id: quiet.id,
      body_md: "answer",
    };
    expect(f.tools.reply_message(replyArgs).notification_policy).toBe("wake");
    expect(
      f.tools.reply_message({ ...replyArgs, notification_policy: "quiet" }).notification_policy,
    ).toBe("quiet");
    const urgent = f.send({ importance: "urgent" });
    expect(() =>
      f.tools.reply_message({ ...replyArgs, message_id: urgent.id, notification_policy: "quiet" }),
    ).toThrow("quiet mail requires");
    expect(
      f.tools.reply_message({
        ...replyArgs,
        message_id: urgent.id,
        notification_policy: "quiet",
        importance: "normal",
      }).notification_policy,
    ).toBe("quiet");
    for (const importance of ["high", "urgent"]) {
      expect(() =>
        f.tools.set_message_importance({
          ...f.common,
          message_id: quiet.id,
          importance,
          expected_revision: 0,
          idempotency_key: importance,
        }),
      ).toThrow("cannot be promoted");
    }
    expect(f.db.query("SELECT revision,importance FROM messages WHERE id=?").get(quiet.id)).toEqual(
      { revision: 0, importance: "low" },
    );
    expect(f.db.query("SELECT * FROM message_mutations").all()).toEqual([]);
    f.tools.set_message_importance({
      ...f.common,
      message_id: quiet.id,
      importance: "normal",
      expected_revision: 0,
      idempotency_key: "normal",
    });
    expect(f.inbox().find((m) => m.id === quiet.id)).toMatchObject({
      notification_policy: "quiet",
      revision: 1,
    });
  } finally {
    f.db.close();
  }
});

test("schema-six migration preserves mail and makes existing deliveries wake by default", () => {
  const path = join(scratch, "schema-six.sqlite");
  const f = fixture(path);
  const sent = f.send();
  f.db.exec("ALTER TABLE messages DROP COLUMN notification_policy; PRAGMA user_version=6");
  f.db.close();
  const db = openDatabase(path);
  try {
    expect(db.query("PRAGMA user_version").get().user_version).toBe(7);
    expect(db.query("SELECT id,body_md,notification_policy FROM messages").all()).toEqual([
      { id: sent.id, body_md: "retained evidence", notification_policy: "wake" },
    ]);
    expect(() => db.run("UPDATE messages SET notification_policy='invalid'")).toThrow();
  } finally {
    db.close();
  }
});

test("reopening does not backfill a drained wake cursor from older quiet remainder", async () => {
  const path = join(scratch, "quiet-reopen.sqlite");
  const f = fixture(path);
  f.send({ notification_policy: "quiet" });
  const wake = f.send();
  await f.wait();
  f.tools.mark_message_read({
    project_key: f.common.project_key,
    agent_name: "GreenCastle",
    message_id: wake.id,
  });
  f.db.close();
  const db = openDatabase(path);
  try {
    expect(db.query("SELECT * FROM wake_notices").all()).toEqual([]);
    expect(db.query("SELECT * FROM message_recipients WHERE read_ts IS NULL").all()).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});
