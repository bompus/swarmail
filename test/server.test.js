import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { addT3V2Thread, createT3V2Tables } from "./fixtures/t3-v2-state.js";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, pruneGoneProjects, retireIdleAgents } from "../src/server.ts";
import { iso, openDatabase, parseIso } from "../src/db.ts";

const P = "/w/project";
let dir, server, db, url;

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-server-")));
  ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
  url = `http://127.0.0.1:${server.port}/mcp/`;
});
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  return (await res.json()).result;
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const value = JSON.parse(r.content[0].text);
  if (r.isError) {
    throw Object.assign(new Error(value.error.message), value.error);
  }
  return value;
}
const register = (name, program = "claude-code") =>
  call("register_agent", { project_key: P, program, model: "m", name });
const messageCount = () => db.query("SELECT count(*) AS n FROM messages").get().n;

test("negotiates the client's protocol version and lists the available tools", async () => {
  expect((await rpc("initialize", { protocolVersion: "2024-11-05" })).protocolVersion).toBe(
    "2024-11-05",
  );
  expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).protocolVersion).toBe(
    "2025-11-25",
  );
  expect((await rpc("tools/list", {})).tools.map((t) => t.name).sort()).toEqual([
    "acknowledge_message",
    "ensure_project",
    "fetch_inbox",
    "file_reservation_paths",
    "get_message_delivery_receipt",
    "health_check",
    "list_agents",
    "macro_start_session",
    "mark_message_read",
    "register_agent",
    "release_file_reservations",
    "renew_file_reservations",
    "reply_message",
    "retire_agent",
    "search_messages",
    "send_message",
    "summarize_thread",
    "unretire_agent",
    "whois",
  ]);
});

test("tools annotated read-only write nothing", async () => {
  await register("ReaderOne");
  await register("ReaderTwo");
  const { id } = await call("send_message", {
    project_key: P,
    sender_name: "ReaderOne",
    to: ["ReaderTwo"],
    subject: "Readonly probe",
    body_md: "probe",
  });
  const args = {
    health_check: {},
    whois: { project_key: P, agent_name: "ReaderTwo" },
    list_agents: { project_key: P },
    get_message_delivery_receipt: { project_key: P, message_id: id },
    search_messages: { project_key: P, query: "probe" },
    summarize_thread: { project_key: P, thread_id: String(id) },
  };
  const readOnly = (await rpc("tools/list", {})).tools
    .filter((t) => t.annotations?.readOnlyHint)
    .map((t) => t.name);
  expect(readOnly.toSorted()).toEqual(Object.keys(args).toSorted());
  const changes = () => db.query("SELECT total_changes() AS n").get().n;
  const before = changes();
  for (const name of readOnly) {
    await call(name, args[name]);
  }
  expect(changes()).toBe(before);
});

// Glama's TDQS score and agents both read these: a missing hint or parameter description costs a tool its grade.
test("every tool declares its hints and describes every parameter", async () => {
  for (const t of (await rpc("tools/list", {})).tools) {
    expect([t.name, t.annotations?.openWorldHint]).toEqual([t.name, false]);
    expect([t.name, typeof t.annotations.readOnlyHint]).toEqual([t.name, "boolean"]);
    if (!t.annotations.readOnlyHint) {
      expect([t.name, typeof t.annotations.destructiveHint]).toEqual([t.name, "boolean"]);
      expect([t.name, typeof t.annotations.idempotentHint]).toEqual([t.name, "boolean"]);
    }
    const undescribed = Object.entries(t.inputSchema.properties)
      .filter(([, p]) => !p.description)
      .map(([k]) => k);
    expect([t.name, undescribed]).toEqual([t.name, []]);
  }
});

