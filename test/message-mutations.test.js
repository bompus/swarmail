import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../src/db.ts";
import { createTools, WAKES } from "../src/tools.ts";
import { createServer, pruneIdempotencyKeys, pruneGoneProjects } from "../src/server.ts";
import { MailStore } from "../src/store.ts";
import { createWaiters, PING_SUBJECT } from "../src/wake.ts";
import { unreadQueues } from "../src/who.ts";
import { mail } from "../src/mail.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
let serial = 0;
const cleanups = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) {
    f();
  }
});
const P = "/mutations/repo";
function fixture(path = ":memory:") {
  const db = openDatabase(path);
  cleanups.push(() => db.close());
  let tools = createTools(db, { databasePath: path, mutationsEnabled: true });
  for (const name of ["BlueLake", "GreenCastle", "TealDune", "AmberCliff"]) {
    tools.register_agent({
      project_key: P,
      name,
      program: "codex",
      model: "test",
      task_description:
        name === "GreenCastle" ? "[t3:mutation-thread codex:mutation-session]" : "sender",
    });
  }
  let waiters = createWaiters(db);
  const common = { project_key: P, sender_name: "BlueLake" };
  const send = (extra = {}) =>
    tools.send_message({
      ...common,
      to: ["GreenCastle"],
      subject: "history",
      body_md: "retained content",
      ...extra,
    });
  const change = (id, extra = {}) =>
    tools.set_message_importance({
      ...common,
      message_id: id,
      importance: "urgent",
      expected_revision: 0,
      idempotency_key: "priority",
      ...extra,
    });
  const withdraw = (id, extra = {}) =>
    tools.withdraw_message({ ...common, message_id: id, idempotency_key: "withdraw", ...extra });
  const inbox = (extra = {}) =>
    tools.fetch_inbox({
      project_key: P,
      agent_name: "GreenCastle",
      include_bodies: true,
      mark_read: false,
      ...extra,
    });
  const claim = (id, ack = false) =>
    tools[ack ? "acknowledge_message" : "mark_message_read"]({
      project_key: P,
      agent_name: "GreenCastle",
      message_id: id,
    });
  const wait = async (after = 0) => {
    const controller = new AbortController();
    const pending = waiters.wait("mutation-thread", 60000, controller.signal, {
      retry: true,
      after,
    });
    controller.abort();
    return await pending;
  };
  return {
    db,
    tools,
    common,
    send,
    change,
    withdraw,
    inbox,
    claim,
    wait,
    restart: () => {
      waiters = createWaiters(db);
    },
    disable: () => {
      tools = createTools(db, { databasePath: path });
    },
    audit: () => db.query("SELECT * FROM message_mutations ORDER BY id").all(),
  };
}

for (const ack of [false, true]) {
  for (const withdrawnFirst of [false, true]) {
    test(`${ack ? "acknowledge" : "read"} versus withdrawal: ${withdrawnFirst ? "withdrawal" : "claim"} wins`, () => {
      const f = fixture();
      const m = f.send();
      if (withdrawnFirst) {
        expect(f.withdraw(m.id).recipients[0].status).toBe("withdrawn");
        expect(() => f.claim(m.id, ack)).toThrow("not a recipient");
        expect(f.inbox({ unread_only: false })).toEqual([]);
        const store = new MailStore(f.db);
        const who = store.agent(store.project(P), "GreenCastle");
        expect(() => store.markRead(m.id, who, 99)).toThrow("withdrawn");
        expect(() => store.acknowledge(m.id, who, 99, 99)).toThrow("withdrawn");
      } else {
        f.claim(m.id, ack);
        expect(f.withdraw(m.id).recipients[0].status).toBe("too_late");
        expect(f.inbox({ unread_only: false })).toHaveLength(1);
        expect(f.audit()).toEqual([]);
      }
    });
  }
}

