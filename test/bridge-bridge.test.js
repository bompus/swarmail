import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createServer as createTcpServer } from "node:net";
import { createServer } from "../src/server.ts";
import { openWakeState, wakeStatePath } from "../src/wake-state.ts";
import { t3V1Adapter } from "../src/wake-target.ts";
import { bridgeBinding } from "../src/wake-bridge.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function until(fn) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error("condition timed out");
    }
    await Bun.sleep(20);
  }
}
async function fixture(type = "opencode-v2-queue", behavior = {}) {
  const dir = mkdtempSync(join(scratch, "case-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const mail = createServer(join(dir, "mail.sqlite"), 0);
  cleanups.push(() => {
    mail.server.stop(true);
    mail.db.close();
  });
  const mailUrl = `http://127.0.0.1:${mail.server.port}`;
  const id = type === "opencode-v2-queue" ? "ses_bridge" : "thread:project:bridge";
  const received = [];
  const authorizations = [];
  let reject = behavior.reject ?? false;
  let settled = behavior.settled ?? false;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      authorizations.push(req.headers.get("authorization"));
      if (url.pathname === "/ws") {
        return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
      }
      if (url.pathname === "/api/auth/websocket-ticket") {
        return Response.json({ ticket: "private-ticket" });
      }
      if (req.method === "GET") {
        const thread = {
          id,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          settledAt: null,
          settledOverride: settled ? "settled" : null,
        };
        return Response.json(
          type === "t3-v1-steer"
            ? { thread }
            : { projection: { thread, runs: [], messages: [], runtimeRequests: [] } },
        );
      }
      const body = await req.json();
      received.push(body);
      if (reject) {
        return new Response("private response body", { status: 503 });
      }
      return Response.json(
        type === "opencode-v2-queue"
          ? {
              data: {
                id: body.id,
                sessionID: id,
                payload: { text: behavior.mismatch ? "wrong payload" : body.text },
                delivery: behavior.deliveryMismatch ? "invalid" : body.delivery,
              },
            }
          : { sequence: 123 },
      );
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(raw);
        if (frame._tag !== "Request") {
          return;
        }
        received.push(frame);
        ws.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value: { sequence: 123 } },
          }),
        );
      },
    },
  });
  cleanups.push(() => target.stop(true));
  const auth = join(dir, "authorization");
  writeFileSync(auth, "Bearer private-test-token", { mode: 0o600 });
  const config = join(dir, "bridge.json");
  writeFileSync(
    config,
    JSON.stringify({
      swarmailUrl: mailUrl,
      target: { type, id, url: `http://127.0.0.1:${target.port}`, authorizationFile: auth },
    }),
  );
  const call = async (name, args) => {
    const res = await fetch(mailUrl + "/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const data = JSON.parse((await res.json()).result.content[0].text);
    if (data.error) {
      throw new Error(JSON.stringify(data.error));
    }
    return data;
  };
  for (const name of ["BlueLake", "GreenCastle"]) {
    await call("register_agent", {
      project_key: dir,
      name,
      program: "codex",
      model: "test",
      task_description: name === "GreenCastle" ? `[t3:${id}] test` : "sender",
    });
  }
  const send = () =>
    call("send_message", {
      project_key: dir,
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject: "private subject",
      body_md: "private body",
    });
  const state = () => {
    const root = join(dir, "state/swarmail-bridge");
    let path;
    try {
      path = readdirSync(root).find((name) => name.endsWith(".sqlite") && !name.includes(".lock."));
    } catch {
      return null;
    }
    if (!path) {
      return null;
    }
    const db = new Database(join(root, path), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout=2000");
      return db.query("SELECT * FROM state").get();
    } catch (error) {
      if (error.message.includes("no such table")) {
        return null;
      }
      throw error;
    } finally {
      db.close();
    }
  };
  const start = () => {
    const process = Bun.spawn(
      [globalThis.process.execPath, join(import.meta.dir, "../src/cli.ts"), "wake-bridge", config],
      {
        env: { ...globalThis.process.env, XDG_STATE_HOME: join(dir, "state") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(async () => {
      process.kill();
      await process.exited;
    });
    return process;
  };
  return {
    dir,
    mail,
    mailUrl,
    id,
    received,
    authorizations,
    auth,
    config,
    send,
    state,
    start,
    allow: () => {
      reject = false;
    },
    settle: () => {
      settled = true;
    },
    reactivate: () => {
      settled = false;
    },
  };
}

test("explicit acknowledgement retries a lost offer, including after restart, without consuming newer mail", async () => {
  const f = await fixture();
  const wait = (after, base = f.mailUrl) =>
    fetch(`${base}/wait?session=${encodeURIComponent(f.id)}&after=${after}&timeout=1`);
  await f.send();
  const first = await wait(0);
  const firstId = first.headers.get("x-swarmail-event-id");
  expect(first.status).toBe(200);
  expect(await first.text()).not.toContain("private");
  await f.send();
  expect((await wait(firstId)).status).toBe(204);
  await fetch(`${f.mailUrl}/mcp`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "fetch_inbox",
        arguments: { project_key: f.dir, agent_name: "GreenCastle", unread_only: true },
      },
    }),
  });
  await f.send();
  const lost = await wait(firstId);
  const nextId = lost.headers.get("x-swarmail-event-id");
  expect(Number(nextId)).toBeGreaterThan(Number(firstId));
  const restart = createServer(join(f.dir, "mail.sqlite"), 0);
  try {
    const base = `http://127.0.0.1:${restart.server.port}`;
    const retry = await wait(firstId, base);
    expect(retry.headers.get("x-swarmail-event-id")).toBe(nextId);
    expect(await retry.text()).toContain("swarmail inbox --session");
    expect((await wait(nextId, base)).status).toBe(204);
    expect((await wait(firstId, base)).status).toBe(204);
    expect((await wait(999999, base)).status).toBe(409);
    for (const after of ["", "-1", "1.5", "NaN", "9007199254740992"]) {
      expect((await wait(after, base)).status).toBe(400);
    }
  } finally {
    restart.server.stop(true);
    restart.db.close();
  }
});

