import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { Lifecycle, sessionEligible, type LifecycleConfig } from "../src/lifecycle.ts";
import type { Args, Row } from "../src/store.ts";
import { createTools } from "../src/tools.ts";
import { createServer } from "../src/server.ts";
import { createWaiters } from "../src/wake.ts";
import { openHookDelivery } from "../src/hook-delivery.ts";
import { BridgeError, sendT3Command } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.ts";

type Tools = Record<
  | "acknowledge_message"
  | "fetch_inbox"
  | "file_reservation_paths"
  | "list_agents"
  | "register_agent"
  | "release_file_reservations"
  | "retire_agent"
  | "send_message"
  | "set_message_importance"
  | "unretire_agent"
  | "withdraw_message",
  (a: Args) => any
>;

type WaitResult = Awaited<ReturnType<ReturnType<typeof createWaiters>["wait"]>>;
/** The offer a wait must have returned. */
function offered(result: WaitResult) {
  if (!result) {
    throw new Error(`expected a wake offer, got ${result}`);
  }
  return result;
}

const scratch = testScratch();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});
let serial = 0;
function fixture() {
  const prefix = join(scratch, String(++serial));
  const source = new Database(prefix + "-t3.sqlite", { create: true });
  cleanups.push(() => source.close());
  source.exec(`CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER);
    INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,1);
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE);
    CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE);
    INSERT INTO orchestration_events VALUES (1,'event-1');
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,archived_at TEXT,deleted_at TEXT,payload_json TEXT);
    INSERT INTO orchestration_v2_projection_threads VALUES ('thread-one',NULL,NULL,'{"settledAt":null,"settledOverride":null}');`);
  const db = openDatabase(prefix + "-mail.sqlite");
  cleanups.push(() => db.close());
  const config: LifecycleConfig = {
    profile: "local-one",
    databasePath: prefix + "-t3.sqlite",
    eventTable: "orchestration_events",
  };
  const lifecycle = new Lifecycle(db, config);
  const tools = createTools(db, { databasePath: prefix + "-mail.sqlite", lifecycle }) as Tools;
  const register = (
    name: string,
    tag = "[t3:thread-one codex:native-one]",
    project = "/repo/one",
  ) =>
    tools.register_agent({
      project_key: project,
      name,
      task_description: tag,
      program: "codex",
      model: "test",
    });
  register("BlueLake", "sender");
  register("GreenCastle");
  const transition = (sequence: number, state = "active", eventId = `event-${sequence}`) =>
    source.transaction(() => {
      source
        .query("INSERT OR REPLACE INTO orchestration_events VALUES (?,?)")
        .run(sequence, eventId);
      source.query("UPDATE orchestration_v2_projection_metadata SET last_sequence=?").run(sequence);
      source
        .query(
          "UPDATE orchestration_v2_projection_threads SET archived_at=?,deleted_at=?,payload_json=? WHERE thread_id=?",
        )
        .run(
          state === "archived" ? "2026-10-06T00:00:00Z" : null,
          state === "deleted" ? "2026-10-06T00:00:00Z" : null,
          JSON.stringify({
            settledAt: state === "settled" ? "2026-10-06T00:00:00Z" : null,
            settledOverride: null,
          }),
          "thread-one",
        );
    })();
  const send = (extra: Args = {}) =>
    tools.send_message({
      project_key: "/repo/one",
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject: "retained",
      body_md: "history",
      notification_policy: "wake",
      ...extra,
    });
  const roster = (): string[] =>
    tools.list_agents({ project_key: "/repo/one" }).map((row: Row) => row.name);
  return { db, source, config, lifecycle, tools, register, transition, send, roster, prefix };
}

test("closure rejects mail and claims but keeps exact identity, unread history and maintenance", () => {
  const f = fixture();
  const sent = f.send();
  f.tools.file_reservation_paths({
    project_key: "/repo/one",
    agent_name: "GreenCastle",
    paths: ["src/**"],
  });
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).toEqual(["BlueLake"]);
  expect(() => f.send({ importance: "urgent" })).toThrow("settled");
  expect(() =>
    f.tools.unretire_agent({ project_key: "/repo/one", agent_name: "GreenCastle" }),
  ).toThrow("lifecycle-inactive");
  expect(() =>
    f.tools.file_reservation_paths({
      project_key: "/repo/one",
      agent_name: "GreenCastle",
      paths: ["other"],
    }),
  ).toThrow("lifecycle-inactive");
  // Losing the hook's JSON/name and replacing the provider preserves identity, without reopening.
  expect(
    f.tools.register_agent({
      project_key: "/repo/one",
      program: "cursor",
      model: "test",
      task_description: "[t3:thread-one cursor:replacement]",
    }).name,
  ).toBe("GreenCastle");
  const inbox = f.tools.fetch_inbox({
    project_key: "/repo/one",
    agent_name: "GreenCastle",
    include_bodies: true,
  });
  expect(inbox[0].body_md).toBe("history");
  f.tools.acknowledge_message({
    project_key: "/repo/one",
    agent_name: "GreenCastle",
    message_id: inbox[0].id,
  });
  expect(
    f.tools.release_file_reservations({ project_key: "/repo/one", agent_name: "GreenCastle" })
      .released,
  ).toBe(1);
  expect(f.roster()).toEqual(["BlueLake"]);
  expect(() => f.register("GreenCastle", "[codex:wrong]")).toThrow("bound lifecycle identity");
  f.transition(3);
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).toContain("GreenCastle");
  expect(f.tools.fetch_inbox({ project_key: "/repo/one", agent_name: "GreenCastle" })[0].id).toBe(
    inbox[0].id,
  );
  expect(sent).toBeDefined();
});

