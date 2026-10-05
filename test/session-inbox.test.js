import { Database } from "bun:sqlite";
import { createT3V2Tables, addT3V2Thread } from "./fixtures/t3-v2-state.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { call, mail } from "../src/mail.ts";
import { selfSession } from "../src/registry.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const root = testScratch();
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});
function fixture() {
  const { server, db } = createServer(join(root, `${crypto.randomUUID()}.sqlite`), 0);
  cleanups.push(() => {
    server.stop(true);
    db.close();
  });
  const env = {
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
  };
  const invoke = (name, args) => call(env, name, args);
  const register = async (project, name, tag) => {
    await invoke("register_agent", {
      project_key: project,
      name,
      program: "fixture",
      model: "fixture",
      task_description: tag,
    });
  };
  const send = async (project, to, subject = "mail") => {
    await register(project, "GoldMoose", "sender");
    return invoke("send_message", {
      project_key: project,
      sender_name: "GoldMoose",
      to,
      subject,
      body_md: "message body",
    });
  };
  const inbox = (args = {}) =>
    invoke("fetch_session_inbox", {
      host: "codex",
      session_id: "current",
      include_bodies: true,
      ...args,
    });
  return { db, env, invoke, register, send, inbox };
}

test("session inbox drains pages across projects without reading unrelated receipts", async () => {
  const f = fixture();
  await f.register("/fixture/a", "BlueLake", "[codex:current]");
  await f.register("/fixture/b", "GreenHill", "[codex:current]");
  await f.register("/fixture/c", "BlueLake", "[codex:other]");
  await f.register("/fixture/d", "BlueLake", "[claude:current]");
  await f.send("/fixture/a", ["BlueLake"], "a");
  await f.send("/fixture/b", ["GreenHill"], "b");
  await f.send("/fixture/c", ["BlueLake"], "other session");
  await f.send("/fixture/d", ["BlueLake"], "other host");
  const first = await f.inbox({ limit: 1 });
  const second = await f.inbox({ limit: 1 });
  expect(
    [...first, ...second].map(({ project_key, agent_name }) => [project_key, agent_name]),
  ).toEqual([
    ["/fixture/b", "GreenHill"],
    ["/fixture/a", "BlueLake"],
  ]);
  expect(await f.inbox({ limit: 1 })).toEqual([]);
  expect(
    f.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
  ).toBe(2);
  expect(Object.keys(first[0]).sort()).toEqual([
    "ack_required",
    "agent_name",
    "body_md",
    "created_ts",
    "from",
    "id",
    "importance",
    "project_key",
    "read_ts",
    "subject",
    "thread_id",
  ]);
});

test("T3 identity includes previous providers but excludes a conflicting T3 tag", async () => {
  const f = fixture();
  await f.register("/fixture/a", "WhiteBear", "[t3:thread-a codex:current]");
  await f.register("/fixture/b", "AmberCliff", "[t3:thread-a claude:previous]");
  await f.register("/fixture/c", "BlackHill", "[t3:thread-b codex:current]");
  await f.register("/fixture/d", "SilverDog", "[codex:current]");
  for (const [project, name] of [
    ["a", "WhiteBear"],
    ["b", "AmberCliff"],
    ["c", "BlackHill"],
    ["d", "SilverDog"],
  ]) {
    await f.send(`/fixture/${project}`, [name]);
  }
  expect((await f.inbox({ t3_thread: "thread-a" })).map((row) => row.agent_name).sort()).toEqual([
    "AmberCliff",
    "SilverDog",
    "WhiteBear",
  ]);
  expect(
    f.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
  ).toBe(1);
});

