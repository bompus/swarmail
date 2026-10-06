import { deliverCodex } from "../src/wake-codex.ts";
import { afterEach, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testScratch } from "./fixtures/test-scratch.js";

// Native socket delivery requires Unix sockets and POSIX ownership.
const test = process.platform === "win32" ? bunTest.skip : bunTest;

const root = testScratch();
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error("condition timed out");
    }
    await Bun.sleep(20);
  }
}
function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [],
    responses = [],
    offers = [];
  const behavior = {
    drop: false,
    lifecycle: true,
    holdLifecycleAfterRead: false,
    hold: false,
    persistAdmission: false,
    mismatch: false,
    cwd: dir,
    direct: true,
    status: { type: "active", activeFlags: [] },
    queue: [],
    history: [],
    paginate: false,
    cycle: false,
  };
  const stateFile = () => {
    try {
      return readdirSync(join(dir, "state/swarmail-bridge")).find(
        (f) => f.endsWith(".sqlite") && !f.includes(".lock."),
      );
    } catch {
      return null;
    }
  };
  const state = () => {
    const file = stateFile();
    if (!file) {
      return null;
    }
    const db = new Database(join(dir, "state/swarmail-bridge", file), { readonly: true });
    try {
      return db.query("SELECT * FROM state").get();
    } catch {
      return null;
    } finally {
      db.close();
    }
  };
  const seedAttempted = () => {
    const db = new Database(join(dir, "state/swarmail-bridge", stateFile()));
    const pending = JSON.parse(state().pending);
    pending.command.phase = "attempted";
    db.query("UPDATE state SET pending=? WHERE id=1").run(JSON.stringify(pending));
    db.close();
  };
  const sockets = new Set();
  const socketPath = join(dir, "app.sock");
  const server = Bun.serve({
    unix: socketPath,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const request = JSON.parse(String(raw));
        if (!request.method) {
          responses.push(request);
          return;
        }
        requests.push({ ...request, saved: state() });
        const reply = (result) => ws.send(JSON.stringify({ id: request.id, result }));
        if (request.method === "initialize") {
          reply({ userAgent: "codex_cli_rs/0.160.0" });
        } else if (request.method === "initialized") {
          return;
        } else if (request.method === "thread/read") {
          if (behavior.holdLifecycleAfterRead) {
            behavior.lifecycle = false;
          }
          expect(request.params).toEqual({ threadId: "native-codex", includeTurns: false });
          ws.send(
            JSON.stringify({
              id: 700,
              method: "item/commandExecution/requestApproval",
              params: { threadId: "native-codex" },
            }),
          );
          reply({
            thread: {
              id: "native-codex",
              cwd: behavior.cwd,
              canAcceptDirectInput: behavior.direct,
              status: behavior.status,
            },
          });
        } else if (["thread/queue/list", "thread/items/list"].includes(request.method)) {
          const data = request.method === "thread/queue/list" ? behavior.queue : behavior.history;
          if (behavior.cycle || (behavior.paginate && !request.params.cursor)) {
            reply({ data: [], nextCursor: "page2" });
          } else {
            reply({ data, nextCursor: null });
          }
        } else if (["thread/queue/add", "turn/start"].includes(request.method)) {
          const queuedSubmission = {
            id: "queue-item",
            clientUserMessageId: request.params.clientUserMessageId,
            input: request.params.input,
          };
          if (behavior.drop) {
            ws.terminate();
            return;
          }
          if (behavior.hold) {
            return;
          }
          if (behavior.mismatch) {
            queuedSubmission.input = [{ type: "text", text: "wrong" }];
          }
          if (request.method === "thread/queue/add") {
            if (behavior.persistAdmission) {
              behavior.queue.push(queuedSubmission);
            }
            reply({ queuedSubmission });
          } else {
            if (behavior.persistAdmission) {
              behavior.history.push({
                turnId: "active-turn",
                item: {
                  type: "userMessage",
                  clientId: queuedSubmission.clientUserMessageId,
                  content: queuedSubmission.input,
                },
              });
            }
            reply({
              turn: behavior.mismatch ? {} : { id: "active-turn", status: "inProgress", items: [] },
            });
          }
        } else {
          throw new Error("unexpected mutating or unsupported method: " + request.method);
        }
      },
    },
  });
  chmodSync(socketPath, 0o777); // Private parent is the Unix endpoint's protection.
  cleanups.push(() => {
    for (const ws of sockets) {
      ws.terminate();
    }
    server.stop(true);
  });
  const mail = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/wait/status") {
        return Response.json({ eligible: behavior.lifecycle });
      }
      const after = Number(new URL(req.url).searchParams.get("after"));
      offers.push(after);
      if (after === 0) {
        return new Response("Swarmail: 1 new message. Call fetch_inbox.", {
          headers: { "x-swarmail-event-id": "9" },
        });
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(new Response(null, { status: 204 })), 500);
        req.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve(new Response(null, { status: 204 }));
          },
          { once: true },
        );
      });
    },
  });
  cleanups.push(() => mail.stop(true));
  const config = {
    swarmailUrl: `http://127.0.0.1:${mail.port}`,
    target: {
      type: "codex-queue",
      id: "native-codex",
      socket: socketPath,
      cwd: dir,
      timeoutMs: 1000,
    },
  };
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const start = (boundary) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        ...(boundary
          ? ["--preload", join(import.meta.dir, "fixtures/codex-crash-barrier.js")]
          : []),
        join(import.meta.dir, "../src/cli.ts"),
        "wake-bridge",
        path,
      ],
      {
        env: {
          ...process.env,
          XDG_STATE_HOME: join(dir, "state"),
          SWARMAIL_TEST_BOUNDARY: boundary ?? "",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
      await proc.exited;
    });
    return proc;
  };
  const adds = () => requests.filter((r) => ["thread/queue/add", "turn/start"].includes(r.method));
  return {
    dir,
    config,
    path,
    start,
    state,
    behavior,
    requests,
    responses,
    offers,
    adds,
    seedAttempted,
  };
}