test("health_check fails when the database does not answer", async () => {
  const own = createServer(join(dir, "closed.sqlite3"), 0, { retireIdleDays: 0 });
  try {
    own.db.close();
    const res = await fetch(`http://127.0.0.1:${own.server.port}/mcp/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "health_check", arguments: {} },
      }),
    });
    const { result } = await res.json();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.type).toBe("INTERNAL");
  } finally {
    own.server.stop(true);
  }
});

test("a message is delivered, marked read on fetch, and acknowledged", async () => {
  await register("BlueLake");
  await register("GreenCastle", "codex");
  const sent = await call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "Hello",
    body_md: "Body text",
    ack_required: true,
  });
  const id = sent.id;

  const [first] = await call("fetch_inbox", {
    project_key: P,
    agent_name: "GreenCastle",
    include_bodies: true,
  });
  expect(first).toMatchObject({
    id,
    from: "BlueLake",
    subject: "Hello",
    body_md: "Body text",
    ack_required: true,
  });
  expect(first.read_ts).toBeString();
  expect(
    await call("fetch_inbox", { project_key: P, agent_name: "GreenCastle", unread_only: true }),
  ).toEqual([]);

  await call("acknowledge_message", { project_key: P, agent_name: "GreenCastle", message_id: id });
  const receipt = await call("get_message_delivery_receipt", { project_key: P, message_id: id });
  expect(receipt.recipients).toEqual([
    expect.objectContaining({
      recipient: "GreenCastle",
      acknowledged: true,
      read_at: first.read_ts,
    }),
  ]);
});

test("fetch_inbox with mark_read false leaves messages unread", async () => {
  await call("send_message", {
    project_key: P,
    sender_name: "GreenCastle",
    to: ["BlueLake"],
    subject: "Peek",
    body_md: "x",
  });
  await call("fetch_inbox", { project_key: P, agent_name: "BlueLake", mark_read: false });
  const unread = await call("fetch_inbox", {
    project_key: P,
    agent_name: "BlueLake",
    unread_only: true,
  });
  expect(unread.map((m) => m.subject)).toEqual(["Peek"]);
});

test("fetch_inbox returns the newest messages first, up to the limit", async () => {
  for (const subject of ["Older", "Middle", "Newest"]) {
    await call("send_message", {
      project_key: P,
      sender_name: "GreenCastle",
      to: ["BlueLake"],
      subject,
      body_md: "x",
    });
  }
  const inbox = await call("fetch_inbox", {
    project_key: P,
    agent_name: "BlueLake",
    limit: 2,
    mark_read: false,
  });
  expect(inbox.map((m) => m.subject)).toEqual(["Newest", "Middle"]);
});

test("an unknown recipient fails the whole send", async () => {
  const before = messageCount();
  await expect(
    call("send_message", {
      project_key: P,
      sender_name: "BlueLake",
      to: ["GreenCastle", "NoSuchAgent"],
      subject: "x",
      body_md: "y",
    }),
  ).rejects.toMatchObject({ type: "NOT_FOUND" });
  expect(messageCount()).toBe(before);
});

test("a repeated idempotency key replays the first send; reusing it for another message is a conflict", async () => {
  const args = {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "Once",
    body_md: "y",
    idempotency_key: "k1",
  };
  const before = messageCount();
  const a = await call("send_message", args);
  const b = await call("send_message", args);
  expect(b.id).toBe(a.id);
  expect(b.idempotent_replay).toBe(true);
  expect(messageCount()).toBe(before + 1);
  await expect(
    call("send_message", { ...args, body_md: "a different message" }),
  ).rejects.toMatchObject({
    type: "IDEMPOTENCY_KEY_CONFLICT",
  });
  expect(messageCount()).toBe(before + 1);
});

test("durable message retries preserve identity across restart orderings", async () => {
  const events = ["retry", "conflict", "ack", "restart"];
  const sequences = [[]];
  for (let depth = 0; depth < 2; depth++) {
    for (const prefix of sequences.filter((sequence) => sequence.length === depth)) {
      for (const event of events) {
        sequences.push([...prefix, event]);
      }
    }
  }
  const violations = [];
  let trial = 0;
  const cases = ["send_message", "reply_message"].flatMap((tool) =>
    sequences.map((sequence) => ({ tool, sequence })),
  );
  for (const { tool, sequence } of cases) {
    const path = join(dir, `retry-${trial++}.sqlite3`);
    let runtime = createServer(path, 0, { retireIdleDays: 0 });
    const invoke = async (name, args) => {
      const response = await fetch(`http://127.0.0.1:${runtime.server.port}/mcp/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const result = (await response.json()).result;
      const value = JSON.parse(result.content[0].text);
      if (result.isError) {
        throw Object.assign(new Error(value.error.message), value.error);
      }
      return value;
    };
    const restart = () => {
      runtime.server.stop(true);
      runtime.db.close();
      runtime = createServer(path, 0, { retireIdleDays: 0 });
    };
    try {
      for (const name of ["BlueLake", "GreenCastle"]) {
        await invoke("register_agent", { project_key: P, program: "test", model: "m", name });
      }
      const send = {
        project_key: P,
        sender_name: "BlueLake",
        to: ["GreenCastle"],
        subject: "Once",
        body_md: "body",
        ack_required: true,
      };
      const original = tool === "reply_message" ? await invoke("send_message", send) : null;
      const args = {
        ...(tool === "send_message"
          ? send
          : {
              project_key: P,
              message_id: original.id,
              sender_name: "GreenCastle",
              body_md: "answer",
            }),
        idempotency_key: "durable-key",
      };
      const expected = await invoke(tool, args);
      const key = runtime.db
        .query("SELECT tool,agent_id,key,fingerprint,created_ts FROM idempotency_keys")
        .get();
      const message = runtime.db.query("SELECT * FROM messages WHERE id=?").get(expected.id);
      const receiver = tool === "send_message" ? "GreenCastle" : "BlueLake";
      let acknowledged = false;
      restart();
      const check = async () => {
        expect(await invoke(tool, args)).toEqual({ ...expected, idempotent_replay: true });
        expect(runtime.db.query("SELECT count(*) AS n FROM messages").get().n).toBe(
          original ? 2 : 1,
        );
        expect(runtime.db.query("SELECT count(*) AS n FROM message_recipients").get().n).toBe(
          original ? 2 : 1,
        );
        expect(
          runtime.db
            .query("SELECT tool,agent_id,key,fingerprint,created_ts FROM idempotency_keys")
            .all(),
        ).toEqual([key]);
        expect(runtime.db.query("SELECT * FROM messages WHERE id=?").get(expected.id)).toEqual(
          message,
        );
        const receipt = await invoke("get_message_delivery_receipt", {
          project_key: P,
          message_id: expected.id,
        });
        expect(receipt.recipients[0].acknowledged).toBe(acknowledged);
      };
      await check();
      for (const event of sequence) {
        if (event === "restart") {
          restart();
        } else if (event === "ack") {
          await invoke("acknowledge_message", {
            project_key: P,
            agent_name: receiver,
            message_id: expected.id,
          });
          acknowledged = true;
        } else if (event === "conflict") {
          await expect(invoke(tool, { ...args, body_md: "different" })).rejects.toMatchObject({
            type: "IDEMPOTENCY_KEY_CONFLICT",
          });
        } else {
          await invoke(tool, args);
        }
        await check();
      }
    } catch (error) {
      violations.push(`${tool}: ${sequence.join(" -> ") || "initial reopen"}: ${error.message}`);
    } finally {
      runtime.server.stop(true);
      runtime.db.close();
    }
  }
  expect(violations).toEqual([]);
}, 30_000);