test("bounded event orderings never revive a closed thread through activity or stale observations", () => {
  const events = ["settle2", "active3", "old1", "register", "read", "manual"];
  const failures: string[] = [];
  const f = fixture();
  f.source.run("PRAGMA journal_mode=WAL");
  f.source.run("PRAGMA synchronous=NORMAL");
  function run(sequence: string[]) {
    f.db.run("SAVEPOINT ordering");
    f.source.run("DELETE FROM orchestration_events");
    f.transition(1);
    let accepted = 1,
      closed = false;
    for (const event of sequence) {
      if (event === "settle2" || event === "active3" || event === "old1") {
        const n = event === "settle2" ? 2 : event === "active3" ? 3 : 1;
        f.transition(n, event === "settle2" ? "settled" : "active");
        const result = f.lifecycle.reconcile();
        if (n > accepted) {
          accepted = n;
          closed = event === "settle2";
          expect(result.status).toBe("ready");
        } else if (n < accepted) {
          expect(result.status).toBe("unavailable");
        }
      } else if (event === "register") {
        f.register("GreenCastle");
      } else if (event === "read") {
        f.tools.fetch_inbox({ project_key: "/repo/one", agent_name: "GreenCastle" });
      } else {
        f.tools.retire_agent({ project_key: "/repo/one", agent_name: "GreenCastle" });
        f.tools.fetch_inbox({ project_key: "/repo/one", agent_name: "GreenCastle" });
      }
      if (f.roster().includes("GreenCastle") === closed) {
        failures.push(sequence.join(" → "));
      }
    }
    f.db.run("ROLLBACK TO ordering");
    f.db.run("RELEASE ordering");
  }
  function walk(prefix: string[]) {
    if (prefix.length) {
      run(prefix);
    }
    if (prefix.length < 3) {
      for (const e of events) {
        walk([...prefix, e]);
      }
    }
  }
  walk([]);
  expect(failures).toEqual([]);
}, 15000);

test.each(["archived", "deleted"])(
  "%s remains closed on replay and unarchive cannot override settlement",
  (state) => {
    const f = fixture();
    f.transition(2, state);
    f.lifecycle.reconcile();
    const before = f.db.query("SELECT * FROM agents WHERE name=?").get("GreenCastle");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 0 });
    expect(f.db.query("SELECT * FROM agents WHERE name=?").get("GreenCastle")).toEqual(before);
    expect(() => f.send()).toThrow();
    f.transition(3, "settled");
    f.lifecycle.reconcile();
    expect(f.roster()).not.toContain("GreenCastle");
  },
);

test.each([
  "regress",
  "replace-equal",
  "replace-higher",
  "prune",
  "move",
  "missing-thread",
  "thread-json",
  "thread-schema",
  "schema",
  "equal-conflict",
])("source %s holds last verified state and cursor atomically", (failure) => {
  const f = fixture();
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  const cursor = f.db.query("SELECT * FROM lifecycle_sources").get();
  if (failure === "regress") {
    f.transition(1);
  }
  if (failure === "replace-equal") {
    f.source
      .query("UPDATE orchestration_events SET event_id=? WHERE sequence=2")
      .run("replacement");
    f.transition(2, "active", "replacement");
  }
  if (failure === "replace-higher") {
    f.source
      .query("UPDATE orchestration_events SET event_id=? WHERE sequence=2")
      .run("replacement");
    f.transition(9);
  }
  if (failure === "prune") {
    f.source.run("DELETE FROM orchestration_events WHERE sequence=2");
  }
  if (failure === "move") {
    f.source.run("UPDATE orchestration_events SET sequence=5 WHERE sequence=2");
    f.transition(6);
  }
  if (failure === "missing-thread") {
    f.source.run("DELETE FROM orchestration_v2_projection_threads");
  }
  if (failure === "thread-json" || failure === "thread-schema") {
    f.source
      .query("UPDATE orchestration_v2_projection_threads SET payload_json=?")
      .run(
        failure === "thread-json"
          ? "{"
          : JSON.stringify({ settledAt: null, settledOverride: "unknown" }),
      );
  }
  if (failure === "schema") {
    f.source.run("UPDATE orchestration_v2_projection_metadata SET schema_version=99");
  }
  if (failure === "equal-conflict") {
    f.transition(2);
  }
  expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
  expect(f.db.query("SELECT * FROM lifecycle_sources").get()).toEqual(cursor);
  expect(f.roster()).not.toContain("GreenCastle");
});