test("preview revives returned retired identities and read marking covers only returned recipients", async () => {
  const f = fixture();
  await f.register("/fixture/a", "BlueLake", "[codex:current]");
  await f.register("/fixture/a", "GreenHill", "[codex:current]");
  await f.register("/fixture/a", "TanGlen", "[codex:other]");
  const message = await f.send("/fixture/a", ["BlueLake", "GreenHill", "TanGlen"]);
  f.db.run("UPDATE agents SET retired_at = 1 WHERE name = 'GreenHill'");
  const preview = await f.inbox({ limit: 1, mark_read: false });
  expect(preview[0].agent_name).toBe("GreenHill");
  expect(preview[0]).not.toHaveProperty("read_ts");
  expect(
    f.db.query("SELECT retired_at FROM agents WHERE name = 'GreenHill'").get().retired_at,
  ).toBeNull();
  await f.inbox({ limit: 1 });
  expect(
    f.db
      .query(
        "SELECT count(*) AS n FROM message_recipients WHERE message_id = ? AND read_ts IS NULL",
      )
      .get(message.id).n,
  ).toBe(2);
  expect((await f.inbox()).map((row) => row.agent_name)).toEqual(["BlueLake"]);
  expect(await f.inbox()).toEqual([]);
});

test("session CLI discovers identity outside a repository, drains pages, and ignores name overrides", async () => {
  const f = fixture();
  await f.register("/fixture/a", "BlueLake", "[codex:current]");
  await f.register("/fixture/b", "GreenHill", "[codex:current]");
  await f.send("/fixture/a", ["BlueLake"]);
  await f.send("/fixture/b", ["GreenHill"]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      await mail(
        ["inbox", "--session", "--limit", "1", "--json"],
        async () => "",
        {
          ...f.env,
          CODEX_THREAD_ID: "current",
          SWARMAIL_AGENT: "Unrelated",
        },
        root,
      ),
    ).toBe(0);
    const pages = log.mock.calls.map(([text]) => JSON.parse(text));
    expect(pages.map((page) => page.length)).toEqual([1, 1, 0]);
    expect(
      pages
        .slice(0, -1)
        .flat()
        .map((row) => row.agent_name),
    ).toEqual(["GreenHill", "BlueLake"]);
    expect(await f.inbox()).toEqual([]);
  } finally {
    log.mockRestore();
  }
});

for (const flag of ["--peek", "--all"]) {
  test(`session CLI ${flag} returns a bounded preview rather than looping`, async () => {
    const f = fixture();
    await f.register("/fixture/a", "BlueLake", "[codex:current]");
    await f.send("/fixture/a", ["BlueLake"]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await mail(
          ["inbox", "--session", flag, "--json"],
          async () => "",
          { ...f.env, CODEX_THREAD_ID: "current" },
          root,
        ),
      ).toBe(0);
      expect(log.mock.calls).toHaveLength(1);
      expect(JSON.parse(log.mock.calls[0][0])).toHaveLength(1);
      expect(await f.inbox({ mark_read: false })).toHaveLength(flag === "--peek" ? 1 : 0);
    } finally {
      log.mockRestore();
    }
  });
}

function localState(dir, id, host, tags) {
  const path = join(dir, "swarmail-register");
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, `${id}.json`),
    JSON.stringify({ name: "BlueLake", projects: [], host, tags }),
  );
}
for (const host of ["devin", "opencode"]) {
  test(`${host} identity discovery requires one exact recorded process`, () => {
    const dir = join(root, crypto.randomUUID());
    const owner = { name: host, pid: 123, start: "start-a" };
    localState(dir, "native", owner, { a: `[${host}:native]` });
    const env = { HOME: root, XDG_STATE_HOME: dir };
    expect(selfSession(env, owner)).toEqual({ host, session_id: "native" });
    expect(() => selfSession(env, { ...owner, start: "start-b" })).toThrow("cannot identify");
    expect(() => selfSession(env, { ...owner, start: undefined })).toThrow("cannot identify");
    localState(dir, "other", owner, { b: `[${host}:other]` });
    expect(() => selfSession(env, owner)).toThrow("cannot identify");
  });
}

test("identity discovery rejects inherited variables and conflicting thread registrations", () => {
  expect(() =>
    selfSession({ CODEX_THREAD_ID: "current", CLAUDE_CODE_SESSION_ID: "other" }, null),
  ).toThrow("cannot identify");
  expect(() =>
    selfSession({ CLAUDE_CODE_SESSION_ID: "other" }, { name: "codex", pid: 1, start: "one" }),
  ).toThrow("cannot identify");
  const dir = join(root, crypto.randomUUID());
  const owner = { name: "codex", pid: 123, start: "start" };
  localState(dir, "current", owner, {
    a: "[t3:first codex:current]",
    b: "[t3:second codex:current]",
  });
  expect(() =>
    selfSession({ HOME: root, XDG_STATE_HOME: dir, CODEX_THREAD_ID: "current" }, owner),
  ).toThrow("cannot identify");
  expect(() => selfSession({}, null)).toThrow("cannot identify");
});