test("broadcast stays rejected and a retired agent receives nothing", async () => {
  await expect(
    call("send_message", {
      project_key: P,
      sender_name: "BlueLake",
      to: [],
      broadcast: true,
      subject: "x",
      body_md: "y",
    }),
  ).rejects.toMatchObject({ type: "INVALID_ARGUMENT" });
  await register("PlumPond");
  await call("retire_agent", { project_key: P, agent_name: "PlumPond" });
  await expect(
    call("send_message", {
      project_key: P,
      sender_name: "BlueLake",
      to: ["PlumPond"],
      subject: "x",
      body_md: "y",
    }),
  ).rejects.toMatchObject({ type: "NOT_FOUND" });
});

test("an idle agent is retired and comes back when it acts", async () => {
  await register("IdleOwl");
  const week = 7 * 86_400_000_000;
  db.run("UPDATE agents SET last_active_ts = last_active_ts - ? WHERE name = 'IdleOwl'", [
    week + 1,
  ]);
  expect(retireIdleAgents(db, 7)).toBe(1);
  const send = () =>
    call("send_message", {
      project_key: P,
      sender_name: "BlueLake",
      to: ["IdleOwl"],
      subject: "x",
      body_md: "y",
    });
  await expect(send()).rejects.toMatchObject({ type: "NOT_FOUND" });
  await call("fetch_inbox", { project_key: P, agent_name: "IdleOwl" });
  await send();
  expect(retireIdleAgents(db, 7)).toBe(0);
});

test("a gone checkout under home with no mail is deregistered; mail, a live path or recent use keeps it", async () => {
  const at = (project_key, name) =>
    call("register_agent", { project_key, program: "claude-code", model: "m", name });
  await at("/h/gone", "GoneOwl");
  await at("/h/mailed", "MailOwl");
  await at("/h/mailed", "MailFox");
  await at("/h/here", "HereOwl");
  await at("/x/gone", "AwayOwl");
  await at("/h/fresh", "FreshOwl");
  await call("send_message", {
    project_key: "/h/mailed",
    sender_name: "MailOwl",
    to: ["MailFox"],
    subject: "x",
    body_md: "y",
  });
  db.run("UPDATE agents SET last_active_ts = last_active_ts - ? WHERE name != 'FreshOwl'", [
    2 * 86_400_000_000,
  ]);
  const keys = () => db.query("SELECT human_key FROM projects WHERE human_key LIKE '/_/%'").all();
  const opts = { home: "/h", exists: (path) => path === "/h/here" };
  expect(pruneGoneProjects(db, opts)).toBe(1);
  expect(keys().map((p) => p.human_key)).not.toContain("/h/gone");
  expect(keys().map((p) => p.human_key)).toEqual(
    expect.arrayContaining(["/h/mailed", "/h/here", "/x/gone", "/h/fresh"]),
  );
  expect(db.query("SELECT count(*) AS n FROM agents WHERE name = 'GoneOwl'").get().n).toBe(0);
  expect(pruneGoneProjects(db, opts)).toBe(0);
  await at("/h/gone", "GoneOwl");
});

test("since_ts takes a server timestamp back and a malformed one is a recoverable argument error", async () => {
  const sent = await call("send_message", {
    project_key: P,
    sender_name: "GreenCastle",
    to: ["BlueLake"],
    subject: "Tick",
    body_md: "t",
  });
  const created = sent.created_ts;
  expect(iso(parseIso(created))).toBe(created);
  const after = await call("send_message", {
    project_key: P,
    sender_name: "GreenCastle",
    to: ["BlueLake"],
    subject: "Tock",
    body_md: "t",
  });
  const newer = await call("fetch_inbox", {
    project_key: P,
    agent_name: "BlueLake",
    since_ts: created,
    mark_read: false,
  });
  expect(newer.map((m) => m.id)).toEqual([after.id]);
  await expect(
    call("fetch_inbox", { project_key: P, agent_name: "BlueLake", since_ts: "yesterday" }),
  ).rejects.toMatchObject({
    type: "INVALID_ARGUMENT",
    recoverable: true,
  });
});

test("a reply joins the original's thread and defaults to its sender", async () => {
  const sent = await call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "Question",
    body_md: "Which port?",
    topic: "ports",
    importance: "high",
  });
  const id = sent.id;
  const reply = await call("reply_message", {
    project_key: P,
    message_id: id,
    sender_name: "GreenCastle",
    body_md: "18766",
  });
  expect(reply).toMatchObject({
    thread_id: String(id),
    subject: "Re: Question",
    to: ["BlueLake"],
    topic: "ports",
    importance: "high",
    reply_to: id,
  });
  const thread = await call("summarize_thread", { project_key: P, thread_id: String(id) });
  expect(thread.messages.map((m) => m.body_md)).toEqual(["Which port?", "18766"]);
  expect(thread.summary.participants).toEqual(["BlueLake", "GreenCastle"]);
});