test("subset validation rolls back; mixed to/cc/bcc outcomes retain history without inbox fanout", () => {
  const f = fixture();
  const m = f.send({ cc: ["TealDune"], bcc: ["AmberCliff"] });
  expect(f.inbox()[0].bcc).toBeUndefined();
  expect(f.inbox()[0].revision).toBe(0);
  expect(() => f.withdraw(m.id, { recipients: ["GreenCastle", "MissingAgent"] })).toThrow(
    "without a delivery",
  );
  expect(f.audit()).toHaveLength(0);
  expect(
    f.db
      .query("SELECT withdrawn_ts FROM message_recipients")
      .all()
      .every((r) => r.withdrawn_ts === null),
  ).toBe(true);
  f.claim(m.id);
  const first = f.withdraw(m.id, { recipients: ["tealdune", "TealDune"] });
  expect(first.recipients).toEqual([
    { recipient: "TealDune", status: "withdrawn", withdrawn_at: expect.any(String) },
  ]);
  const all = f.withdraw(m.id, { idempotency_key: "all" });
  expect(all.recipients.map((r) => [r.recipient, r.status])).toEqual([
    ["AmberCliff", "withdrawn"],
    ["GreenCastle", "too_late"],
    ["TealDune", "already_withdrawn"],
  ]);
  expect(all.revision).toBe(2);
  expect(f.audit()).toHaveLength(2);
  expect(
    f
      .audit()
      .map((r) => JSON.parse(r.details_json).recipient_ids)
      .flat(),
  ).toHaveLength(2);
  const receipt = f.tools.get_message_delivery_receipt({ project_key: P, message_id: m.id });
  expect(receipt.revision).toBe(2);
  expect(receipt.recipients.filter((r) => r.withdrawn_at)).toHaveLength(2);
  const history = f.tools.search_messages({
    project_key: P,
    query: "retained",
    include_body_md: true,
  }).result;
  expect(history[0]).toMatchObject({
    revision: 2,
    has_withdrawn_deliveries: true,
    body_md: "retained content",
  });
  expect(history[0].bcc).toBeUndefined();
  expect(
    f.tools.summarize_thread({ project_key: P, thread_id: String(m.id) }).messages[0],
  ).toMatchObject({ revision: 2, has_withdrawn_deliveries: true });
});

test("ownership/project/key/input boundaries do not write or silently revive senders", () => {
  const f = fixture();
  const m = f.send();
  expect(() => f.withdraw(m.id, { sender_name: "TealDune" })).toThrow("original sender");
  f.tools.ensure_project({ human_key: "/other/project" });
  f.tools.register_agent({
    project_key: "/other/project",
    name: "BlueLake",
    program: "x",
    model: "x",
  });
  expect(() => f.withdraw(m.id, { project_key: "/other/project" })).toThrow("not found in project");
  for (const key of [undefined, "", 123]) {
    expect(() => f.withdraw(m.id, { idempotency_key: key })).toThrow("idempotency_key");
  }
  for (const recipients of [[], "GreenCastle", [123], [""]]) {
    expect(() => f.withdraw(m.id, { recipients })).toThrow("nonempty array");
  }
  for (const expected_revision of [-1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => f.change(m.id, { expected_revision })).toThrow("nonnegative safe integer");
  }
  for (const importance of ["critical", 4, null]) {
    expect(() => f.change(m.id, { importance })).toThrow("low, normal");
  }
  f.tools.retire_agent({ project_key: P, agent_name: "BlueLake" });
  expect(() => f.withdraw(m.id)).toThrow("sender is retired");
  expect(
    f.db.query("SELECT retired_at FROM agents WHERE name='BlueLake'").get().retired_at,
  ).not.toBeNull();
  expect(f.audit()).toEqual([]);
});

test("priority uses revision CAS including no-ops, races with withdrawal and preserves consumed delivery", () => {
  const f = fixture();
  const older = f.send();
  const newer = f.send({ subject: "newer" });
  const noOp = f.change(older.id, { importance: "normal" });
  expect(noOp).toMatchObject({ changed: false, revision: 0 });
  expect(f.audit()).toEqual([]);
  expect(f.change(older.id, { idempotency_key: "promotion" })).toMatchObject({
    changed: true,
    revision: 1,
    importance: "urgent",
  });
  expect(() => f.change(older.id, { idempotency_key: "stale" })).toThrow("revision changed");
  expect(f.inbox().map((r) => r.id)).toEqual([newer.id, older.id]);
  f.claim(older.id);
  expect(
    f.change(older.id, { expected_revision: 1, importance: "low", idempotency_key: "demotion" })
      .revision,
  ).toBe(2);
  expect(f.inbox({ unread_only: true }).map((r) => r.id)).toEqual([newer.id]);
  expect(f.inbox({ unread_only: false }).find((r) => r.id === older.id).importance).toBe("low");
  f.withdraw(newer.id);
  expect(() => f.change(newer.id, { idempotency_key: "withdraw-race" })).toThrow(
    "revision changed",
  );
  expect(f.audit().map((r) => r.kind)).toEqual([
    "set_message_importance",
    "set_message_importance",
    "withdraw_message",
  ]);
});

