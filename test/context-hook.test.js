import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});
function fixture(host, key) {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-context-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { server, db } = createServer(join(dir, "mail.sqlite"), 0);
  cleanups.push(() => {
    server.stop(true);
    db.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (name, args) => {
    const response = await fetch(base + "/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return JSON.parse((await response.json()).result.content[0].text);
  };
  const run = async (sid = "native-session", stop = false, wakeBase = base) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "hook",
        host === "cursor" && stop ? "wake" : "context",
        host,
        ...(host === "cursor" && stop ? ["2"] : stop ? ["stop"] : []),
      ],
      {
        env: { ...process.env, SWARMAIL_WAKE_URL: wakeBase, XDG_STATE_HOME: dir },
        stdin: new Blob([JSON.stringify({ [key]: sid })]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(out);
  };
  return { dir, db, base, call, run };
}

for (const [host, key] of [
  ["cursor", "conversation_id"],
  ["devin", "session_id"],
  ["agy", "conversationId"],
]) {
  test(`${host} receives native active-context mail once per arrival without T3 or inbox mutation`, async () => {
    const f = fixture(host, key);
    await f.call("register_agent", {
      project_key: f.dir,
      name: "GoldMoose",
      program: "sender",
      model: "test",
    });
    await f.call("register_agent", {
      project_key: f.dir,
      name: "BlueLake",
      program: host,
      model: "test",
      task_description: `[${host}:native-session] test`,
    });
    expect(await f.run()).toEqual({});
    for (const importance of ["low", "normal", "high", "urgent"]) {
      const sent = await f.call("send_message", {
        project_key: f.dir,
        sender_name: "GoldMoose",
        to: ["BlueLake"],
        subject: "information",
        body_md: "Only the receiver chooses whether to pause",
        importance,
      });
      expect(sent.id).toBeGreaterThan(0);
      expect(await f.run("unrelated-session")).toEqual({});
      const output = await f.run();
      const hint =
        host === "cursor"
          ? output.additional_context
          : host === "devin"
            ? output.hookSpecificOutput.additionalContext
            : output.injectSteps[0].userMessage;
      expect(hint).toContain("Swarmail:");
      expect(hint).toContain("BlueLake");
      if (host === "devin") {
        expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      }
      expect(output).not.toHaveProperty("decision");
      expect(await f.run()).toEqual({});
    }
    const inbox = await f.call("fetch_inbox", {
      project_key: f.dir,
      agent_name: "BlueLake",
      unread_only: true,
      mark_read: false,
    });
    expect(inbox).toHaveLength(4);
    expect(
      f.db
        .query(
          "SELECT count(*) AS n FROM message_recipients WHERE ack_ts IS NOT NULL OR read_ts IS NOT NULL",
        )
        .get().n,
    ).toBe(0);
  });
}

for (const [host, key, decision] of [
  ["devin", "session_id", "block"],
  ["agy", "conversationId", "continue"],
]) {
  test(`${host} stop hook requests another turn only when new mail is present`, async () => {
    const f = fixture(host, key);
    await f.call("register_agent", {
      project_key: f.dir,
      name: "GoldMoose",
      program: "sender",
      model: "test",
    });
    await f.call("register_agent", {
      project_key: f.dir,
      name: "BlueLake",
      program: host,
      model: "test",
      task_description: `[${host}:native-session] test`,
    });
    await f.call("send_message", {
      project_key: f.dir,
      sender_name: "GoldMoose",
      to: ["BlueLake"],
      subject: "mail",
      body_md: "info",
    });
    expect(await f.run("native-session", true)).toMatchObject({
      decision,
      reason: expect.stringContaining("Swarmail:"),
    });
    expect(await f.run("native-session", true)).toEqual({});
  });
}

test("timeout zero returns an empty response without a long poll", async () => {
  const f = fixture("devin", "session_id");
  const response = await fetch(f.base + "/wait?session=native-session&timeout=0", {
    signal: AbortSignal.timeout(1000),
  });
  expect(response.status).toBe(204);
});

for (const [host, key] of [
  ["cursor", "conversation_id"],
  ["devin", "session_id"],
  ["agy", "conversationId"],
]) {
  for (const stop of [false, true]) {
    test(`${host} recovers a lost HTTP offer on the next ${stop ? "stop" : "context"} hook`, async () => {
      const f = fixture(host, key);
      await f.call("register_agent", {
        project_key: f.dir,
        name: "GoldMoose",
        program: "sender",
        model: "test",
      });
      await f.call("register_agent", {
        project_key: f.dir,
        name: "BlueLake",
        program: host,
        model: "test",
        task_description: `[${host}:native-session] test`,
      });
      await f.call("send_message", {
        project_key: f.dir,
        sender_name: "GoldMoose",
        to: ["BlueLake"],
        subject: "mail",
        body_md: "info",
      });
      const queries = [];
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/wait") {
            queries.push(url.searchParams.get("retry"));
          }
          const response = await fetch(f.base + url.pathname + url.search);
          if (url.pathname === "/wait" && queries.length === 1) {
            expect(response.status).toBe(200);
            await response.text();
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("Swarmail: incomplete"));
                },
              }),
            );
          }
          return response;
        },
      });
      cleanups.push(() => proxy.stop(true));
      const wakeBase = `http://127.0.0.1:${proxy.port}`;
      expect(await f.run("native-session", false, wakeBase)).toEqual({});
      const recovered = await f.run("native-session", stop, wakeBase);
      expect(JSON.stringify(recovered)).toContain("Swarmail:");
      expect(await f.run("native-session", stop, wakeBase)).toEqual({});
      expect(queries).toEqual(["1", "1", "1"]);
      expect(
        (
          await f.call("fetch_inbox", {
            project_key: f.dir,
            agent_name: "BlueLake",
            unread_only: true,
            mark_read: false,
          })
        ).length,
      ).toBe(1);
    });
  }
}