test("search finds words in bodies, best match first, and pages with a cursor", async () => {
  const messages = [];
  for (const [subject, body] of [
    ["Zebra notes", "nothing"],
    ["Other", "a zebra in the body"],
    ["Third", "zebra zebra"],
  ]) {
    messages.push(
      await call("send_message", {
        project_key: P,
        sender_name: "BlueLake",
        to: ["GreenCastle"],
        subject,
        body_md: body,
      }),
    );
  }
  const page = await call("search_messages", { project_key: P, query: "zebra", limit: 2 });
  expect(page.result[0].subject).toBe("Zebra notes");
  const rest = await call("search_messages", {
    project_key: P,
    query: "zebra",
    limit: 2,
    cursor: page.next_cursor,
  });
  expect([...page.result, ...rest.result].map((m) => m.subject).sort()).toEqual([
    "Other",
    "Third",
    "Zebra notes",
  ]);
  expect(rest.next_cursor).toBeUndefined();
  const filtered = await call("search_messages", {
    project_key: P,
    query: "zebra",
    sender_name: "BlueLake",
    since: messages[1].created_ts,
    until: messages[1].created_ts,
  });
  expect(filtered.result.map((m) => m.id)).toEqual([messages[1].id]);
  const day = await call("search_messages", {
    project_key: P,
    query: "zebra",
    until: messages[2].created_ts.slice(0, 10),
  });
  expect(day.result.map((m) => m.id).sort()).toEqual(messages.map((m) => m.id).sort());
  expect(
    (await call("search_messages", { project_key: P, query: "zebra", sender_name: "GreenCastle" }))
      .result,
  ).toEqual([]);
});

test("search excerpts show late and subject-only matches without returning full bodies", async () => {
  const body = "ordinary text ".repeat(8000) + "café needletrail resolved";
  for (const [subject, body_md] of [
    ["Late excerpt", body],
    ["Café subjectonly", "unrelated"],
  ]) {
    await call("send_message", {
      project_key: P,
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject,
      body_md,
    });
  }
  const [late] = (await call("search_messages", { project_key: P, query: "cafe needletrail" }))
    .result;
  expect(late.excerpt).toContain(">>>café<<<");
  expect(late.excerpt).toContain(">>>needletrail<<<");
  expect(Array.from(late.excerpt).length).toBeLessThanOrEqual(512);
  expect(late.body_md).toBeUndefined();
  const [full] = (
    await call("search_messages", { project_key: P, query: "needletrail", include_body_md: true })
  ).result;
  expect(full.body_md).toBe(body);
  expect(full.excerpt).toContain(">>>needletrail<<<");
  const [subject] = (await call("search_messages", { project_key: P, query: "subjectonly" }))
    .result;
  expect(subject.excerpt).toBe("Café >>>subjectonly<<<");
});

test("search excerpts bound punctuation and Unicode without hiding the late match", async () => {
  await call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "Bounded",
    body_md: ">>> quoted \u0001" + "😀".repeat(4000) + "boundneedle " + "終".repeat(4000),
  });
  const [hit] = (await call("search_messages", { project_key: P, query: "boundneedle" })).result;
  expect(Array.from(hit.excerpt).length).toBeLessThanOrEqual(512);
  expect(hit.excerpt).toContain(">>>boundneedle<<<");
  expect(hit.excerpt.isWellFormed()).toBe(true);
});

test("another agent's overlapping reservation comes back as a conflict", async () => {
  const mine = await call("file_reservation_paths", {
    project_key: P,
    agent_name: "BlueLake",
    paths: ["src/*.ts"],
  });
  expect(mine.granted.map((g) => g.path_pattern)).toEqual(["src/*.ts"]);
  const theirs = await call("file_reservation_paths", {
    project_key: P,
    agent_name: "GreenCastle",
    paths: ["src/a.ts", "docs/x.md"],
  });
  expect(theirs.granted.map((g) => g.path_pattern)).toEqual(["docs/x.md"]);
  expect(theirs.conflicts).toEqual([
    {
      path: "src/a.ts",
      holders: [expect.objectContaining({ agent: "BlueLake", path_pattern: "src/*.ts" })],
    },
  ]);

  expect(
    (await call("release_file_reservations", { project_key: P, agent_name: "BlueLake" })).released,
  ).toBe(1);
  const retry = await call("file_reservation_paths", {
    project_key: P,
    agent_name: "GreenCastle",
    paths: ["src/a.ts"],
  });
  expect(retry.conflicts).toEqual([]);
  // The reverse direction: a literal is held and a glob covering it is requested.
  const glob = await call("file_reservation_paths", {
    project_key: P,
    agent_name: "BlueLake",
    paths: ["src/*"],
  });
  expect(glob.conflicts.map((c) => c.path)).toEqual(["src/*"]);
  await call("release_file_reservations", { project_key: P, agent_name: "GreenCastle" });
});

test("a reservation's * reaches into subdirectories, as fnmatch does", async () => {
  await call("file_reservation_paths", {
    project_key: P,
    agent_name: "BlueLake",
    paths: ["src/*"],
  });
  const deep = await call("file_reservation_paths", {
    project_key: P,
    agent_name: "GreenCastle",
    paths: ["src/db.ts"],
  });
  expect(deep.granted).toEqual([]);
  await call("release_file_reservations", { project_key: P, agent_name: "BlueLake" });
});

test("a directory reservation covers the files under it, with or without its trailing slash", async () => {
  for (const dir of ["docs/", "docs"]) {
    await call("file_reservation_paths", { project_key: P, agent_name: "BlueLake", paths: [dir] });
    const inside = await call("file_reservation_paths", {
      project_key: P,
      agent_name: "GreenCastle",
      paths: ["docs/guide.md", "docsite/index.md"],
    });
    expect(inside.conflicts.map((c) => c.path)).toEqual(["docs/guide.md"]);
    await call("release_file_reservations", { project_key: P, agent_name: "BlueLake" });
    await call("release_file_reservations", { project_key: P, agent_name: "GreenCastle" });
  }
});