test("lost-response replay survives restart, disabling and retirement without audit duplication", () => {
  const path = join(scratch, `replay-${++serial}.sqlite`);
  const f = fixture(path);
  const m = f.send();
  const first = f.change(m.id);
  const second = f.withdraw(m.id);
  const stamps = f.db.query("SELECT * FROM message_mutations").all();
  const other = openDatabase(path);
  cleanups.push(() => other.close());
  const tools = createTools(other, { databasePath: path });
  f.tools.retire_agent({ project_key: P, agent_name: "BlueLake" });
  expect(
    tools.set_message_importance({
      ...f.common,
      message_id: m.id,
      importance: "urgent",
      expected_revision: 0,
      idempotency_key: "priority",
    }),
  ).toEqual({ ...first, idempotent_replay: true });
  expect(
    tools.withdraw_message({ ...f.common, message_id: m.id, idempotency_key: "withdraw" }),
  ).toEqual({ ...second, idempotent_replay: true });
  expect(other.query("SELECT * FROM message_mutations").all()).toEqual(stamps);
  expect(
    other.query("SELECT retired_at FROM agents WHERE name='BlueLake'").get().retired_at,
  ).not.toBeNull();
  expect(() =>
    tools.set_message_importance({
      ...f.common,
      message_id: m.id,
      importance: "low",
      expected_revision: 0,
      idempotency_key: "priority",
    }),
  ).toThrow("different arguments");
  expect(() =>
    tools.withdraw_message({ ...f.common, message_id: m.id, idempotency_key: "new" }),
  ).toThrow("disabled");
  f.db.run("UPDATE idempotency_keys SET created_ts=0");
  pruneIdempotencyKeys(f.db, 7);
  expect(() => f.change(m.id)).toThrow("sender is retired");
});

test("disabled execution is advertised but not a wake producer", () => {
  const f = fixture();
  const m = f.send();
  f.disable();
  expect(() => f.withdraw(m.id)).toThrow("disabled");
  expect(() => f.change(m.id)).toThrow("disabled");
  expect(WAKES.has("withdraw_message")).toBe(false);
  expect(WAKES.has("set_message_importance")).toBe(false);
  expect(f.audit()).toEqual([]);
});

