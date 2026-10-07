import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";

function fixture() {
  const db = openDatabase(":memory:");
  const tools = createTools(db, { databasePath: ":memory:" });
  const project_key = "/quiet-default/repo";
  const tags = {
    BlueLake: "[t3:sender-thread codex:sender-session]",
    GreenCastle: "[t3:receiver-thread codex:receiver-session]",
    AmberHill: "[t3:other-thread cursor:other-session]",
    RedPond: "[codex:native-session]",
    GrayField: "unidentified",
    WhiteCloud: "[t3:bad/thread codex:malformed-session]",
  };
  for (const [name, task_description] of Object.entries(tags)) {
    tools.register_agent({ project_key, name, task_description, program: "codex", model: "test" });
  }
  const common = { project_key, sender_name: "BlueLake" };
  return {
    db,
    tools,
    common,
    send: (extra = {}) =>
      tools.send_message({
        ...common,
        to: ["GreenCastle"],
        subject: "update",
        body_md: "retained evidence",
        ...extra,
      }),
    peek: () => createWaiters(db).peek("receiver-thread"),
  };
}

test("omitted T3 policy stores readable quiet mail and replays its original default", () => {
  const f = fixture();
  try {
    const args = { idempotency_key: "default-policy" };
    const sent = f.send(args);
    expect(sent.notification_policy).toBe("quiet");
    expect(f.peek()).toEqual({ mailboxes: [] });
    expect(
      f.tools.fetch_session_inbox({
        host: "codex",
        session_id: "receiver-session",
        mark_read: false,
        include_bodies: true,
      }),
    ).toMatchObject([{ id: sent.id, notification_policy: "quiet", body_md: "retained evidence" }]);
    expect(
      f.tools.search_messages({ project_key: f.common.project_key, query: "evidence" }).result,
    ).toHaveLength(1);
    f.tools.register_agent({
      project_key: f.common.project_key,
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[codex:replacement-session]",
    });
    expect(f.send(args)).toMatchObject({
      id: sent.id,
      notification_policy: "quiet",
      idempotent_replay: true,
    });
    expect(f.send().notification_policy).toBe("wake");
  } finally {
    f.db.close();
  }
});

test("default checks every recipient and preserves explicit, priority and acknowledgement policies", () => {
  const f = fixture();
  try {
    const cases = [
      [{}, "quiet"],
      [{ importance: "low", cc: ["AmberHill"], bcc: ["GreenCastle"] }, "quiet"],
      [{ to: ["RedPond"] }, "wake"],
      [{ to: ["GrayField"] }, "wake"],
      [{ to: ["WhiteCloud"] }, "wake"],
      [{ to: ["GreenCastle", "RedPond"] }, "wake"],
      [{ cc: ["RedPond"] }, "wake"],
      [{ bcc: ["GrayField"], importance: "low" }, "wake"],
      [{ notification_policy: "wake", importance: "low" }, "wake"],
      [{ notification_policy: "quiet", to: ["RedPond"] }, "quiet"],
      [{ importance: "high" }, "wake"],
      [{ importance: "urgent", notification_policy: "wake" }, "wake"],
      [{ ack_required: true }, "wake"],
      [{ importance: "low", ack_required: true }, "wake"],
    ];
    for (const [args, policy] of cases) {
      expect(f.send(args).notification_policy).toBe(policy);
    }
    expect(f.peek().mailboxes).toHaveLength(1);
    for (const args of [{ importance: "high" }, { importance: "urgent" }, { ack_required: true }]) {
      expect(() => f.send({ ...args, notification_policy: "quiet" })).toThrow(
        "quiet mail requires",
      );
    }
    expect(() => f.send({ notification_policy: null })).toThrow("notification_policy must be");
  } finally {
    f.db.close();
  }
});

test("replies recompute the default from recipients, inherited importance and reply acknowledgement", () => {
  const f = fixture();
  try {
    const reply = (sent, extra = {}) =>
      f.tools.reply_message({
        project_key: f.common.project_key,
        sender_name: "GreenCastle",
        message_id: sent.id,
        body_md: "answer",
        ...extra,
      });
    expect(reply(f.send({ notification_policy: "wake" })).notification_policy).toBe("quiet");
    expect(reply(f.send(), { notification_policy: "wake" }).notification_policy).toBe("wake");
    expect(reply(f.send({ importance: "urgent" })).notification_policy).toBe("wake");
    expect(reply(f.send({ ack_required: true })).notification_policy).toBe("quiet");
    expect(reply(f.send(), { ack_required: true }).notification_policy).toBe("wake");
    expect(
      reply(f.send({ importance: "high", ack_required: true }), {
        importance: "low",
        ack_required: false,
      }).notification_policy,
    ).toBe("quiet");
  } finally {
    f.db.close();
  }
});