test("native Devin CLI registers documented payloads without cwd and follows edits into another repository", async () => {
  const f = fixture("devin", "session_id");
  const repos = [join(f.dir, "first"), join(f.dir, "second")];
  for (const repo of repos) {
    mkdirSync(repo);
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  }
  const register = async (payload) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "register", "--host", "devin"],
      {
        env: {
          ...process.env,
          DEVIN_PROJECT_DIR: repos[0],
          XDG_STATE_HOME: f.dir,
          SWARMAIL_URL: f.base + "/mcp",
        },
        stdin: new Blob([JSON.stringify({ session_id: "native-devin", ...payload })]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = (await new Response(child.stdout).text()).trim();
    expect(await child.exited).toBe(0);
    return out ? JSON.parse(out) : null;
  };
  expect(
    (await register({ hook_event_name: "SessionStart" })).hookSpecificOutput.additionalContext,
  ).toContain("registered as");
  expect(
    await register({
      hook_event_name: "PreToolUse",
      tool_name: "edit",
      tool_input: { file_path: join(repos[1], "file.txt") },
    }),
  ).toBeNull();
  const rows = f.db
    .query(
      "SELECT a.name, a.program, a.session_id, p.human_key FROM agents a JOIN projects p ON p.id=a.project_id ORDER BY p.human_key",
    )
    .all();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.name)).size).toBe(1);
  expect(rows.map((r) => r.human_key)).toEqual(repos.map((repo) => realpathSync.native(repo)));
  expect(rows.every((r) => r.program === "devin" && r.session_id === "native-devin")).toBe(true);
});

