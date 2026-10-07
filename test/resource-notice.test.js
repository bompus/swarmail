import { expect, test } from "bun:test";
import Schema from "typebox/schema";
import { openDatabase } from "../src/db.ts";
import { createTools, TOOL_DEFINITIONS } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";
import { isMessageResult } from "../src/message-validation.ts";

const reference = Schema.Compile(
  TOOL_DEFINITIONS.find((t) => t.name === "send_message").inputSchema,
);
const notice = {
  resource_id: "heavy-local-work",
  phase_id: "suite-42",
  state: "released",
  next_action: "none",
};

function fixture() {
  const db = openDatabase(":memory:");
  const tools = createTools(db, { databasePath: ":memory:", mutationsEnabled: true });
  const project_key = "/resource/repo";
  for (const name of ["BlueLake", "GreenCastle"]) {
    tools.register_agent({
      project_key,
      name,
      program: "codex",
      model: "test",
      task_description:
        name === "GreenCastle" ? "[t3:resource-thread codex:resource-session] receiver" : "sender",
    });
  }
  const args = {
    project_key,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    idempotency_key: "release-to-green",
    resource_notice: notice,
  };
  return { db, tools, args, waiters: createWaiters(db) };
}

function rows(db) {
  return Object.fromEntries(
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

test("typed sends render readable release and dependency notices with derived wake policy", () => {
  const cases = [
    [
      "released",
      "none",
      "Resource released",
      "Resource `heavy-local-work` was released by phase `suite-42`. No action requested.",
      "quiet",
    ],
    [
      "released",
      "retry_admission",
      "Resource released",
      "Resource `heavy-local-work` was released by phase `suite-42`. Recheck admission before starting.",
      "wake",
    ],
    [
      "cancelled",
      "none",
      "Dependency cancelled",
      "Phase `suite-42` cancelled its dependency on resource `heavy-local-work`. No action requested.",
      "quiet",
    ],
    [
      "cancelled",
      "drop_dependency",
      "Dependency cancelled",
      "Phase `suite-42` cancelled its dependency on resource `heavy-local-work`. Remove that dependency. Resource availability is not established.",
      "wake",
    ],
  ];
  for (const [state, next_action, subject, body_md, notification_policy] of cases) {
    const f = fixture();
    try {
      f.tools.file_reservation_paths({
        project_key: f.args.project_key,
        agent_name: "BlueLake",
        paths: ["src/**"],
        ttl_seconds: 60,
      });
      const reservations = f.db.query("SELECT * FROM file_reservations").all();
      const args = { ...f.args, resource_notice: { ...notice, state, next_action } };
      expect(reference.Check(args)).toBe(true);
      const result = f.tools.send_message(args);
      expect(isMessageResult(result)).toBe(true);
      expect(result).toMatchObject({
        subject,
        body_md,
        topic: "resource-coordination",
        importance: "normal",
        ack_required: false,
        notification_policy,
      });
      expect(Object.hasOwn(result, "resource_notice")).toBe(false);
      expect(
        f.tools.fetch_session_inbox({
          host: "codex",
          session_id: "resource-session",
          mark_read: false,
          include_bodies: true,
        }),
      ).toMatchObject([{ id: result.id, body_md }]);
      expect(f.waiters.peek("resource-thread").mailboxes).toHaveLength(
        notification_policy === "wake" ? 1 : 0,
      );
      expect(f.db.query("SELECT * FROM file_reservations").all()).toEqual(reservations);
    } finally {
      f.db.close();
    }
  }
});

test("malformed typed sends match their public schema and leave every table unchanged before retry lookup", () => {
  const f = fixture();
  try {
    f.tools.send_message(f.args);
    const before = rows(f.db);
    const bad = [
      { resource_notice: null },
      { resource_notice: [] },
      { resource_notice: "compressed prose" },
      ...Object.keys(notice).map((key) => ({
        resource_notice: Object.fromEntries(Object.entries(notice).filter(([k]) => k !== key)),
      })),
      ...["", "a".repeat(97), "suite 42", "suite\n", "é", "`markdown`", "-leading"].map(
        (resource_id) => ({ resource_notice: { ...notice, resource_id } }),
      ),
      { resource_notice: { ...notice, phase_id: 42 } },
      { resource_notice: { ...notice, phase_id: "suite\r42" } },
      { resource_notice: { ...notice, details: "unrelated errors" } },
      { resource_notice: { ...notice, state: "finished" } },
      { resource_notice: { ...notice, next_action: "start_job" } },
      { resource_notice: { ...notice, next_action: "drop_dependency" } },
      { resource_notice: { ...notice, state: "cancelled", next_action: "retry_admission" } },
      { to: [] },
      { to: ["GreenCastle", "BlueLake"] },
      { to: [42] },
      { to: [" "] },
      { idempotency_key: "" },
      { idempotency_key: "\n " },
      { idempotency_key: null },
      { thread_id: 42 },
      { thread_id: null },
      ...[
        "subject",
        "body_md",
        "topic",
        "importance",
        "notification_policy",
        "delivery_policy",
        "ack_required",
        "cc",
        "bcc",
        "details",
      ].map((key) => ({ [key]: "override" })),
    ];
    const missingKey = { ...f.args };
    delete missingKey.idempotency_key;
    for (const args of [missingKey, ...bad.map((extra) => ({ ...f.args, ...extra }))]) {
      expect(reference.Check(args)).toBe(false);
      expect(() => f.tools.send_message(args)).toThrow("invalid resource notice");
      expect(rows(f.db)).toEqual(before);
    }
  } finally {
    f.db.close();
  }
});

test("typed retry fingerprints keep the original action and generic mail stays available", () => {
  const f = fixture();
  try {
    const args = {
      ...f.args,
      thread_id: "coordination-42",
      resource_notice: { ...notice, next_action: "retry_admission" },
    };
    const first = f.tools.send_message(args);
    const stored = f.db.query("SELECT * FROM messages").all();
    const replay = f.tools.send_message(args);
    expect(replay).toMatchObject({ id: first.id, idempotent_replay: true });
    const reordered = Object.fromEntries(Object.entries(args.resource_notice).reverse());
    expect(f.tools.send_message({ ...args, resource_notice: reordered })).toMatchObject({
      id: first.id,
      idempotent_replay: true,
    });
    expect(f.db.query("SELECT * FROM messages").all()).toEqual(stored);
    for (const resource_notice of [
      { ...args.resource_notice, next_action: "none" },
      { ...args.resource_notice, phase_id: "suite-43" },
    ]) {
      expect(() => f.tools.send_message({ ...args, resource_notice })).toThrow(
        "different arguments",
      );
    }
    const generic = {
      project_key: f.args.project_key,
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject: "Requested result",
      body_md: "Necessary evidence",
      notification_policy: "quiet",
    };
    expect(reference.Check(generic)).toBe(true);
    expect(reference.Check({ ...generic, resource_notice: notice })).toBe(false);
    expect(f.tools.send_message(generic)).toMatchObject({
      subject: generic.subject,
      body_md: generic.body_md,
    });
    const boundary = {
      ...f.args,
      idempotency_key: "max-id",
      resource_notice: { ...notice, resource_id: "a".repeat(96), phase_id: "A0_.:-" },
    };
    expect(reference.Check(boundary)).toBe(true);
    expect(f.tools.send_message(boundary).body_md).toContain("phase `A0_.:-`");
  } finally {
    f.db.close();
  }
});
