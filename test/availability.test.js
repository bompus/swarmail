import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { openDatabase } from "../src/db.ts";
import { Lifecycle, sessionEligible } from "../src/lifecycle.ts";
import { MailStore } from "../src/store.ts";
import { createTools } from "../src/tools.ts";
import { createServer } from "../src/server.ts";
import { processIdentity } from "../src/proc.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
let serial = 0;
const close = [];
afterEach(() => {
  for (const fn of close.splice(0).reverse()) {
    fn();
  }
});
function fixture() {
  const base = join(scratch, String(++serial));
  const source = new Database(base + "-source.sqlite", { create: true });
  source.exec(`CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER);
    INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,1);
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE);
    INSERT INTO orchestration_events VALUES (1,'event-1');
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,archived_at TEXT,deleted_at TEXT,payload_json TEXT);
    INSERT INTO orchestration_v2_projection_threads VALUES ('thread-one',NULL,NULL,'{"settledAt":null,"settledOverride":null}');`);
  const path = base + "-mail.sqlite";
  const db = openDatabase(path);
  const config = {
    profile: "test-one",
    databasePath: base + "-source.sqlite",
    eventTable: "orchestration_events",
  };
  const lifecycle = new Lifecycle(db, config);
  const registry = base + "-registry";
  const tools = createTools(db, { databasePath: path, lifecycle, registry });
  const register = (name, tag = "") =>
    tools.register_agent({
      project_key: "/repo/one",
      name,
      program: "test",
      model: "test",
      task_description: tag,
    });
  register("BlueLake");
  register("GreenCastle", "[t3:thread-one codex:native-one]");
  register("TealDune");
  close.push(
    () => source.close(),
    () => db.close(),
  );
  let revision = 1;
  const state = (value) => {
    revision++;
    source.exec(
      `INSERT INTO orchestration_events VALUES (${revision},'event-${revision}'); UPDATE orchestration_v2_projection_metadata SET last_sequence=${revision};`,
    );
    source.query("UPDATE orchestration_v2_projection_threads SET archived_at=?,payload_json=?").run(
      value === "archived" ? "2026-10-06T00:00:00Z" : null,
      JSON.stringify({
        settledAt: value === "settled" ? "2026-10-06T00:00:00Z" : null,
        settledOverride: null,
      }),
    );
  };
  const args = {
    project_key: "/repo/one",
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "handoff",
    body_md: "information",
  };
  const send = (extra = {}) => tools.send_message({ ...args, ...extra });
  return { source, db, config, lifecycle, registry, tools, register, state, args, send, path };
}