test("restart retries the saved request after uncertain admission and preserves newer mail", async () => {
  const f = await fixture("opencode-v2-queue", { reject: true });
  await f.send();
  const first = f.start();
  await until(() => f.received.length === 1);
  const original = f.received[0];
  expect(original.delivery).toBe("steer");
  expect(f.state().acknowledged).toBe(0);
  expect(JSON.parse(f.state().pending).command).toEqual(original);
  const alias = JSON.parse(readFileSync(f.config, "utf8"));
  alias.swarmailUrl = alias.swarmailUrl.replace("127.0.0.1", "localhost");
  writeFileSync(f.config, JSON.stringify(alias));
  const competing = f.start();
  expect(await competing.exited).toBe(1);
  expect(await new Response(competing.stderr).text()).toContain("another wake bridge owns");
  first.kill("SIGKILL");
  await first.exited;
  await f.send();
  writeFileSync(f.auth, "Bearer rotated-test-token");
  f.allow();
  const resumed = f.start();
  await until(
    () => f.received.length >= 2 && f.state()?.pending === null && f.state()?.acknowledged >= 1,
  );
  expect(f.received[1]).toEqual(original);
  expect(f.received).toHaveLength(2);
  expect(f.received[1].text).toContain("swarmail inbox --session");
  expect(
    f.mail.db.query("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL").get().n,
  ).toBe(2);
  expect(f.authorizations).toContain("Bearer rotated-test-token");
  resumed.kill();
  await resumed.exited;
  const logs = await new Response(resumed.stderr).text();
  expect(logs).not.toContain("token");
  expect(logs).not.toContain("private");
  const restarted = f.start();
  await until(
    () =>
      f.mail.db.query("SELECT announced FROM wake_cursors WHERE session=?").get(f.id)?.announced >=
      1,
  );
  restarted.kill();
  await restarted.exited;
  expect(f.received).toHaveLength(2);
}, 15000);

test("mismatched admission keeps mail pending and never prints credentials or provider response", async () => {
  const f = await fixture("opencode-v2-queue", { mismatch: true });
  await f.send();
  const run = f.start();
  expect(await run.exited).toBe(1);
  expect(f.state().acknowledged).toBe(0);
  expect(f.state().pending).not.toBeNull();
  expect(await new Response(run.stderr).text()).toContain("does not match");
});