test("the endpoint answers notifications, bad JSON, unknown methods and foreign origins per MCP", async () => {
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  expect(
    (await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status,
  ).toBe(202);
  expect((await (await post("{nope")).json()).error.code).toBe(-32700);
  for (const body of ["null", "3", '"ping"']) {
    expect((await (await post(body)).json()).error.code).toBe(-32600);
  }
  expect(
    (await (await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }))).json())
      .error.code,
  ).toBe(-32601);
  expect(
    (
      await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
        origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  await expect(call("constructor", {})).rejects.toMatchObject({ type: "NOT_FOUND" });
});

test("every call an agent makes counts as activity for list_agents", async () => {
  await register("RedStone", "opencode");
  expect((await call("list_agents", { project_key: P }))[0].name).toBe("RedStone");
  await call("fetch_inbox", { project_key: P, agent_name: "BlueLake" });
  expect((await call("list_agents", { project_key: P }))[0].name).toBe("BlueLake");
  await call("retire_agent", { project_key: P, agent_name: "RedStone" });
  expect((await call("list_agents", { project_key: P })).map((a) => a.name)).not.toContain(
    "RedStone",
  );
});

test("register_agent rejects a descriptive name and generates one when omitted", async () => {
  await expect(register("not a name")).rejects.toMatchObject({ type: "INVALID_AGENT_NAME" });
  const generated = await call("register_agent", { project_key: P, program: "codex", model: "m" });
  expect(generated.name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
});

test("a call that fails partway writes nothing", async () => {
  const key = "/w/fails-partway";
  const rows = () => ({
    projects: db.query("SELECT count(*) AS n FROM projects WHERE human_key = ?").get(key).n,
    agents: db.query("SELECT count(*) AS n FROM agents WHERE name = 'AmberFinch'").get().n,
  });
  // The project row comes before the name check.
  await expect(
    call("register_agent", { project_key: key, program: "codex", model: "m", name: "not a name" }),
  ).rejects.toMatchObject({ type: "INVALID_AGENT_NAME" });
  expect(rows()).toEqual({ projects: 0, agents: 0 });
  // The project and agent come before the reservation, whose TTL check rejects "soon".
  await expect(
    call("macro_start_session", {
      human_key: key,
      program: "codex",
      model: "m",
      agent_name: "AmberFinch",
      file_reservation_paths: ["src/*"],
      file_reservation_ttl_seconds: "soon",
    }),
  ).rejects.toMatchObject({
    type: "INVALID_ARGUMENT",
    data: { field: "file_reservation_ttl_seconds" },
  });
  expect(rows()).toEqual({ projects: 0, agents: 0 });
  // Without paths nothing is reserved, but the TTL is still checked.
  await expect(
    call("macro_start_session", {
      human_key: key,
      program: "codex",
      model: "m",
      agent_name: "AmberFinch",
      file_reservation_ttl_seconds: "soon",
    }),
  ).rejects.toMatchObject({
    type: "INVALID_ARGUMENT",
    data: { field: "file_reservation_ttl_seconds" },
  });
  expect(rows()).toEqual({ projects: 0, agents: 0 });
});

test("a reservation time or activity window that is not a usable number is an argument error and writes nothing", async () => {
  const key = "/w/bad-numbers";
  await call("register_agent", {
    project_key: key,
    program: "codex",
    model: "m",
    name: "CoralRidge",
  });
  const as = { project_key: key, agent_name: "CoralRidge" };
  await call("file_reservation_paths", { ...as, paths: ["a/*"], ttl_seconds: 30 * 86_400 });
  const state = () => ({
    reservations: db
      .query("SELECT path_pattern, expires_ts FROM file_reservations ORDER BY id")
      .all(),
    agents: db.query("SELECT name, last_active_ts FROM agents ORDER BY id").all(),
  });
  const before = state();
  const bad = ["30", 0, -60, 1.5, 30 * 86_400 + 1, 1e300, null];
  for (const ttl_seconds of bad) {
    await expect(
      call("file_reservation_paths", { ...as, paths: ["b/*"], ttl_seconds }),
    ).rejects.toMatchObject({ type: "INVALID_ARGUMENT", data: { field: "ttl_seconds" } });
  }
  for (const extend_seconds of bad) {
    await expect(call("renew_file_reservations", { ...as, extend_seconds })).rejects.toMatchObject({
      type: "INVALID_ARGUMENT",
      data: { field: "extend_seconds" },
    });
  }
  for (const active_within_days of ["1", 0, -1, null]) {
    await expect(
      call("list_agents", { project_key: key, active_within_days }),
    ).rejects.toMatchObject({ type: "INVALID_ARGUMENT", data: { field: "active_within_days" } });
  }
  // An uncapped field names no upper limit; a capped one does.
  await expect(call("list_agents", { project_key: key, active_within_days: 0 })).rejects.toThrow(
    /^active_within_days must be a number above 0$/,
  );
  await expect(call("renew_file_reservations", { ...as, extend_seconds: 0 })).rejects.toThrow(
    /^extend_seconds must be a whole number above 0 and at most 2592000$/,
  );
  expect(state()).toEqual(before);
  expect(
    (await call("list_agents", { project_key: key, active_within_days: 0.5 })).map((a) => a.name),
  ).toEqual(["CoralRidge"]);
});

test("a registration without a name keeps the name of the session or T3 thread its tag names", async () => {
  const project = "/w/one-identity";
  const start = (task, extra = {}) =>
    call("macro_start_session", {
      human_key: project,
      program: "codex",
      model: "m",
      task_description: task,
      ...extra,
    }).then((r) => r.agent.name);
  await call("register_agent", {
    project_key: project,
    program: "codex",
    model: "m",
    name: "IndigoHill",
    task_description: "[t3:thread-1 codex:s1 cwd:~/w] hook registration",
  });
  // The same session, then a new provider session in the same T3 thread.
  expect(await start("[t3:thread-1 codex:s1 cwd:~/w] manual")).toBe("IndigoHill");
  expect(await start("[t3:thread-1 codex:s2 cwd:~/w] after a T3 restart")).toBe("IndigoHill");
  // Outside T3 the session id decides; another thread or session gets its own name.
  await call("register_agent", {
    project_key: project,
    program: "claude-code",
    model: "m",
    name: "AmberFox",
    task_description: "[claude:c1 cwd:~/w] plain",
  });
  expect(await start("[claude:c1 cwd:~/w] again")).toBe("AmberFox");
  const others = [
    await start("[t3:thread-2 codex:s3 cwd:~/w] other thread"),
    await start("[claude:c2 cwd:~/w] other session"),
    await start("untagged"),
  ];
  expect(others).not.toContain("IndigoHill");
  expect(others).not.toContain("AmberFox");
  await call("retire_agent", { project_key: project, agent_name: "AmberFox" });
  expect(await start("[claude:c1 cwd:~/w] after retiring")).not.toBe("AmberFox");
});

test("SWARMAIL_SYNCHRONOUS picks normal or full durability and rejects anything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-sync-"));
  try {
    const sync = (mode) => {
      const db = openDatabase(join(dir, `${mode}.sqlite3`), mode);
      const value = db.query("PRAGMA synchronous").get().synchronous;
      db.close();
      return value;
    };
    expect(sync("normal")).toBe(1);
    expect(sync("full")).toBe(2);
    expect(() => openDatabase(join(dir, "off.sqlite3"), "off")).toThrow("normal or full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pagination rejects invalid sizes before reading mail or enrolling a session", async () => {
  const project = "/w/page-limits";
  for (const name of ["PageSender", "PageReceiver"]) {
    await call("register_agent", { project_key: project, program: "test", model: "m", name });
  }
  const sent = await call("send_message", {
    project_key: project,
    sender_name: "PageSender",
    to: ["PageReceiver"],
    subject: "pagination",
    body_md: "pagination",
    ack_required: true,
  });
  const message = sent.id;
  const cases = [
    ["list_agents", { project_key: project }, "limit"],
    ["fetch_inbox", { project_key: project, agent_name: "PageReceiver" }, "limit"],
    ["search_messages", { project_key: project, query: "pagination" }, "limit"],
    ["summarize_thread", { project_key: project, thread_id: String(message) }, "per_thread_limit"],
    [
      "macro_start_session",
      { human_key: "/w/invalid-enrollment", program: "test", model: "m" },
      "inbox_limit",
    ],
  ];
  for (const [name, args, field] of cases) {
    for (const value of [-1, 0, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(call(name, { ...args, [field]: value })).rejects.toMatchObject({
        type: "INVALID_ARGUMENT",
        data: { field },
      });
    }
  }
  expect(
    db.query("SELECT count(*) AS n FROM projects WHERE human_key=?").get("/w/invalid-enrollment").n,
  ).toBe(0);
  expect(
    (await call("get_message_delivery_receipt", { project_key: project, message_id: message }))
      .recipients[0].read_at,
  ).toBeNull();
  const page = await call("search_messages", {
    project_key: project,
    query: "pagination",
    limit: 1,
  });
  expect(page.result).toHaveLength(1);
  for (const cursor of [
    "oops",
    "o-1",
    "o1.5",
    `o${Number.MAX_SAFE_INTEGER}`,
    "o999999999999999999999",
  ]) {
    await expect(
      call("search_messages", { project_key: project, query: "pagination", cursor }),
    ).rejects.toMatchObject({ type: "INVALID_ARGUMENT", data: { field: "cursor" } });
  }
});

test("large valid page sizes remain capped and search cursors advance", async () => {
  const project = "/w/page-cap";
  const args = { project_key: project, agent_name: "CapReceiver", mark_read: false };
  await call("register_agent", {
    project_key: project,
    program: "test",
    model: "m",
    name: "CapReceiver",
  });
  const agent = db.query("SELECT * FROM agents WHERE name='CapReceiver'").get();
  const add = db.query(
    "INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts) VALUES(?,?,?,?,?) RETURNING id",
  );
  const recipient = db.query(
    "INSERT INTO message_recipients(message_id,agent_id,kind,created_ts) VALUES(?,?,'to',?)",
  );
  db.transaction(() => {
    for (let index = 0; index < 1001; index++) {
      const { id } = add.get(
        agent.project_id,
        agent.id,
        "bounded pagination",
        "bounded pagination",
        index + 1,
      );
      recipient.run(id, agent.id, index + 1);
    }
  })();
  expect(await call("fetch_inbox", { ...args, limit: 10000 })).toHaveLength(1000);
  const page = await call("search_messages", {
    project_key: project,
    query: "bounded pagination",
    limit: 10000,
  });
  expect(page.result).toHaveLength(1000);
  expect(page.next_cursor).toBe("o1000");
  const last = await call("search_messages", {
    project_key: project,
    query: "bounded pagination",
    cursor: page.next_cursor,
    limit: 1,
  });
  expect(last.result).toHaveLength(1);
  expect(last.next_cursor).toBeUndefined();
});

test("re-registering without a tag keeps the wake tag; a new tag replaces it", async () => {
  const tagged = (description) =>
    call("register_agent", {
      project_key: P,
      program: "codex",
      model: "m",
      name: "TaggedOtter",
      task_description: description,
    });
  await tagged("[codex:session-1 cwd:/w/project] first task");
  expect((await tagged("second task")).task_description).toBe(
    "[codex:session-1 cwd:/w/project] second task",
  );
  expect((await tagged("")).task_description).toBe("[codex:session-1 cwd:/w/project]");
  expect((await tagged("[codex:session-2 cwd:/w/project] third")).task_description).toBe(
    "[codex:session-2 cwd:/w/project] third",
  );
  // A bracketed prefix without a colon is task text, not a tag.
  expect((await tagged("[WIP] fourth")).task_description).toBe(
    "[codex:session-2 cwd:/w/project] [WIP] fourth",
  );
  const listed = (await call("list_agents", { project_key: P })).find(
    (agent) => agent.name === "TaggedOtter",
  );
  expect(listed).toMatchObject({
    host: "codex",
    session_id: "session-2",
    t3_thread: null,
    cwd: "/w/project",
  });
});

test("a worktree or subdirectory path names its repository's primary checkout", async () => {
  const repo = join(dir, "repo");
  const git = (...args) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
    expect(r.exitCode).toBe(0);
  };
  mkdirSync(join(repo, "sub"), { recursive: true });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  // A project created under a path before it became a worktree keeps that key.
  const island = join(dir, "repo-island");
  expect((await call("ensure_project", { human_key: island })).human_key).toBe(island);
  git("worktree", "add", "-q", join(dir, "repo-task"));
  git("worktree", "add", "-q", island);
  const primary = realpathSync(repo);
  for (const key of [join(dir, "repo-task"), join(repo, "sub"), repo]) {
    expect((await call("ensure_project", { human_key: key })).human_key).toBe(
      key === repo ? repo : primary,
    );
  }
  expect((await call("ensure_project", { human_key: island })).human_key).toBe(island);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const legacy = await call("register_agent", {
      project_key: island,
      worktree: island,
      name: "BlueIsland",
      program: "claude",
      model: "m",
    });
    expect(legacy.name).toBe("BlueIsland");
    expect(
      (await call("list_agents", { project_key: island })).find((a) => a.name === "BlueIsland")
        .location.worktree,
    ).toBe(join("~", "repo-island"));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
  // Keys that are not existing paths stay as given.
  expect((await call("ensure_project", { human_key: "canary-project" })).human_key).toBe(
    "canary-project",
  );
});

test("an unknown agent error names at most ten recent agents and says what to do", async () => {
  for (let i = 0; i < 12; i++) {
    await register(`Bulk${"ABCDEFGHIJKL"[i]}ear`);
  }
  const error = await call("whois", { project_key: P, agent_name: "NoSuchAgent" }).catch((e) => e);
  expect(error.type).toBe("NOT_FOUND");
  expect(error.data.available_agents.length).toBe(10);
  expect(error.message).toContain("more");
  expect(error.message).toContain("swarmail who");
  const recipient = await call("send_message", {
    project_key: P,
    sender_name: "BulkAear",
    to: ["NoSuchAgent"],
    subject: "x",
    body_md: "y",
  }).catch((e) => e);
  expect(recipient.message).toContain("recipient's spelling");
});

test("an unknown agent error names the project where that name is registered", async () => {
  await register("HomeSender");
  await call("register_agent", {
    project_key: "/w/other",
    program: "claude-code",
    model: "m",
    name: "AwayAgent",
  });
  const recipient = await call("send_message", {
    project_key: P,
    sender_name: "HomeSender",
    to: ["awayagent"],
    subject: "x",
    body_md: "y",
  }).catch((e) => e);
  expect(recipient.type).toBe("NOT_FOUND");
  expect(recipient.message).toContain("'awayagent' is registered in project '/w/other'");
  expect(recipient.message).not.toContain("spelling");
  expect(recipient.data.registered_in).toEqual(["/w/other"]);
  db.query("UPDATE agents SET retired_at = 1 WHERE name = 'AwayAgent'").run();
  const retired = await call("send_message", {
    project_key: P,
    sender_name: "HomeSender",
    to: ["AwayAgent"],
    subject: "x",
    body_md: "y",
  }).catch((e) => e);
  expect(retired.message).toContain("'AwayAgent' is retired in project '/w/other'");
  expect(retired.data.registered_in).toEqual(["/w/other"]);
  const self = await call("fetch_inbox", { project_key: P, agent_name: "AwayAgent" }).catch(
    (e) => e,
  );
  expect(self.message).toContain("pass that project_key.");
});

test("an unknown agent registered in several projects gets plural advice", async () => {
  await register("PluralSender");
  for (const project_key of ["/w/one", "/w/two"]) {
    await call("register_agent", {
      project_key,
      program: "claude-code",
      model: "m",
      name: "TwiceAgent",
    });
  }
  const error = await call("whois", { project_key: P, agent_name: "TwiceAgent" }).catch((e) => e);
  expect(error.type).toBe("NOT_FOUND");
  expect(error.message).toContain("'TwiceAgent' is registered in projects '/w/");
  expect(error.message).toContain("'/w/one'");
  expect(error.message).toContain("'/w/two'");
  expect(error.message).toContain("pass one of those project_keys.");
  expect(error.message).not.toContain("that project_key");
});

test("the hourly sweep forgets old idempotency keys and long-ended registrations", async () => {
  const { pruneIdempotencyKeys } = await import("../src/server.ts");
  const { openRegistry } = await import("../src/registry.ts");
  const now = Date.now();
  db.run("INSERT INTO idempotency_keys VALUES ('send_message', 1, 'old', 'f', '{}', ?)", [
    (now - 8 * 86_400_000) * 1000,
  ]);
  db.run("INSERT INTO idempotency_keys VALUES ('send_message', 1, 'new', 'f', '{}', ?)", [
    now * 1000,
  ]);
  expect(pruneIdempotencyKeys(db, 7)).toBe(1);
  expect(db.query("SELECT key FROM idempotency_keys WHERE agent_id = 1").all()).toEqual([
    { key: "new" },
  ]);
  const registry = join(dir, "registry");
  mkdirSync(registry);
  const ended = (days) => new Date(now - days * 86_400_000).toISOString();
  // A file was last written when its session ended (30 days ago without one), unless `writtenDaysAgo` says otherwise.
  const write = (
    file,
    state,
    writtenDaysAgo = state.ended ? (now - Date.parse(state.ended)) / 86_400_000 : 30,
  ) => {
    const path = join(registry, file);
    writeFileSync(path, JSON.stringify(state));
    const at = (now - writtenDaysAgo * 86_400_000) / 1000;
    utimesSync(path, at, at);
  };
  write("old.json", { name: "OldOwl", projects: [], ended: ended(15) });
  write("recent.json", { name: "NewOwl", projects: [], ended: ended(13) });
  write("live.json", { name: "LiveOwl", projects: [] });
  // Rewritten since it ended, so the sweep skips it without reading it.
  write("touched.json", { name: "TouchOwl", projects: [], ended: ended(15) }, 1);
  expect(openRegistry(registry).prune(14, now)).toBe(1);
  expect(readdirSync(registry).sort()).toEqual(["live.json", "recent.json", "touched.json"]);
});

test("locations follow the edited checkout while messages keep their sender snapshot", async () => {
  const previousHome = process.env.HOME;
  process.env.HOME = join(dir, "location-home");
  try {
    const t3dir = join(process.env.HOME, ".t3", "userdata");
    mkdirSync(t3dir, { recursive: true });
    const t3db = new Database(join(t3dir, "statev2.sqlite"), { create: true });
    createT3V2Tables(t3db);
    addT3V2Thread(t3db, {
      threadId: "location-thread",
      title: "Edit task",
      nativeId: "edit-session",
    });
    t3db.close();
    const repo = join(dir, "location-repo");
    const other = join(dir, "location-worktree");
    const unrelated = join(dir, "unrelated-repo");
    const git = (cwd, ...args) => {
      const out = Bun.spawnSync(["git", "-C", cwd, ...args]);
      expect(out.exitCode).toBe(0);
    };
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "initial");
    git(
      repo,
      "-c",
      "user.name=Tester",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    git(repo, "worktree", "add", "-qb", "edit", "../location-worktree");
    mkdirSync(unrelated);
    git(unrelated, "init", "-q");
    const registration = {
      project_key: repo,
      name: "BlueBranch",
      program: "claude",
      model: "m",
      task_description: "[t3:location-thread claude:edit-session cwd:/launch] task",
    };
    await call("register_agent", { ...registration, worktree: repo });
    await call("register_agent", {
      project_key: repo,
      name: "GreenBranch",
      program: "codex",
      model: "m",
    });
    const message = {
      project_key: repo,
      sender_name: "BlueBranch",
      to: ["GreenBranch"],
      subject: "location",
      body_md: "hello",
      idempotency_key: "location-first",
    };
    const first = await call("send_message", message);
    expect(first.sender_location).toMatchObject({
      repo: "location-repo",
      worktree: repo,
      branch: "initial",
      title: "Edit task",
    });
    await call("register_agent", { ...registration, worktree: other });
    // Omitting the optional field in a manual task update preserves the hook's recorded location.
    await call("register_agent", { ...registration, task_description: "new task" });
    git(other, "switch", "-qc", "renamed");
    const roster = await call("list_agents", { project_key: repo });
    expect(roster.find((a) => a.name === "BlueBranch")).toMatchObject({
      name: "BlueBranch",
      cwd: "/launch",
      location: { worktree: other, branch: "renamed" },
    });
    expect(roster.find((a) => a.name === "GreenBranch").location).toBeNull();
    const replay = await call("send_message", message);
    expect(replay.id).toBe(first.id);
    expect(replay.sender_location).toEqual(first.sender_location);
    const second = await call("send_message", { ...message, idempotency_key: "location-second" });
    expect(second.sender_location.branch).toBe("renamed");
    server.stop(true);
    db.close();
    ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
    url = `http://127.0.0.1:${server.port}/mcp/`;
    const inbox = await call("fetch_inbox", { project_key: repo, agent_name: "GreenBranch" });
    expect(inbox.find((m) => m.id === first.id).sender_location).toEqual(first.sender_location);
    expect(inbox.find((m) => m.id === second.id).sender_location.worktree).toBe(other);
    expect(inbox.find((m) => m.id === second.id).sender_location).toEqual(second.sender_location);
    await expect(
      call("register_agent", { ...registration, worktree: unrelated }),
    ).rejects.toMatchObject({ type: "INVALID_ARGUMENT" });
    await expect(
      call("register_agent", { ...registration, worktree: join(repo, ".git") }),
    ).rejects.toMatchObject({ type: "INVALID_ARGUMENT", data: { field: "worktree" } });
    git(other, "switch", "-q", "--detach");
    expect(
      (await call("list_agents", { project_key: repo })).find((a) => a.name === "BlueBranch")
        .location.branch,
    ).toBeNull();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