test("Codex commits attempted before atomic start or steer, validates admission, and leaves permissions to the editor", async () => {
  const f = fixture();
  const run = f.start();
  await until(() => f.offers.includes(9));
  run.kill();
  await run.exited;
  expect(f.adds()).toHaveLength(1);
  expect(f.adds()[0].method).toBe("turn/start");
  expect(f.behavior.queue).toEqual([]);
  const add = f.adds()[0],
    pending = JSON.parse(add.saved.pending);
  expect(pending.command.phase).toBe("attempted");
  expect(add.saved.acknowledged).toBe(0);
  expect(add.params).toEqual({
    threadId: "native-codex",
    clientUserMessageId: pending.command.promptId,
    input: [{ type: "text", text: pending.command.text }],
  });
  expect(f.state().acknowledged).toBe(9);
  expect(f.state().pending).toBeNull();
  expect(f.responses).toEqual([]);
});

test("lost steering reply never resends across restarts; paginated history recovers admission", async () => {
  const f = fixture();
  f.behavior.drop = true;
  const first = f.start();
  expect(await first.exited).toBe(1);
  expect(await new Response(first.stderr).text()).toContain("no resend");
  const saved = JSON.parse(f.state().pending).command;
  const absent = f.start();
  expect(await absent.exited).toBe(1);
  expect(f.adds()).toHaveLength(1);
  expect(f.state().acknowledged).toBe(0);
  f.behavior.paginate = true;
  f.behavior.history = [
    {
      turnId: "active-turn",
      item: {
        type: "userMessage",
        clientId: saved.promptId,
        content: [{ type: "text", text: saved.text, text_elements: [] }],
      },
    },
  ];
  const recovered = f.start();
  await until(() => f.offers.includes(9));
  recovered.kill();
  await recovered.exited;
  expect(f.adds()).toHaveLength(1);
  expect(f.state().acknowledged).toBe(9);
});

test("process death preserves attempted state; exact paginated user-message history recovers without resend", async () => {
  const f = fixture();
  f.behavior.hold = true;
  const first = f.start();
  await until(() => f.adds().length === 1);
  const competing = f.start();
  expect(await competing.exited).toBe(1);
  expect(await new Response(competing.stderr).text()).toContain("another wake bridge owns");
  first.kill("SIGKILL");
  await first.exited;
  const saved = JSON.parse(f.state().pending).command;
  for (const item of [
    {
      type: "agentMessage",
      clientId: saved.promptId,
      content: [{ type: "text", text: saved.text }],
    },
    { type: "userMessage", clientId: "wrong-id", content: [{ type: "text", text: saved.text }] },
    {
      type: "userMessage",
      clientId: saved.promptId,
      content: [{ type: "text", text: "wrong text" }],
    },
  ]) {
    f.behavior.history = [{ turnId: "turn", item }];
    const wrong = f.start();
    expect(await wrong.exited).toBe(1);
    expect(f.state().acknowledged).toBe(0);
  }
  f.behavior.paginate = true;
  f.behavior.history = [
    {
      turnId: "turn",
      item: {
        type: "userMessage",
        clientId: saved.promptId,
        content: [{ type: "text", text: saved.text }],
      },
    },
  ];
  const recovered = f.start();
  await until(() => f.offers.includes(9));
  recovered.kill();
  await recovered.exited;
  expect(f.adds()).toHaveLength(1);
  expect(f.state().acknowledged).toBe(9);
});