for (const admitted of [false, true]) {
  test(`priority and withdrawal preserve ${admitted ? "admitted" : "uncertain"} notice identity`, async () => {
    const f = fixture();
    const first = f.send();
    const offer = await f.wait();
    if (admitted) {
      expect(await f.wait(offer.eventId)).toBeNull();
    }
    const cursor = f.db.query("SELECT * FROM wake_cursors").all();
    const offers = f.db.query("SELECT * FROM wake_notice_offers").all();
    f.change(first.id);
    const second = f.send({ subject: "another" });
    f.withdraw(first.id);
    f.restart();
    const next = await f.wait(admitted ? offer.eventId : 0);
    expect(next?.eventId ?? null).toBe(admitted ? null : offer.eventId);
    expect(f.inbox().map((r) => r.id)).toEqual([second.id]);
    expect(f.db.query("SELECT event_id FROM wake_notices").get().event_id).toBe(offer.eventId);
    f.withdraw(second.id, { idempotency_key: "last" });
    expect(f.db.query("SELECT * FROM wake_notices").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM wake_cursors").all()).toEqual(cursor);
    expect(f.db.query("SELECT * FROM wake_notice_offers").all()).toEqual(offers);
    expect(await f.wait(admitted ? offer.eventId : 0)).toBeNull();
  });
}

test("withdrawal before offer removes session inbox, mailbox snapshots, roster counts and ping claims", async () => {
  const path = join(scratch, `readers-${++serial}.sqlite`);
  const f = fixture(path);
  const m = f.send();
  expect(unreadQueues(path, P).get("GreenCastle").unread).toBe(1);
  f.withdraw(m.id);
  expect(
    f.tools.fetch_session_inbox({
      host: "codex",
      session_id: "mutation-session",
      t3_thread: "mutation-thread",
      unread_only: false,
      include_bodies: true,
    }),
  ).toEqual([]);
  expect(unreadQueues(path, P).size).toBe(0);
  const waiters = createWaiters(f.db);
  expect(waiters.peek("mutation-thread").mailboxes).toEqual([]);
  expect(await f.wait()).toBeNull();
  const ping = f.send({ subject: PING_SUBJECT });
  f.withdraw(ping.id, { idempotency_key: "ping" });
  expect(await f.wait()).toBeNull();
  expect(f.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(2);
  f.db.run("UPDATE agents SET retired_at=1");
  pruneGoneProjects(f.db);
  expect(f.db.query("SELECT count(*) AS n FROM projects").get().n).toBe(1);
});

for (const claimCommitted of [false, true]) {
  test(`real SQLite connection excludes competing withdrawal until ${claimCommitted ? "committed claim" : "rollback"}`, () => {
    const path = join(scratch, `writer-${++serial}.sqlite`);
    const f = fixture(path);
    const m = f.send();
    const other = new Database(path, { strict: true });
    cleanups.push(() => other.close());
    f.db.run("PRAGMA busy_timeout=0");
    other.run("BEGIN IMMEDIATE");
    other.run("UPDATE message_recipients SET read_ts=99 WHERE message_id=?", [m.id]);
    expect(() => f.withdraw(m.id)).toThrow();
    expect(f.audit()).toEqual([]);
    expect(f.db.query("SELECT revision FROM messages WHERE id=?").get(m.id).revision).toBe(0);
    expect(f.db.query("SELECT * FROM idempotency_keys WHERE key='withdraw'").all()).toEqual([]);
    other.run(claimCommitted ? "COMMIT" : "ROLLBACK");
    expect(f.withdraw(m.id).recipients[0].status).toBe(claimCommitted ? "too_late" : "withdrawn");
  });
}

test("bounded public-operation orderings retain claim/withdraw/revision invariants", () => {
  const sequences = [];
  const visit = (prefix) => {
    if (prefix.length) {
      sequences.push(prefix);
    }
    if (prefix.length < 3) {
      for (const event of ["read", "ack", "withdraw", "promote", "noop", "preview"]) {
        visit([...prefix, event]);
      }
    }
  };
  visit([]);
  const violations = [];
  for (const sequence of sequences) {
    const f = fixture();
    const m = f.send();
    let claimed = false,
      withdrawn = false,
      rev = 0,
      level = "normal";
    const apply = (i, event) => {
      if (event === "read" || event === "ack") {
        if (withdrawn) {
          expect(() => f.claim(m.id, event === "ack")).toThrow();
        } else {
          f.claim(m.id, event === "ack");
          claimed = true;
        }
      }
      if (event === "withdraw") {
        const r = f.withdraw(m.id, { idempotency_key: `w-${i}` });
        expect(r.recipients[0].status).toBe(
          withdrawn ? "already_withdrawn" : claimed ? "too_late" : "withdrawn",
        );
        if (!withdrawn && !claimed) {
          withdrawn = true;
          rev++;
        }
      }
      if (event === "promote" || event === "noop") {
        const next = event === "promote" ? "urgent" : level;
        const r = f.change(m.id, {
          expected_revision: rev,
          importance: next,
          idempotency_key: `p-${i}`,
        });
        if (next !== level) {
          rev++;
        }
        level = next;
        expect(r.revision).toBe(rev);
      }
      if (event === "preview") {
        expect(f.inbox({ unread_only: false }).length).toBe(withdrawn ? 0 : 1);
      }
      const state = f.db.query("SELECT revision,importance FROM messages WHERE id=?").get(m.id);
      expect(state).toEqual({ revision: rev, importance: level });
      const receipt = f.db
        .query("SELECT read_ts,ack_ts,withdrawn_ts FROM message_recipients WHERE message_id=?")
        .get(m.id);
      expect(receipt.withdrawn_ts !== null).toBe(withdrawn);
      if (withdrawn) {
        expect(receipt.read_ts).toBeNull();
        expect(receipt.ack_ts).toBeNull();
      }
    };
    for (const [i, event] of sequence.entries()) {
      try {
        apply(i, event);
      } catch (e) {
        violations.push(sequence.join(" → ") + ": " + e.message);
        break;
      }
    }
    // Hundreds of independent in-memory databases do not remain open until afterEach.
    cleanups.pop()();
  }
  expect(sequences.length).toBe(258);
  expect(violations).toEqual([]);
});

test("HTTP/CLI mutation routing keeps explicit sender and revision choices", async () => {
  const directory = join(scratch, `cli-${++serial}`);
  mkdirSync(directory);
  const base = realpathSync.native(directory);
  spawnSync("git", ["init", "-q"], { cwd: base });
  const { server, db } = createServer(join(base, "mail.sqlite"), 0, { mutationsEnabled: true });
  cleanups.push(() => {
    server.stop(true);
    db.close();
  });
  const tools = createTools(db, {
    databasePath: join(base, "mail.sqlite"),
    mutationsEnabled: true,
  });
  for (const name of ["BlueLake", "GreenCastle"]) {
    tools.register_agent({ project_key: base, name, program: "x", model: "x" });
  }
  const m = tools.send_message({
    project_key: base,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "cli",
    body_md: "retained",
  });
  const env = { SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`, SWARMAIL_AGENT: "BlueLake" };
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const status = await mail(
      [
        "importance",
        String(m.id),
        "high",
        "--expected-revision",
        "0",
        "--idempotency-key",
        "cli-p",
        "--json",
      ],
      async () => "",
      env,
      base,
    );
    expect({ status, errors: error.mock.calls }).toEqual({ status: 0, errors: [] });
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toMatchObject({ importance: "high", revision: 1 });
    expect(
      await mail(
        ["withdraw", String(m.id), "--idempotency-key", "cli-w", "--recipients", "GreenCastle"],
        async () => "",
        env,
        base,
      ),
    ).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)[0]).recipients[0].status).toBe("withdrawn");
    expect(await mail(["withdraw", String(m.id)], async () => "", env, base)).toBe(1);
    expect(error.mock.calls.at(-1)[0]).toContain("idempotency-key");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