test("session inbox rejects malformed identities and limits", async () => {
  const f = fixture();
  for (const args of [
    { host: "" },
    { session_id: "bad/path" },
    { t3_thread: "bad/path" },
    { limit: 0 },
  ]) {
    await expect(f.inbox(args)).rejects.toThrow();
  }
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      await mail(["inbox", "--session", "--as", "BlueLake"], async () => "", f.env, root),
    ).toBe(1);
  } finally {
    err.mockRestore();
  }
});

function permutations(events) {
  if (!events.length) {
    return [[]];
  }
  return events.flatMap((event, i) =>
    permutations(events.filter((_, j) => i !== j)).map((tail) => [event, ...tail]),
  );
}

test("mail, re-registration and page reads preserve every session receipt in all event orders", async () => {
  for (const sequence of permutations(["mail-a", "mail-b", "rename", "read"])) {
    const f = fixture();
    await f.register("/fixture/a", "BlueLake", "[codex:current]");
    await f.register("/fixture/b", "BlueLake", "[codex:current]");
    await f.register("/fixture/other", "BlueLake", "[codex:other]");
    await f.send("/fixture/other", ["BlueLake"]);
    const sent = [],
      received = [];
    let name = "BlueLake";
    for (const event of sequence) {
      if (event.startsWith("mail-")) {
        const project = event.slice(-1);
        const message = await f.send(`/fixture/${project}`, [project === "a" ? name : "BlueLake"]);
        sent.push(message.id);
      } else if (event === "rename") {
        await f.register("/fixture/a", "GreenHill", "[codex:current]");
        name = "GreenHill";
      } else {
        received.push(...(await f.inbox({ limit: 1 })));
      }
    }
    for (;;) {
      const page = await f.inbox({ limit: 1 });
      if (!page.length) {
        break;
      }
      received.push(...page);
    }
    expect(received.map((message) => message.id).sort()).toEqual(sent.sort());
    expect(
      f.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
    ).toBe(1);
  }
});

test("session CLI uses a unique T3 provider match and refuses competing threads", async () => {
  const f = fixture();
  const home = join(root, crypto.randomUUID());
  mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
  const path = join(home, ".t3", "userdata", "statev2.sqlite");
  const t3 = new Database(path);
  cleanups.push(() => t3.close());
  createT3V2Tables(t3);
  addT3V2Thread(t3, { threadId: "foreign", nativeId: "current", driver: "claudeAgent" });
  await f.register("/fixture/a", "BlueLake", "[codex:current]");
  await f.register("/fixture/b", "GreenHill", "[t3:foreign claude:current]");
  await f.send("/fixture/a", ["BlueLake"]);
  await f.send("/fixture/b", ["GreenHill"]);
  const env = {
    ...f.env,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    CODEX_THREAD_ID: "current",
  };
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await mail(["inbox", "--session", "--json"], async () => "", env, home)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).map((row) => row.agent_name)).toEqual(["BlueLake"]);
    expect(
      f.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
    ).toBe(1);
    addT3V2Thread(t3, { threadId: "own", nativeId: "current", driver: "codex" });
    await f.register("/fixture/c", "SilverDog", "[t3:own claude:previous]");
    await f.send("/fixture/c", ["SilverDog"]);
    log.mockClear();
    expect(await mail(["inbox", "--session", "--json"], async () => "", env, home)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).map((row) => row.agent_name)).toEqual(["SilverDog"]);
    addT3V2Thread(t3, { threadId: "competing", nativeId: "current", driver: "codex" });
    await f.send("/fixture/c", ["SilverDog"]);
    expect(await mail(["inbox", "--session"], async () => "", env, home)).toBe(1);
    expect(error.mock.calls.at(-1)[0]).toContain("cannot identify");
    expect(
      f.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
    ).toBe(2);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
