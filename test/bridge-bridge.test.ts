import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { createServer } from "../src/server.ts";
import { openWakeState, wakeStatePath } from "../src/wake-state.ts";
import { BridgeError, t3V2Adapter, type WakeTarget } from "../src/wake-target.ts";
import { bridgeBinding } from "../src/wake-bridge.ts";
import { testScratch } from "./fixtures/test-scratch.ts";
import type { Args, Row } from "../src/store.ts";

const scratch = testScratch();
const cleanups: (() => unknown)[] = [];
test("V2 bridge preparation refuses the generic command path", async () => {
  let failure: any;
  try {
    await t3V2Adapter.prepare({} as WakeTarget, "Swarmail: pending mail");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BridgeError);
  expect(failure.message).toBe("T3 V2 notices require the notice adapter");
  expect(failure.retryable).toBe(false);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function until(fn: () => unknown) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error("condition timed out");
    }
    await Bun.sleep(20);
  }
}
/** How the fake target answers. */
interface Behavior {
  reject?: boolean;
  mismatch?: boolean;
  deliveryMismatch?: boolean;
}

async function fixture(type = "opencode-v2-queue", behavior: Behavior = {}) {
  const dir = mkdtempSync(join(scratch, "case-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const mail = createServer(join(dir, "mail.sqlite"), 0);
  cleanups.push(() => {
    void mail.server.stop(true);
    mail.db.close();
  });
  const mailUrl = `http://127.0.0.1:${mail.server.port}`;
  const id = type === "opencode-v2-queue" ? "ses_bridge" : "thread:project:bridge";
  const received: any[] = [];
  const authorizations: (string | null)[] = [];
  let reject = behavior.reject ?? false;
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
        const thread = { id, settledAt: null, settledOverride: null };
        return Response.json({
          projection: { thread, runs: [], messages: [], runtimeRequests: [] },
        });
      }
      const body = (await req.json()) as Args;
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
        const frame = JSON.parse(String(raw));
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
  const call = async (name: string, args: Args) => {
    const res = await fetch(mailUrl + "/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const data = JSON.parse(((await res.json()) as any).result.content[0].text);
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
      notification_policy: "wake",
    });
  const state = (): Row | null => {
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
      return db.query<Row, []>("SELECT * FROM state").get();
    } catch (error) {
      if ((error as Error).message.includes("no such table")) {
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
  };
}

test("explicit acknowledgement retries a lost offer, including after restart, without consuming newer mail", async () => {
  const f = await fixture();
  const wait = (after: string | number | null, base = f.mailUrl) =>
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
    void restart.server.stop(true);
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
  expect(f.state()!.acknowledged).toBe(0);
  expect(JSON.parse(f.state()!.pending).command).toEqual(original);
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
    f.mail.db
      .query<Row, []>("SELECT count(*) AS n FROM message_recipients WHERE read_ts IS NULL")
      .get()!.n,
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
      f.mail.db.query<Row, [string]>("SELECT announced FROM wake_cursors WHERE session=?").get(f.id)
        ?.announced >= 1,
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
  expect(f.state()!.acknowledged).toBe(0);
  expect(f.state()!.pending).not.toBeNull();
  expect(await new Response(run.stderr).text()).toContain("does not match");
});

test("t3-v2-queue uses its native protocol and keeps the thread's model", async () => {
  const f = await fixture("t3-v2-queue");
  await f.send();
  const run = f.start();
  await until(() => f.state()?.acknowledged > 0);
  run.kill();
  await run.exited;
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
});

test("a t3-v1-steer configuration fails at load and names its replacement", async () => {
  const f = await fixture("t3-v1-steer");
  await f.send();
  const run = f.start();
  expect(await run.exited).toBe(1);
  expect(await new Response(run.stderr).text()).toContain(
    "target type t3-v1-steer was removed: current T3 Code runs only its V2 engine, which has no V1 route; use t3-v2-queue",
  );
  expect(f.received).toHaveLength(0);
  expect(f.state()).toBeNull();
});

test("rejects destination changes with pending mail", async () => {
  const f = await fixture("opencode-v2-queue", { mismatch: true });
  await f.send();
  const rejected = f.start();
  expect(await rejected.exited).toBe(1);
  expect(f.state()!.pending).not.toBeNull();
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
    const sockets = new Set<Socket>();
    const stop = new AbortController();
    const proxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // The peer can reset the deliberately truncated response or a pending teardown write.
        if (error.code !== "ECONNRESET") {
          throw error;
        }
      });
      socket.on("close", () => sockets.delete(socket));
      let input = "";
      const forward = async (chunk: Buffer) => {
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
        const [method, path = ""] = input.split("\r\n")[0]!.split(" ");
        const headers: Record<string, string> = {};
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
      };
      socket.on("data", (chunk: Buffer) => {
        void forward(chunk);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      stop.abort();
      for (const socket of sockets) {
        socket.destroy();
      }
      proxy.close();
    });
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
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
  const binding = JSON.stringify({ type: "t3-v2-queue", id: "same-thread" });
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
    (
      [
        { type: "t3-v2-queue", ...http },
        { type: "opencode-v2-queue", ...http },
        { type: "grok-queue", ...native },
        { type: "codex-queue", ...native },
      ] as const
    ).map(bridgeBinding),
  ).toEqual([
    '{"type":"t3-v2-queue","id":"t"}',
    '{"url":"http://127.0.0.1:1","type":"opencode-v2-queue","id":"t"}',
    '{"socket":"/s","cwd":"/c","type":"grok-queue","id":"t"}',
    '{"socket":"/s","cwd":"/c","type":"codex-queue","id":"t"}',
  ]);
});

test("OpenCode receipt must match the saved steering mode", async () => {
  const f = await fixture("opencode-v2-queue", { deliveryMismatch: true });
  await f.send();
  const run = f.start();
  expect(await run.exited).toBe(1);
  expect(f.received[0].delivery).toBe("steer");
  expect(f.state()!.acknowledged).toBe(0);
  expect(f.state()!.pending).not.toBeNull();
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
    void child.stdin.end();
    expect(() => state.saveContext({ failures: { "thread-1": "retained refusal" } })).not.toThrow();
    expect(await child.exited).toBe(0);
    expect(state.readContext()).toEqual({ failures: { "thread-1": "retained refusal" } });
    expect(() => openWakeState(url, "contended-thread", "{}")).toThrow("another wake bridge owns");
  } finally {
    void child.stdin.end();
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