test("fresh send admission rejects stale T3 state and mixed fanout before storage", () => {
  const f = fixture();
  f.state("archived");
  expect(f.db.query("SELECT state FROM session_lifecycle").get().state).toBe("active");
  let error;
  try {
    f.send({ to: ["TealDune", "GreenCastle", "MissingAgent"] });
  } catch (e) {
    error = e;
  }
  expect(error.type).toBe("NOT_FOUND");
  expect(error.data).toMatchObject({
    persisted: false,
    recipients: [
      { recipient: "GreenCastle", reason: "archived" },
      { recipient: "MissingAgent", reason: "unregistered" },
    ],
  });
  expect(f.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(0);
  expect(f.db.query("SELECT count(*) AS n FROM message_recipients").get().n).toBe(0);
  expect(f.db.query("SELECT count(*) AS n FROM wake_notices").get().n).toBe(0);
});

test("source loss holds bound delivery but unknown legacy mail stores with durable observations", () => {
  const f = fixture();
  f.source.exec("DROP TABLE orchestration_events");
  expect(() => f.send({ delivery_policy: "durable" })).toThrow("source_unavailable");
  const result = f.send({ to: ["TealDune"] });
  expect(result.delivery).toMatchObject({
    persisted: true,
    historical: false,
    recipients: [{ availability: "unknown", reason: "unbound_identity", wake: "unknown" }],
  });
  expect(result.delivery.warnings[0]).toContain("TealDune");
  const receipt = f.tools.get_message_delivery_receipt({
    project_key: "/repo/one",
    message_id: result.id,
  });
  expect(receipt.recipients[0]).toMatchObject({
    read_at: null,
    acknowledged: false,
    admission: { historical: true, availability: "unknown" },
  });
  const receiver = f.tools.fetch_inbox({
    project_key: "/repo/one",
    agent_name: "TealDune",
    include_bodies: true,
    mark_read: false,
  });
  expect(receiver[0].body_md).toBe("information");
  expect(receiver[0].delivery).toBeUndefined();
});

test("send and reply replay retain historical evidence after closure and never wake twice", () => {
  const f = fixture();
  const result = f.send({ idempotency_key: "send-once", bcc: ["TealDune"] });
  const replyArgs = {
    project_key: "/repo/one",
    sender_name: "GreenCastle",
    message_id: result.id,
    body_md: "accepted scope",
    idempotency_key: "reply-once",
  };
  const reply = f.tools.reply_message(replyArgs);
  const notices = f.db.query("SELECT * FROM wake_notices ORDER BY owner").all();
  f.state("settled");
  const replay = f.send({ idempotency_key: "send-once", bcc: ["TealDune"] });
  expect(replay.id).toBe(result.id);
  expect(replay.delivery).toMatchObject({
    historical: true,
    recipients: [{ lifecycle: "active" }, { availability: "unknown" }],
  });
  expect(f.tools.reply_message(replyArgs).id).toBe(reply.id);
  expect(() =>
    f.send({ idempotency_key: "send-once", bcc: ["TealDune"], delivery_policy: "durable" }),
  ).toThrow("different arguments");
  expect(f.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(2);
  expect(f.db.query("SELECT * FROM wake_notices ORDER BY owner").all()).toEqual(notices);
  const receiver = f.tools.fetch_inbox({
    project_key: "/repo/one",
    agent_name: "GreenCastle",
    mark_read: false,
  });
  expect(receiver[0].bcc).toBeUndefined();
  expect(receiver[0].delivery).toBeUndefined();
});

test("standalone process/end evidence stays unknown and is matched to exact identity", () => {
  const f = fixture();
  f.register("TealDune", "[codex:native-standalone]");
  mkdirSync(f.registry);
  const path = join(f.registry, "native-standalone.json");
  const data = {
    name: "TealDune",
    projects: ["/repo/one"],
    tags: { "/repo/one": "[codex:native-standalone]" },
    host: processIdentity(process.pid),
    ended: "2026-10-06T00:00:00Z",
  };
  writeFileSync(path, JSON.stringify(data));
  let result = f.send({ to: ["TealDune"] });
  expect(result.delivery.recipients[0]).toMatchObject({
    availability: "unknown",
    source: "registry",
    reason: "lifecycle_unqualified",
    reported_end_at: data.ended,
  });
  writeFileSync(
    path,
    JSON.stringify({ ...data, host: { ...data.host, start: "different-birth" } }),
  );
  result = f.send({ to: ["TealDune"], delivery_policy: "durable" });
  expect(result.delivery.recipients[0].process).toBe("unknown");
  writeFileSync(
    path,
    JSON.stringify({ ...data, tags: { "/repo/one": "[cursor:native-standalone]" } }),
  );
  expect(f.send({ to: ["TealDune"] }).delivery.recipients[0].source).toBe("registration");
});

test("registry evidence matches the name the session holds in that project", () => {
  const f = fixture();
  f.register("BlueHarbor", "[codex:native-standalone]");
  mkdirSync(f.registry);
  const path = join(f.registry, "native-standalone.json");
  const data = {
    name: "TealDune",
    names: { "/repo/one": "BlueHarbor" },
    projects: ["/repo/one"],
    tags: { "/repo/one": "[codex:native-standalone]" },
    host: processIdentity(process.pid),
    ended: "2026-10-06T00:00:00Z",
  };
  writeFileSync(path, JSON.stringify(data));
  expect(f.send({ to: ["BlueHarbor"] }).delivery.recipients[0]).toMatchObject({
    source: "registry",
    reason: "lifecycle_unqualified",
  });
});

test("direct Store delivery applies the same fresh boundary and receipts survive restart", () => {
  const f = fixture();
  const store = new MailStore(f.db, f.lifecycle, f.registry);
  const p = store.project("/repo/one");
  const sender = store.agent(p, "BlueLake");
  const result = store.atomic(() => store.deliver(p, sender, f.args));
  const db2 = openDatabase(f.path);
  close.push(() => db2.close());
  const tools2 = createTools(db2, {
    databasePath: f.path,
    lifecycle: new Lifecycle(db2, f.config),
  });
  expect(
    tools2.get_message_delivery_receipt({ project_key: "/repo/one", message_id: result.id })
      .recipients[0].admission.lifecycle,
  ).toBe("active");
  f.state("settled");
  expect(() => store.atomic(() => store.deliver(p, sender, f.args))).toThrow("settled");
  expect(() => tools2.send_message(f.args)).toThrow("settled");
});

test("a registered tag cannot make admission read outside the session registry", () => {
  const f = fixture();
  const tag = "[codex:../escaped-native]";
  f.register("TealDune", tag);
  mkdirSync(f.registry);
  writeFileSync(
    join(f.registry, "..", "escaped-native.json"),
    JSON.stringify({
      name: "TealDune",
      projects: ["/repo/one"],
      tags: { "/repo/one": tag },
      ended: "2026-10-06T00:00:00Z",
    }),
  );
  const observation = f.send({ to: ["TealDune"] }).delivery.recipients[0];
  expect(observation).toMatchObject({ source: "registration", availability: "unknown" });
  expect(observation.reported_end_at).toBeUndefined();
});

test("bounded send/closure/replay orderings preserve persistence and replay identity", () => {
  for (const sequence of ["CSC", "SCS", "CSS", "SSC", "CCS", "SCC", "CCC", "SSS"]) {
    const f = fixture();
    let sent;
    for (const event of sequence) {
      if (event === "C") {
        f.state("settled");
      } else {
        try {
          const result = f.send({ idempotency_key: "same" });
          sent ??= result.id;
          expect(result.id).toBe(sent);
        } catch (error) {
          expect(sent).toBeUndefined();
          expect(error.data.persisted).toBe(false);
        }
      }
      expect(f.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(sent ? 1 : 0);
    }
  }
});

test("another connection cannot change local identity or projection during admission", () => {
  const f = fixture();
  const other = openDatabase(f.path);
  close.push(() => other.close());
  other.exec("PRAGMA busy_timeout=0");
  const store = new MailStore(f.db, f.lifecycle, f.registry);
  const p = store.project("/repo/one");
  const sender = store.agent(p, "BlueLake");
  const original = store.agent.bind(store);
  const barrier = spyOn(store, "agent").mockImplementation((...args) => {
    expect(() => other.exec("UPDATE agents SET retired_at=1 WHERE name='GreenCastle'")).toThrow(
      "locked",
    );
    expect(() => other.exec("UPDATE session_lifecycle SET state='archived'")).toThrow("locked");
    return original(...args);
  });
  try {
    const sent = store.atomic(() => store.deliver(p, sender, f.args));
    expect(sent.delivery.recipients[0].lifecycle).toBe("active");
    expect(other.query("SELECT count(*) AS n FROM messages").get().n).toBe(1);
  } finally {
    barrier.mockRestore();
  }
  other.exec("UPDATE agents SET retired_at=1 WHERE name='GreenCastle'");
  expect(() => f.send()).toThrow("retired");
});

test("external settle after the snapshot is reported as snapshot eligibility, not confirmed wake", () => {
  const f = fixture();
  const store = new MailStore(f.db, f.lifecycle, f.registry);
  const p = store.project("/repo/one");
  const sender = store.agent(p, "BlueLake");
  const original = store.requireLifecycle.bind(store);
  const barrier = spyOn(store, "requireLifecycle").mockImplementation((who) => {
    original(who);
    f.state("settled");
  });
  let sent;
  try {
    sent = store.atomic(() => store.deliver(p, sender, f.args));
  } finally {
    barrier.mockRestore();
  }
  expect(sent.delivery.recipients[0]).toMatchObject({
    availability: "eligible",
    lifecycle: "active",
    wake: "unknown",
  });
  expect(f.lifecycle.reconcile().status).toBe("ready");
  expect(sessionEligible(f.db, "native-one")).toBe(false);
  expect(() => f.send()).toThrow("settled");
});

test("MCP reports bound source loss and unknown admission metadata", async () => {
  const f = fixture();
  const { server, db } = createServer(f.path, 0, { t3Lifecycle: f.config, registry: f.registry });
  close.push(() => {
    server.stop(true);
    db.close();
  });
  const call = async (extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send_message", arguments: { ...f.args, ...extra } },
      }),
    });
    return (await response.json()).result;
  };
  f.source.exec("DROP TABLE orchestration_events");
  const rejected = await call();
  expect(rejected.isError).toBe(true);
  expect(JSON.parse(rejected.content[0].text).error).toMatchObject({
    type: "RECIPIENT_STATE_UNKNOWN",
    data: { persisted: false },
  });
  const stored = await call({ to: ["TealDune"] });
  expect(JSON.parse(stored.content[0].text).delivery.recipients[0].availability).toBe("unknown");
});