for (const type of ["t3-v1-steer", "t3-v2-queue"]) {
  test(`${type} uses its native protocol and retains the thread's permissions`, async () => {
    const f = await fixture(type);
    await f.send();
    const run = f.start();
    await until(() => f.state()?.acknowledged > 0);
    run.kill();
    await run.exited;
    if (type === "t3-v1-steer") {
      expect(f.received[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: f.id,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      expect(f.received[0]).not.toHaveProperty("modelSelection");
    } else {
      expect(f.received[0]).toMatchObject({
        _tag: "Request",
        tag: "orchestration.dispatchCommand",
        payload: {
          type: "message.dispatch",
          threadId: f.id,
          deliveryIntent: "steer",
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
        },
      });
      expect(f.received[0].payload).not.toHaveProperty("modelSelection");
    }
  });
}

test("rejects destination changes with pending mail", async () => {
  const f = await fixture("opencode-v2-queue", { mismatch: true });
  await f.send();
  const rejected = f.start();
  expect(await rejected.exited).toBe(1);
  expect(f.state().pending).not.toBeNull();
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.target.url = "http://127.0.0.1:9";
  writeFileSync(f.config, JSON.stringify(config));
  const changed = f.start();
  expect(await changed.exited).toBe(1);
  expect(await new Response(changed.stderr).text()).toContain("binding differs");
});

// Credential file modes are enforced on POSIX; Windows uses its own ACLs.
test.skipIf(process.platform === "win32")(
  "rejects unsafe credential permissions before sending",
  async () => {
    const f = await fixture("opencode-v2-queue", { reject: true });
    await f.send();
    chmodSync(f.auth, 0o644);
    const insecure = f.start();
    expect(await insecure.exited).toBe(1);
    expect(f.received).toHaveLength(0);
    expect(await new Response(insecure.stderr).text()).toContain(
      "authorization file must be owned",
    );
  },
);

// Windows native delivery is deliberately refused rather than bypassing socket ownership checks.
test.skipIf(process.platform !== "win32")(
  "refuses native Unix socket targets on Windows",
  async () => {
    for (const type of ["codex-queue", "grok-queue"]) {
      const { wakeBridge } = await import("../src/wake-bridge.ts");
      const path = join(scratch, `${type}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          target: { type, id: "session", socket: join(scratch, "socket"), cwd: scratch },
        }),
      );
      expect(await wakeBridge([path])).toBe(1);
    }
  },
);

for (const boundary of ["mail", "target"]) {
  test(`interrupted ${boundary} response body retries without losing the offer or pending command`, async () => {
    const f = await fixture();
    const config = JSON.parse(readFileSync(f.config, "utf8"));
    const origin = boundary === "mail" ? config.swarmailUrl : config.target.url;
    let broken = false;
    const sockets = new Set();
    const stop = new AbortController();
    const proxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let input = "";
      socket.on("data", async (chunk) => {
        input += chunk.toString();
        const split = input.indexOf("\r\n\r\n");
        if (split < 0) {
          return;
        }
        const length = Number(input.slice(0, split).match(/content-length: (\d+)/i)?.[1] ?? 0);
        if (Buffer.byteLength(input.slice(split + 4)) < length) {
          return;
        }
        socket.removeAllListeners("data");
        const [method, path] = input.split("\r\n")[0].split(" ");
        const headers = {};
        for (const line of input.slice(0, split).split("\r\n").slice(1)) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).toLowerCase();
          if (!["host", "connection", "content-length"].includes(name)) {
            headers[name] = line.slice(colon + 1).trim();
          }
        }
        const response = await fetch(origin + path, {
          signal: stop.signal,
          method,
          headers,
          ...(method === "POST" ? { body: input.slice(split + 4) } : {}),
        }).catch(() => null);
        if (!response) {
          socket.destroy();
          return;
        }
        const body = await response.text().catch(() => null);
        if (body === null) {
          socket.destroy();
          return;
        }
        const eventId = response.headers.get("x-swarmail-event-id");
        if (
          !broken &&
          response.status === 200 &&
          ((boundary === "mail" && path.startsWith("/wait?")) || method === "POST")
        ) {
          broken = true;
          socket.end(
            "HTTP/1.1 200 OK\r\nContent-Length: 99999\r\nConnection: close\r\n" +
              (eventId ? `X-Swarmail-Event-ID: ${eventId}\r\n` : "") +
              "\r\npartial",
          );
          return;
        }
        socket.end(
          `HTTP/1.1 ${response.status} OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n` +
            (eventId ? `X-Swarmail-Event-ID: ${eventId}\r\n` : "") +
            "\r\n" +
            body,
        );
      });
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      stop.abort();
      for (const socket of sockets) {
        socket.destroy();
      }
      proxy.close();
    });
    const url = `http://127.0.0.1:${proxy.address().port}`;
    if (boundary === "mail") {
      config.swarmailUrl = url;
    } else {
      config.target.url = url;
    }
    writeFileSync(f.config, JSON.stringify(config));
    await f.send();
    const run = f.start();
    await until(() => f.state()?.acknowledged > 0);
    run.kill();
    await run.exited;
    expect(broken).toBe(true);
    expect(f.received).toHaveLength(boundary === "mail" ? 1 : 2);
    if (boundary === "target") {
      expect(f.received[1]).toEqual(f.received[0]);
    }
    expect(await new Response(run.stderr).text()).toContain("response interrupted; retry");
  }, 12000);
}

test("two bridges in one process cannot own the same mailbox session", async () => {
  const { openWakeState } = await import("../src/wake-state.ts");
  const dir = mkdtempSync(join(scratch, "case-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  cleanups.push(() => {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const binding = JSON.stringify({ type: "t3-v1-steer", id: "same-thread" });
  const open = () => openWakeState("http://127.0.0.1:1", "same-thread", binding);
  const first = open();
  expect(open).toThrow("another wake bridge owns this mailbox session");
  // The refused connection's close must not release the owner's lock.
  expect(open).toThrow("another wake bridge owns this mailbox session");
  const other = openWakeState("http://127.0.0.1:1", "other-thread", binding);
  other.close();
  first.close();
  open().close(); // Closing the owner's connection releases the lock.
});

// Saved state compares these strings; a changed binding would refuse every existing journal.
test("each target type keeps its saved binding", () => {
  const http = { id: "t", url: "http://127.0.0.1:1", authorizationFile: "/a" };
  const native = { id: "t", socket: "/s", cwd: "/c", timeoutMs: 60_000 };
  expect(
    [
      { type: "t3-v1-steer", ...http },
      { type: "t3-v2-queue", ...http },
      { type: "opencode-v2-queue", ...http },
      { type: "grok-queue", ...native },
      { type: "codex-queue", ...native },
    ].map(bridgeBinding),
  ).toEqual([
    '{"type":"t3-v1-steer","id":"t"}',
    '{"type":"t3-v2-queue","id":"t"}',
    '{"url":"http://127.0.0.1:1","type":"opencode-v2-queue","id":"t"}',
    '{"socket":"/s","cwd":"/c","type":"grok-queue","id":"t"}',
    '{"socket":"/s","cwd":"/c","type":"codex-queue","id":"t"}',
  ]);
});

test("V1 delivery holds an immutable command while settled and resumes after bridge restart", async () => {
  const f = await fixture("t3-v1-steer");
  await f.send();
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.dir, "state");
  const open = () => openWakeState(config.swarmailUrl, f.id, "{}");
  let journal = open();
  try {
    journal.savePending({
      eventId: 1,
      command: await t3V1Adapter.prepare(config.target, "Swarmail: pending mail"),
    });
    const saved = structuredClone(journal.pending);
    f.settle(); // Settlement follows preparation, before the native dispatch.
    journal.close();
    journal = open();
    await expect(
      t3V1Adapter.deliver(
        config.target,
        journal.pending.command,
        () => journal.markAttempted(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryable: true, message: "T3 thread is settled; holding mail" });
    expect(f.received).toHaveLength(0);
    expect(journal.acknowledged).toBe(0);
    expect(journal.pending).toEqual(saved);
    f.reactivate();
    await t3V1Adapter.deliver(
      config.target,
      journal.pending.command,
      () => journal.markAttempted(),
      new AbortController().signal,
    );
    journal.accept(saved.eventId);
    expect(f.received).toEqual([saved.command]);
    expect(journal.pending).toBeNull();
    expect(
      f.mail.db
        .query("SELECT count(*) AS unread FROM message_recipients WHERE read_ts IS NULL")
        .get().unread,
    ).toBe(1);
  } finally {
    journal.close();
    process.env.XDG_STATE_HOME = previous;
  }
});

test("OpenCode receipt must match the saved steering mode", async () => {
  const f = await fixture("opencode-v2-queue", { deliveryMismatch: true });
  await f.send();
  const run = f.start();
  expect(await run.exited).toBe(1);
  expect(f.received[0].delivery).toBe("steer");
  expect(f.state().acknowledged).toBe(0);
  expect(f.state().pending).not.toBeNull();
});

test("journal persistence waits for brief SQLite contention without changing mailbox ownership", async () => {
  const dir = mkdtempSync(join(scratch, "case-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  const url = "http://127.0.0.1:1";
  const state = openWakeState(url, "contended-thread", "{}");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import {Database} from "bun:sqlite";
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    console.log("locked");
    await Bun.stdin.text();
    await Bun.sleep(60);
    db.exec("COMMIT"); db.close();
  `,
      wakeStatePath(url, "contended-thread"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    child.stdin.end("release");
    expect(() => state.saveContext({ failures: { "thread-1": "retained refusal" } })).not.toThrow();
    expect(await child.exited).toBe(0);
    expect(state.readContext()).toEqual({ failures: { "thread-1": "retained refusal" } });
    expect(() => openWakeState(url, "contended-thread", "{}")).toThrow("another wake bridge owns");
  } finally {
    child.stdin.end();
    await child.exited;
    await errors;
    state.close();
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