for (const mixed of [false, true]) {
  test(`parallel ${mixed ? "Cursor context and Stop" : "context"} hooks claim an offered arrival once`, async () => {
    const host = mixed ? "cursor" : "devin";
    const f = fixture(host, mixed ? "conversation_id" : "session_id");
    await f.call("register_agent", {
      project_key: f.dir,
      name: "GoldMoose",
      program: "sender",
      model: "test",
    });
    await f.call("register_agent", {
      project_key: f.dir,
      name: "BlueLake",
      program: host,
      model: "test",
      task_description: `[${host}:native-session] test`,
    });
    await f.call("send_message", {
      project_key: f.dir,
      sender_name: "GoldMoose",
      to: ["BlueLake"],
      subject: "mail",
      body_md: "info",
    });
    let entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        requests++;
        const url = new URL(req.url);
        const response = await fetch(f.base + url.pathname + url.search);
        if (requests === 1) {
          entered();
          await gate;
        }
        return response;
      },
    });
    cleanups.push(() => proxy.stop(true));
    const wakeBase = `http://127.0.0.1:${proxy.port}`;
    const first = f.run("native-session", false, wakeBase);
    await arrived;
    expect(JSON.stringify(await f.run("native-session", mixed, wakeBase))).toContain("Swarmail:");
    expect(requests).toBe(mixed ? 3 : 2);
    release();
    expect(await first).toEqual({});
    expect(await f.run("native-session", false, wakeBase)).toEqual({});
  });
}

for (const stop of [false, true]) {
  test(`a killed ${stop ? "Cursor Stop" : "context"} hook leaves its uncertain offer recoverable`, async () => {
    const host = stop ? "cursor" : "devin";
    const key = stop ? "conversation_id" : "session_id";
    const f = fixture(host, key);
    await f.call("register_agent", {
      project_key: f.dir,
      name: "GoldMoose",
      program: "sender",
      model: "test",
    });
    await f.call("register_agent", {
      project_key: f.dir,
      name: "BlueLake",
      program: host,
      model: "test",
      task_description: `[${host}:native-session] test`,
    });
    await f.call("send_message", {
      project_key: f.dir,
      sender_name: "GoldMoose",
      to: ["BlueLake"],
      subject: "mail",
      body_md: "info",
    });
    let entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const response = await fetch(f.base + url.pathname + url.search);
        if (url.pathname !== "/wait") {
          return response;
        }
        await response.text();
        entered();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("Swarmail: incomplete"));
            },
          }),
        );
      },
    });
    cleanups.push(() => proxy.stop(true));
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "hook",
        stop ? "wake" : "context",
        host,
        ...(stop ? ["2"] : []),
      ],
      {
        env: {
          ...process.env,
          XDG_STATE_HOME: f.dir,
          SWARMAIL_WAKE_URL: `http://127.0.0.1:${proxy.port}`,
        },
        stdin: new Blob([JSON.stringify({ [key]: "native-session" })]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await arrived;
      child.kill("SIGKILL");
      await child.exited;
      expect(JSON.stringify(await f.run())).toContain("Swarmail:");
      expect(await f.run()).toEqual({});
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  });
}

test("an older concurrent offer remains acknowledgeable after a higher message is read", async () => {
  const f = fixture("devin", "session_id");
  await f.call("register_agent", {
    project_key: f.dir,
    name: "GoldMoose",
    program: "sender",
    model: "test",
  });
  await f.call("register_agent", {
    project_key: f.dir,
    name: "BlueLake",
    program: "devin",
    model: "test",
    task_description: "[devin:native-session] test",
  });
  const send = () =>
    f.call("send_message", {
      project_key: f.dir,
      sender_name: "GoldMoose",
      to: ["BlueLake"],
      subject: "mail",
      body_md: "info",
    });
  await send();
  const second = await send();
  let entered;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const response = await fetch(f.base + url.pathname + url.search);
      const body = await response.text();
      entered();
      await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  cleanups.push(() => proxy.stop(true));
  const delayed = f.run("native-session", false, `http://127.0.0.1:${proxy.port}`);
  await arrived;
  await f.call("mark_message_read", {
    project_key: f.dir,
    agent_name: "BlueLake",
    message_id: second.id,
  });
  expect(JSON.stringify(await f.run())).toContain("Swarmail:");
  release();
  expect(JSON.stringify(await delayed)).toContain("Swarmail:");
  await send();
  expect(JSON.stringify(await f.run())).toContain("Swarmail:");
  expect(await f.run()).toEqual({});
});