test.skipIf(process.platform !== "linux")(
  "an unchanged source skips the read and keeps the last result",
  () => {
    const f = fixture();
    f.lifecycle.reconcile();
    const reads = (f.lifecycle as unknown as { reads: number }).reads;
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 0 });
    expect((f.lifecycle as unknown as { reads: number }).reads).toBe(reads);
    f.transition(2, "settled");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
    expect((f.lifecycle as unknown as { reads: number }).reads).toBe(reads + 1);
  },
);

test.skipIf(process.platform !== "linux")(
  "a skip inside an outer transaction reuses the committed version",
  () => {
    const f = fixture();
    f.lifecycle.reconcile();
    const reads = (f.lifecycle as unknown as { reads: number }).reads;
    f.db.transaction(() => {
      expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 0 });
    })();
    expect((f.lifecycle as unknown as { reads: number }).reads).toBe(reads);
  },
);

test("a changed source is read again", () => {
  const f = fixture();
  f.lifecycle.reconcile();
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).toEqual(["BlueLake"]);
});

test("a WAL change is read again", () => {
  const f = fixture();
  f.source.run("PRAGMA journal_mode=WAL");
  f.lifecycle.reconcile();
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
});

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "revoking WAL read permission invalidates the gate",
  () => {
    const f = fixture();
    f.source.run("PRAGMA journal_mode=WAL");
    f.transition(2, "settled");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
    const wal = `${f.config.databasePath}-wal`;
    chmodSync(wal, 0o000);
    try {
      expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
    } finally {
      chmodSync(wal, 0o600);
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "a symlinked database fingerprints the target's WAL",
  () => {
    const f = fixture();
    const target = `${f.prefix}-target.sqlite`;
    f.source.close();
    renameSync(f.config.databasePath, target);
    symlinkSync(target, f.config.databasePath);
    const source = new Database(target, { create: false });
    source.run("PRAGMA journal_mode=WAL");
    source.transaction(() => {
      source.run("INSERT OR REPLACE INTO orchestration_events VALUES (2,'event-2')");
      source.run("UPDATE orchestration_v2_projection_metadata SET last_sequence=2");
      source
        .query(
          "UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='thread-one'",
        )
        .run(JSON.stringify({ settledAt: "2026-10-06T00:00:00Z", settledOverride: null }));
    })();
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
    const wal = `${target}-wal`;
    chmodSync(wal, 0o000);
    try {
      expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
    } finally {
      chmodSync(wal, 0o600);
      source.close();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "revoking shared-memory read permission invalidates the gate",
  async () => {
    const f = fixture();
    f.source.run("PRAGMA journal_mode=WAL");
    f.transition(2, "settled");
    // An external connection keeps the WAL and shared-memory files open without giving this
    // process a mapping the fresh read could reuse.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(process.argv[1]);
         console.log("ready");
         await new Promise((resolve) => {
           process.stdin.resume();
           process.stdin.once("end", resolve);
         });
         db.close();`,
        f.config.databasePath,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain("ready");
    f.source.close();
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
    const shm = `${f.config.databasePath}-shm`;
    chmodSync(shm, 0o000);
    try {
      expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
    } finally {
      chmodSync(shm, 0o600);
      await child.stdin.end();
      await child.exited;
    }
  },
);

test.skipIf(process.platform === "win32")("a missing source fails closed", () => {
  const f = fixture();
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  rmSync(f.config.databasePath);
  expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a permission error fails closed",
  () => {
    const f = fixture();
    f.transition(2, "settled");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
    chmodSync(f.config.databasePath, 0o000);
    try {
      expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
    } finally {
      chmodSync(f.config.databasePath, 0o600);
    }
  },
);

test.skipIf(process.platform === "win32")("a replaced source is read again", () => {
  const f = fixture();
  f.lifecycle.reconcile();
  const replacement = `${f.prefix}-replacement.sqlite`;
  const source = new Database(replacement, { create: true });
  source.exec(`CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER);
    INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,2);
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE);
    INSERT INTO orchestration_events VALUES (1,'event-1');
    INSERT INTO orchestration_events VALUES (2,'event-2');
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,archived_at TEXT,deleted_at TEXT,payload_json TEXT);
    INSERT INTO orchestration_v2_projection_threads VALUES ('thread-one',NULL,NULL,'{"settledAt":"2026-10-06T00:00:00Z","settledOverride":null}');`);
  source.close();
  renameSync(replacement, f.config.databasePath);
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).toEqual(["BlueLake"]);
});

test("a rolled-back admission does not cache the source", () => {
  const f = fixture();
  f.lifecycle.reconcile();
  f.transition(2, "settled");
  expect(() => f.send()).toThrow("settled");
  expect(() => f.send()).toThrow("settled");
});

test.skipIf(process.platform !== "linux")(
  "a dead gate connection falls back to the full read",
  () => {
    const f = fixture();
    f.source.run("PRAGMA journal_mode=WAL");
    f.lifecycle.reconcile();
    (f.lifecycle as unknown as { gate?: Database }).gate?.close();
    f.transition(2, "settled");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  },
);

test("the gate is off outside Linux and the full read still holds", () => {
  const f = fixture();
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  let lifecycle: Lifecycle;
  try {
    lifecycle = new Lifecycle(f.db, f.config);
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }
  expect((lifecycle as unknown as { gateEnabled: boolean }).gateEnabled).toBe(false);
  lifecycle.reconcile();
  expect((lifecycle as unknown as { gate?: Database }).gate).toBeUndefined();
  f.source.run("BEGIN EXCLUSIVE");
  try {
    expect(lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
  } finally {
    f.source.run("ROLLBACK");
  }
});

test("a saved anchor deleted by T3 history compaction does not stop tracking", () => {
  const f = fixture();
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  // A newer event of the same thread supersedes the anchor, then compaction deletes the anchor.
  f.transition(3);
  f.source.run("DELETE FROM orchestration_events WHERE sequence=2");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).toContain("GreenCastle");
  expect(f.db.query("SELECT sequence, event_id FROM lifecycle_sources").get()).toEqual({
    sequence: 3,
    event_id: "event-3",
  });
  f.transition(4, "archived");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
  expect(f.roster()).not.toContain("GreenCastle");
});

test("unrelated events update source cursor without identity or activity writes; multiple projects share lifecycle", () => {
  const f = fixture();
  f.register("GreenCastle", "[t3:thread-one grok:native-two]", "/repo/two");
  const rows = f.db.query("SELECT * FROM agents").all();
  const life = f.db.query("SELECT * FROM session_lifecycle").all();
  f.transition(20);
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 0 });
  expect(f.db.query("SELECT * FROM agents").all()).toEqual(rows);
  expect(f.db.query("SELECT * FROM session_lifecycle").all()).toEqual(life);
  f.transition(21, "settled");
  f.lifecycle.reconcile();
  expect(f.tools.list_agents({ project_key: "/repo/two" })).toEqual([]);
  // Another explicitly bound profile does not inherit the local thread's closure.
  f.db.run("INSERT INTO session_lifecycle VALUES ('other','thread-one','active',1)");
  f.db.run(
    "UPDATE agents SET lifecycle_profile='other' WHERE project_id=(SELECT id FROM projects WHERE human_key='/repo/two')",
  );
  expect(f.tools.list_agents({ project_key: "/repo/two" })[0].name).toBe("GreenCastle");
});

test("inactive waits cannot acknowledge an outstanding notice, and reopening coalesces retained mail", async () => {
  const f = fixture();
  f.send();
  const waiters = createWaiters(f.db, 10);
  const first = offered(await waiters.wait("thread-one", 0, undefined, { retry: true, after: 0 }));
  expect(first.hint).toContain("inbox --session");
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  expect(await waiters.wait("thread-one", 0, undefined, { after: first.eventId })).toBeNull();
  expect((f.db.query("SELECT announced FROM wake_cursors").get() as Row).announced).toBe(0);
  f.transition(3);
  f.lifecycle.reconcile();
  expect(
    offered(await waiters.wait("thread-one", 0, undefined, { retry: true, after: 0 })).eventId,
  ).toBe(first.eventId);
  expect((f.db.query("SELECT count(*) AS n FROM wake_notices").get() as Row).n).toBe(1);
});

test.each(["missing", "invalid-json", "unknown-state"])(
  "unverified %s registrations hold only their identity and recover when projected",
  async (failure) => {
    const f = fixture();
    if (failure !== "missing") {
      f.source
        .query("INSERT INTO orchestration_v2_projection_threads VALUES (?,NULL,NULL,?)")
        .run(
          "unverified-thread",
          failure === "invalid-json"
            ? "{"
            : JSON.stringify({ settledAt: null, settledOverride: "unknown" }),
        );
    }
    f.register("PinkFox", "[t3:unverified-thread codex:unverified-native]");
    expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 0 });
    expect(f.roster().sort()).toEqual(["BlueLake", "GreenCastle"]);
    expect(sessionEligible(f.db, "unverified-native")).toBe(false);
    expect(() =>
      f.tools.send_message({
        project_key: "/repo/one",
        sender_name: "BlueLake",
        to: ["PinkFox"],
        subject: "held",
        body_md: "mail",
      }),
    ).toThrow("identity_unverified");
    f.send();
    const app = createServer(f.prefix + "-mail.sqlite", 0, { t3Lifecycle: f.config });
    cleanups.push(() => {
      void app.server.stop(true);
      app.db.close();
    });
    const status = async (session: string) =>
      (await fetch(new URL(`/wait/status?session=${session}`, app.server.url))).json();
    expect(await status("native-one")).toEqual({ eligible: true });
    expect(await status("unverified-native")).toEqual({ eligible: false });
    const wake = await fetch(
      new URL("/wait?session=native-one&timeout=0&after=0&retry=1", app.server.url),
    );
    expect(wake.status).toBe(200);
    expect(await wake.text()).toContain("inbox --session");
    f.transition(2);
    f.source
      .query("INSERT OR REPLACE INTO orchestration_v2_projection_threads VALUES (?,NULL,NULL,?)")
      .run("unverified-thread", JSON.stringify({ settledAt: null, settledOverride: null }));
    expect(await status("unverified-native")).toEqual({ eligible: true });
    expect(f.roster()).toContain("PinkFox");
  },
);

test("initial source proof is required and the reconciliation HTTP boundary accepts no caller observations", async () => {
  const f = fixture();
  expect(() =>
    createServer(f.prefix + "-bad.sqlite", 0, {
      t3Lifecycle: { ...f.config, eventTable: "orchestration_v2_events" },
    }),
  ).toThrow("activation held");
  const app = createServer(f.prefix + "-http.sqlite", 0, { t3Lifecycle: f.config });
  cleanups.push(() => {
    void app.server.stop(true);
    app.db.close();
  });
  const base = app.server.url;
  const rejected = await fetch(new URL("/lifecycle/reconcile", base), {
    method: "POST",
    body: JSON.stringify({ state: "active", databasePath: "/untrusted" }),
  });
  expect(rejected.status).toBe(400);
  const result = await fetch(new URL("/lifecycle/reconcile", base), { method: "POST" });
  expect(await result.json()).toEqual({ status: "ready", changed: 0 });
  expect(await (await fetch(new URL("/wait/status?session=unknown", base))).json()).toEqual({
    eligible: false,
  });
  f.source.run("DROP TABLE orchestration_v2_projection_metadata");
  expect(
    await (await fetch(new URL("/lifecycle/reconcile", base), { method: "POST" })).json(),
  ).toEqual({ status: "unavailable", changed: 0 });
});

test("a held native hook offer does not consume its cursor before final lifecycle admission", async () => {
  const hook = openHookDelivery("lifecycle-hook", { XDG_STATE_HOME: scratch });
  cleanups.push(() => hook.close());
  const response = () =>
    new Response("Swarmail: Fetch all unread mail.", { headers: { "x-swarmail-event-id": "42" } });
  expect(
    hook.receive(response(), async () => {
      throw new BridgeError("held", true);
    }),
  ).rejects.toThrow("held");
  expect(hook.query()).toEndWith("after=0");
  expect(await hook.receive(response(), async () => {})).toContain("Fetch all");
  expect(hook.query()).toEndWith("after=42");
});

test("T3 final admission guard runs after websocket ticket and before RPC send", async () => {
  const received: (string | Buffer)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (new URL(req.url).pathname === "/ws") {
        return s.upgrade(req) ? undefined : new Response(null, { status: 400 });
      }
      return Response.json({ ticket: "fixture" });
    },
    websocket: {
      message(_ws, raw) {
        received.push(raw);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  // Authorization loading uses the same explicit file as real target admission.
  const { writeFileSync } = await import("node:fs");
  const auth = join(scratch, "auth");
  writeFileSync(auth, "Bearer fixture", { mode: 0o600 });
  expect(
    sendT3Command(
      { id: "thread-one", type: "t3-v2-queue", url: String(server.url), authorizationFile: auth },
      { type: "message.dispatch" },
      async () => {
        throw new BridgeError("inactive", true);
      },
    ),
  ).rejects.toThrow("inactive");
  expect(received).toEqual([]);
});

test("a failed cursor write rolls back every lifecycle transition and retains reservation ownership", () => {
  const f = fixture();
  f.tools.file_reservation_paths({
    project_key: "/repo/one",
    agent_name: "GreenCastle",
    paths: ["src/**"],
  });
  const before = f.db.query("SELECT * FROM file_reservations").all();
  f.db.exec(
    "CREATE TRIGGER reject_cursor BEFORE UPDATE ON lifecycle_sources BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  f.transition(2, "settled");
  expect(f.lifecycle.reconcile()).toEqual({ status: "unavailable", changed: 0 });
  expect(f.roster()).toContain("GreenCastle");
  expect((f.db.query("SELECT sequence FROM lifecycle_sources").get() as Row).sequence).toBe(1);
  expect(f.db.query("SELECT * FROM file_reservations").all()).toEqual(before);
  f.db.exec("DROP TRIGGER reject_cursor");
  expect(f.lifecycle.reconcile()).toEqual({ status: "ready", changed: 1 });
});

test("profile or database changes cannot silently rebind a retained source cursor", () => {
  const f = fixture();
  for (const config of [
    { ...f.config, profile: "replacement" },
    { ...f.config, databasePath: f.prefix + "-replacement.sqlite" },
  ]) {
    expect(new Lifecycle(f.db, config).reconcile()).toEqual({ status: "unavailable", changed: 0 });
  }
  expect(f.roster()).toContain("GreenCastle");
});

test("native-only aliases retain lifecycle and notice ownership across projects and provider replacement", async () => {
  const f = fixture();
  f.register("GreenCastle", "[codex:native-one]", "/repo/two");
  f.register("BlueLake", "sender", "/repo/two");
  const sendAlias = () =>
    f.tools.send_message({
      project_key: "/repo/two",
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject: "alias",
      body_md: "retained alias history",
    });
  sendAlias();
  const waiters = createWaiters(f.db, 10);
  const first = offered(await waiters.wait("native-one", 0, undefined, { retry: true, after: 0 }));
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  expect(f.tools.list_agents({ project_key: "/repo/two" }).map((a: Row) => a.name)).toEqual([
    "BlueLake",
  ]);
  expect(() => sendAlias()).toThrow("settled");
  expect(() =>
    f.tools.file_reservation_paths({
      project_key: "/repo/two",
      agent_name: "GreenCastle",
      paths: ["alias/**"],
    }),
  ).toThrow("lifecycle-inactive");
  f.register("GreenCastle", "[t3:thread-one cursor:replacement]");
  expect(sessionEligible(f.db, "native-one")).toBe(false);
  expect(await waiters.wait("native-one", 0, undefined, { retry: true, after: 0 })).toBeNull();
  f.transition(3);
  f.lifecycle.reconcile();
  expect(
    offered(await waiters.wait("native-one", 0, undefined, { retry: true, after: 0 })).eventId,
  ).toBe(first.eventId);
  expect((f.db.query("SELECT count(*) AS n FROM wake_notices").get() as Row).n).toBe(1);
  expect(
    f.tools.fetch_inbox({
      project_key: "/repo/two",
      agent_name: "GreenCastle",
      include_bodies: true,
    })[0].body_md,
  ).toBe("retained alias history");
});

test("project-specific manual retirement does not suppress another active mailbox", async () => {
  const f = fixture();
  f.register("GreenCastle", "[t3:thread-one codex:native-one]", "/repo/two");
  f.register("BlueLake", "sender", "/repo/two");
  f.tools.retire_agent({ project_key: "/repo/one", agent_name: "GreenCastle" });
  f.tools.send_message({
    project_key: "/repo/two",
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "active",
    body_md: "mail",
    notification_policy: "wake",
  });
  expect(sessionEligible(f.db, "native-one")).toBe(true);
  const waiters = createWaiters(f.db, 10);
  expect(
    offered(await waiters.wait("native-one", 0, undefined, { retry: true, after: 0 })).hint,
  ).toContain("inbox --session");
});

test("an unavailable T3 source holds bound delivery while standalone delivery continues", async () => {
  const f = fixture();
  const app = createServer(f.prefix + "-standalone.sqlite", 0, { t3Lifecycle: f.config });
  cleanups.push(() => {
    void app.server.stop(true);
    app.db.close();
  });
  const tools = createTools(app.db, {
    databasePath: f.prefix + "-standalone.sqlite",
    lifecycle: new Lifecycle(app.db, f.config),
  }) as Tools;
  const register = (name: string, tag: string) =>
    tools.register_agent({
      project_key: "/repo/one",
      name,
      program: "codex",
      model: "test",
      task_description: tag,
    });
  register("BlueLake", "sender");
  register("GreenCastle", "[t3:thread-one codex:native-one]");
  register("PinkFox", "[codex:standalone]");
  tools.send_message({
    project_key: "/repo/one",
    sender_name: "BlueLake",
    to: ["PinkFox"],
    subject: "standalone",
    body_md: "mail",
  });
  f.source.run("DROP TABLE orchestration_v2_projection_metadata");
  const status = async (session: string) =>
    (await fetch(new URL(`/wait/status?session=${session}`, app.server.url))).json();
  expect(await status("native-one")).toEqual({ eligible: false });
  expect(await status("standalone")).toEqual({ eligible: true });
  const wake = await fetch(
    new URL("/wait?session=standalone&timeout=0&after=0&retry=1", app.server.url),
  );
  expect(wake.status).toBe(200);
  expect(await wake.text()).toContain("inbox --session");
});

test("inactive long polls remain held without acknowledging until reopen or abort", async () => {
  const f = fixture();
  f.send();
  const waiters = createWaiters(f.db, 1000);
  const first = offered(await waiters.wait("thread-one", 0, undefined, { retry: true, after: 0 }));
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  const abort = new AbortController();
  let completed = false;
  const held = waiters
    .wait("thread-one", 10000, abort.signal, { after: first.eventId })
    .then((result) => {
      completed = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(completed).toBe(false);
  expect((f.db.query("SELECT announced FROM wake_cursors").get() as Row).announced).toBe(0);
  abort.abort();
  expect(await held).toBeNull();
  const reopened = waiters.wait("thread-one", 10000, undefined, { retry: true, after: 0 });
  f.transition(3);
  f.lifecycle.reconcile();
  waiters.notify();
  expect(offered(await reopened).eventId).toBe(first.eventId);
});

test("a reopen found by any server reconcile wakes held long polls", async () => {
  const f = fixture();
  f.send();
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  const app = createServer(f.prefix + "-mail.sqlite", 0, {
    t3Lifecycle: f.config,
    wakePollMs: 60_000,
  });
  cleanups.push(() => {
    void app.server.stop(true);
    app.db.close();
  });
  let completed = false;
  const held = fetch(new URL("/wait?session=thread-one&timeout=5&retry=1&after=0", app.server.url))
    .then((response) => response.text())
    .then((text) => {
      completed = true;
      return text;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(completed).toBe(false);
  f.transition(3);
  // The status check's reconcile applies the reopen, so no later reconcile reports the change.
  await fetch(new URL("/wait/status?session=native-one", app.server.url));
  expect(await held).toContain("inbox --session");
  expect(
    await (await fetch(new URL("/lifecycle/reconcile", app.server.url), { method: "POST" })).json(),
  ).toEqual({ status: "ready", changed: 0 });
});

test("a T3 source that becomes available again wakes held long polls", async () => {
  const f = fixture();
  f.send();
  const app = createServer(f.prefix + "-mail.sqlite", 0, {
    t3Lifecycle: f.config,
    wakePollMs: 60_000,
  });
  cleanups.push(() => {
    void app.server.stop(true);
    app.db.close();
  });
  f.source.run("ALTER TABLE orchestration_v2_projection_metadata RENAME TO held_metadata");
  let completed = false;
  const held = fetch(new URL("/wait?session=thread-one&timeout=5&retry=1&after=0", app.server.url))
    .then((response) => response.text())
    .then((text) => {
      completed = true;
      return text;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(completed).toBe(false);
  f.source.run("ALTER TABLE held_metadata RENAME TO orchestration_v2_projection_metadata");
  expect(
    await (await fetch(new URL("/lifecycle/reconcile", app.server.url), { method: "POST" })).json(),
  ).toEqual({ status: "ready", changed: 0 });
  expect(await held).toContain("inbox --session");
});

for (const state of ["settled", "archived", "deleted"]) {
  test(`withdrawal from a ${state} recipient neither reopens it nor resurrects mail on verified resume`, () => {
    const f = fixture();
    const sent = f.send();
    const tools = createTools(f.db, {
      databasePath: f.prefix + "-mail.sqlite",
      lifecycle: f.lifecycle,
      mutationsEnabled: true,
    }) as Tools;
    f.transition(2, state);
    const result = tools.withdraw_message({
      project_key: "/repo/one",
      sender_name: "BlueLake",
      message_id: sent.id,
      idempotency_key: "withdraw",
    });
    expect(result.recipients[0].status).toBe("withdrawn");
    expect(f.roster()).not.toContain("GreenCastle");
    expect((f.db.query("SELECT state FROM session_lifecycle").get() as Row).state).toBe(state);
    f.transition(3, "active");
    f.lifecycle.reconcile();
    expect(f.roster()).toContain("GreenCastle");
    expect(
      f.tools.fetch_inbox({
        project_key: "/repo/one",
        agent_name: "GreenCastle",
        unread_only: false,
        mark_read: false,
      }),
    ).toEqual([]);
  });
}

test("mutation replay precedes sender lifecycle closure; fresh mutations fail and source loss is held", () => {
  const f = fixture();
  const sent = f.send();
  f.register("BlueLake");
  const tools = createTools(f.db, {
    databasePath: f.prefix + "-mail.sqlite",
    lifecycle: f.lifecycle,
    mutationsEnabled: true,
  }) as Tools;
  const args = {
    project_key: "/repo/one",
    sender_name: "BlueLake",
    message_id: sent.id,
    importance: "urgent",
    expected_revision: 0,
    idempotency_key: "edit",
  };
  const first = tools.set_message_importance(args);
  f.transition(2, "settled");
  f.lifecycle.reconcile();
  expect(tools.set_message_importance(args)).toEqual({ ...first, idempotent_replay: true });
  expect(() => tools.withdraw_message({ ...args, idempotency_key: "new" })).toThrow(
    "lifecycle-inactive",
  );
  f.transition(3, "active");
  f.lifecycle.reconcile();
  f.source.exec("DROP TABLE orchestration_events");
  expect(() => tools.withdraw_message({ ...args, idempotency_key: "unavailable" })).toThrow(
    "source is unavailable",
  );
  expect(
    (
      f.db
        .query("SELECT withdrawn_ts FROM message_recipients WHERE message_id=?")
        .get(sent.id) as Row
    ).withdrawn_ts,
  ).toBeNull();
  expect((f.db.query("SELECT count(*) AS n FROM message_mutations").get() as Row).n).toBe(1);
});

/** What T3's thread row means, as the code read it when it parsed the whole payload in JavaScript. */
function parsedState(archivedAt: unknown, deletedAt: unknown, payloadJson: unknown): string | null {
  try {
    const payload = JSON.parse(payloadJson as string);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    for (const value of [archivedAt, deletedAt, payload.settledAt]) {
      if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
        return null;
      }
    }
    if (![null, "active", "settled"].includes(payload.settledOverride)) {
      return null;
    }
    if (deletedAt !== null) {
      return "deleted";
    }
    if (archivedAt !== null) {
      return "archived";
    }
    return payload.settledOverride === "settled" || payload.settledAt !== null
      ? "settled"
      : "active";
  } catch {
    return null;
  }
}

const THEN = "2026-10-06T00:00:00Z";
const projections: [string, { archived?: string; deleted?: string; payload: unknown }][] = [
  ["open", { payload: { settledAt: null, settledOverride: null } }],
  ["settled by time", { payload: { settledAt: THEN, settledOverride: null } }],
  ["settled by override", { payload: { settledAt: null, settledOverride: "settled" } }],
  ["reopened override", { payload: { settledAt: THEN, settledOverride: "active" } }],
  ["archived", { archived: THEN, payload: { settledAt: null, settledOverride: null } }],
  ["deleted", { deleted: THEN, payload: { settledAt: null, settledOverride: null } }],
  [
    "deleted and archived",
    { archived: THEN, deleted: THEN, payload: { settledAt: THEN, settledOverride: "settled" } },
  ],
  [
    "unrelated fields",
    {
      payload: {
        settledAt: null,
        settledOverride: null,
        title: "é\u0000😀",
        nested: { settledAt: THEN },
        list: [1, 2, 3],
      },
    },
  ],
  ["only a nested settledAt", { payload: { nested: { settledAt: null }, settledOverride: null } }],
  ["escaped key name", { payload: '{"settled\\u0041t":null,"settledOverride":null}' }],
  ["padded with whitespace", { payload: ' \n{"settledAt":null,"settledOverride":null}\t' }],
  ["settledAt missing", { payload: { settledOverride: null } }],
  ["settledOverride missing", { payload: { settledAt: null } }],
  ["settledAt not a date", { payload: { settledAt: "soon", settledOverride: null } }],
  ["settledAt a number", { payload: { settledAt: 1, settledOverride: null } }],
  ["settledAt a boolean", { payload: { settledAt: true, settledOverride: null } }],
  ["settledAt an object", { payload: { settledAt: {}, settledOverride: null } }],
  ["settledAt too large for a number", { payload: '{"settledAt":1e999,"settledOverride":null}' }],
  ["settledOverride unknown", { payload: { settledAt: null, settledOverride: "unknown" } }],
  ["settledOverride a number", { payload: { settledAt: null, settledOverride: 0 } }],
  ["settledOverride an array", { payload: { settledAt: null, settledOverride: [] } }],
  [
    "archived_at not a date",
    { archived: "later", payload: { settledAt: null, settledOverride: null } },
  ],
  ["deleted_at not a date", { deleted: "", payload: { settledAt: null, settledOverride: null } }],
  ["truncated JSON", { payload: "{" }],
  ["empty text", { payload: "" }],
  ["trailing comma", { payload: '{"settledAt":null,"settledOverride":null,}' }],
  ["unquoted key", { payload: '{settledAt:null,"settledOverride":null}' }],
  ["JSON array", { payload: "[]" }],
  ["JSON null", { payload: "null" }],
  ["JSON number", { payload: "1" }],
  ["JSON string", { payload: '"settledAt"' }],
  ["SQL NULL", { payload: null }],
  [
    "BLOB holding JSON text",
    { payload: new Uint8Array(Buffer.from('{"settledAt":null,"settledOverride":null}')) },
  ],
  ["integer", { payload: 7 }],
];

test.each(projections)(
  "a thread row reads as it did when the whole payload was parsed: %s",
  (_name, { archived, deleted, payload }) => {
    const payloadJson =
      typeof payload === "object" && !(payload instanceof Uint8Array) && payload !== null
        ? JSON.stringify(payload)
        : payload;
    const expected = parsedState(archived ?? null, deleted ?? null, payloadJson);
    for (const verified of [false, true]) {
      const f = fixture();
      if (!verified) {
        // Registering recorded the thread's lifecycle, which makes it verified: an unreadable row then holds the
        // whole profile. Without that record the row holds only its own thread.
        f.db.run("DELETE FROM session_lifecycle");
      }
      f.source
        .query(
          "UPDATE orchestration_v2_projection_threads SET archived_at=?,deleted_at=?,payload_json=?",
        )
        .run(archived ?? null, deleted ?? null, payloadJson as string);
      // A changed state arrives with a newer event, as T3 writes it.
      f.source.run("INSERT INTO orchestration_events VALUES (2,'event-2')");
      f.source.run("UPDATE orchestration_v2_projection_metadata SET last_sequence=2");
      const result = f.lifecycle.reconcile();
      const recorded = f.db
        .query("SELECT state FROM session_lifecycle WHERE thread_id='thread-one'")
        .get() as { state: string } | null;
      if (expected === null) {
        expect(result).toEqual(
          verified ? { status: "unavailable", changed: 0 } : { status: "ready", changed: 0 },
        );
        expect(recorded?.state).toBe(verified ? "active" : undefined);
      } else {
        expect(result).toEqual({
          status: "ready",
          changed: verified && expected === "active" ? 0 : 1,
        });
        expect(recorded?.state).toBe(expected);
      }
    }
  },
);