test("wrong workspace and unsafe socket stop before enqueue; a mark-only crash cannot authorize sending", async () => {
  const f = fixture();
  f.behavior.cwd = join(f.dir, "other");
  const wrong = f.start();
  expect(await wrong.exited).toBe(1);
  expect(f.adds()).toHaveLength(0);
  expect(JSON.parse(f.state().pending).command.phase).toBe("prepared");
  f.behavior.cwd = f.dir;
  chmodSync(f.dir, 0o755);
  const unsafe = f.start();
  expect(await unsafe.exited).toBe(1);
  expect(await new Response(unsafe.stderr).text()).toContain("private parent directory");
  chmodSync(f.dir, 0o700);
  f.seedAttempted();
  const marked = f.start();
  expect(await marked.exited).toBe(1);
  expect(f.adds()).toHaveLength(0);
  expect(f.state().acknowledged).toBe(0);
  f.config.target.cwd = join(f.dir, "changed");
  writeFileSync(f.path, JSON.stringify(f.config));
  const changed = f.start();
  expect(await changed.exited).toBe(1);
  expect(await new Response(changed.stderr).text()).toContain("binding differs");
});

test("mismatched admission and SIGTERM retain mail; cyclic recovery cursors are bounded", async () => {
  const f = fixture();
  f.behavior.mismatch = true;
  const wrong = f.start();
  expect(await wrong.exited).toBe(1);
  expect(f.state().acknowledged).toBe(0);
  f.behavior.cycle = true;
  const cycle = f.start();
  expect(await cycle.exited).toBe(1);
  expect(f.adds()).toHaveLength(1);
  const g = fixture();
  g.behavior.hold = true;
  const run = g.start();
  await until(() => g.adds().length === 1);
  run.kill();
  expect(await run.exited).toBe(0);
  expect(g.state().acknowledged).toBe(0);
  expect(JSON.parse(g.state().pending).command.phase).toBe("attempted");
});

test("native socket aliases require private alias and resolved parents", async () => {
  for (const privateTarget of [true, false]) {
    const f = fixture();
    const aliasDir = join(f.dir, "private-alias");
    mkdirSync(aliasDir, { mode: 0o700 });
    const alias = join(aliasDir, "app.sock");
    symlinkSync(f.config.target.socket, alias);
    f.config.target.socket = alias;
    writeFileSync(f.path, JSON.stringify(f.config));
    if (!privateTarget) {
      chmodSync(f.dir, 0o755);
    }
    const run = f.start();
    if (privateTarget) {
      await until(() => f.offers.includes(9));
      run.kill();
      await run.exited;
      expect(f.adds()).toHaveLength(1);
    } else {
      expect(await run.exited).toBe(1);
      expect(await new Response(run.stderr).text()).toContain("private parent directory");
      expect(f.adds()).toHaveLength(0);
    }
  }
});

async function atBarrier(proc, boundary) {
  const reader = proc.stdout.getReader();
  let timer;
  try {
    const line = await Promise.race([
      (async () => {
        let text = "";
        while (!text.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error(
              `child exited before ${boundary}: ${await new Response(proc.stderr).text()}`,
            );
          }
          text += new TextDecoder().decode(value);
        }
        return text.trim();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`child did not reach ${boundary}`)), 5000);
      }),
    ]);
    expect(line).toBe(boundary);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

for (const boundary of ["before-attempt", "after-attempt", "before-ack"]) {
  test(`real SIGKILL at ${boundary} preserves permitted sends across repeated recovery`, async () => {
    const f = fixture();
    f.behavior.persistAdmission = boundary === "before-ack";
    const first = f.start(boundary);
    await atBarrier(first, boundary);
    const expectedSends = boundary === "before-ack" ? 1 : 0;
    expect(f.adds()).toHaveLength(expectedSends);
    const saved = JSON.parse(f.state().pending).command;
    expect(saved.phase).toBe(boundary === "before-attempt" ? "prepared" : "attempted");
    expect(f.state().acknowledged).toBe(0);
    first.kill("SIGKILL");
    await first.exited;
    expect(JSON.parse(f.state().pending).command).toEqual(saved);

    if (boundary === "after-attempt") {
      for (let restart = 0; restart < 2; restart++) {
        const recovery = f.start();
        expect(await recovery.exited).toBe(1);
        expect(await new Response(recovery.stderr).text()).toContain("no resend");
        expect(f.adds()).toHaveLength(0);
        expect(f.state().acknowledged).toBe(0);
        expect(JSON.parse(f.state().pending).command).toEqual(saved);
      }
      return;
    }
    if (boundary === "before-ack") {
      expect(f.behavior.queue).toEqual([]);
      expect(f.behavior.history).toEqual([
        {
          turnId: "active-turn",
          item: {
            type: "userMessage",
            clientId: saved.promptId,
            content: [{ type: "text", text: saved.text }],
          },
        },
      ]);
    }
    for (let restart = 0; restart < 2; restart++) {
      f.offers.length = 0;
      const recovery = f.start();
      await until(() => f.offers.includes(9));
      recovery.kill();
      await recovery.exited;
      expect(f.adds()).toHaveLength(1);
      expect(f.adds()[0].params.clientUserMessageId).toBe(saved.promptId);
      expect(f.state().acknowledged).toBe(9);
      expect(f.state().pending).toBeNull();
    }
  });
}

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`simultaneous first starters released ${order.join(",")} have only one sender`, async () => {
    const f = fixture();
    f.behavior.hold = true;
    const children = [f.start("startup"), f.start("startup")];
    await Promise.all(children.map((child) => atBarrier(child, "startup")));
    for (const index of order) {
      children[index].stdin.write("x");
      children[index].stdin.flush();
    }
    const loser = await Promise.race(
      children.map(async (child) => {
        await child.exited;
        return child;
      }),
    );
    expect(loser.exitCode).toBe(1);
    expect(await new Response(loser.stderr).text()).toContain("another wake bridge owns");
    await until(() => f.adds().length > 0);
    const saved = JSON.parse(f.state().pending).command;
    expect(f.adds()).toHaveLength(1);
    expect(saved.phase).toBe("attempted");
    const winner = children.find((child) => child !== loser);
    winner.kill("SIGKILL");
    await winner.exited;
    for (let restart = 0; restart < 2; restart++) {
      const recovery = f.start();
      expect(await recovery.exited).toBe(1);
      expect(f.adds()).toHaveLength(1);
      expect(f.adds()[0].params.clientUserMessageId).toBe(saved.promptId);
      expect(f.state().acknowledged).toBe(0);
    }
  });
}

for (const held of [
  { direct: false },
  { direct: null },
  { status: { type: "notLoaded" } },
  { status: { type: "systemError" } },
  { status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  { status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
]) {
  test(`native steering holds unavailable or human-waiting session ${JSON.stringify(held)}`, async () => {
    const f = fixture();
    Object.assign(f.behavior, held);
    const run = f.start();
    await until(() => f.requests.some((request) => request.method === "thread/read"));
    run.kill();
    await run.exited;
    expect(f.adds()).toHaveLength(0);
    expect(JSON.parse(f.state().pending).command.phase).toBe("prepared");
    expect(f.state().acknowledged).toBe(0);
  });
}

test("a prepared legacy Codex command retains its original queue API during rollout", async () => {
  const f = fixture();
  const command = { phase: "prepared", promptId: "legacy-id", text: "Swarmail: legacy mail" };
  let marked = 0;
  await deliverCodex(
    f.config.target,
    command,
    () => {
      marked++;
      command.phase = "attempted";
    },
    new AbortController().signal,
  );
  expect(marked).toBe(1);
  expect(f.adds()).toHaveLength(1);
  expect(f.adds()[0].method).toBe("thread/queue/add");
  expect(f.adds()[0].params).toEqual({
    threadId: "native-codex",
    clientUserMessageId: "legacy-id",
    input: [{ type: "text", text: command.text }],
  });
  expect(f.responses).toEqual([]);
});

test("lifecycle closure after Codex inspection holds the prepared journal before any native write", async () => {
  const f = fixture();
  f.behavior.holdLifecycleAfterRead = true;
  const run = f.start();
  await until(() => f.requests.some((r) => r.method === "thread/queue/list"));
  await until(() => f.state()?.pending !== null);
  run.kill();
  await run.exited;
  expect(f.adds()).toEqual([]);
  expect(f.state().acknowledged).toBe(0);
  expect(JSON.parse(f.state().pending).command.phase).toBe("prepared");
  f.behavior.holdLifecycleAfterRead = false;
  f.behavior.lifecycle = true;
  const resumed = f.start();
  await until(() => f.offers.includes(9));
  resumed.kill();
  await resumed.exited;
  expect(f.adds()).toHaveLength(1);
});
