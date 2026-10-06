import { afterEach, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { bridgeBinding } from "../src/wake-bridge.ts";
import { openWakeState } from "../src/wake-state.ts";
import { deliverGrok } from "../src/wake-grok.ts";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
async function fixture(legacy = true) {
  const dir = mkdtempSync(join(root, "case-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "bridge.json");
  const socketPath = join(dir, "leader.sock");
  const requests = [];
  const loads = [];
  const replies = [];
  const offers = [];
  const sockets = new Set();
  /** @type {{ complete: boolean, replay: object | null, drop: boolean, version: number }} */
  const behavior = { complete: true, replay: null, drop: false, version: 1, stopped: false };
  const state = () => {
    let files;
    try {
      files = readdirSync(join(dir, "state/swarmail-bridge"));
    } catch {
      return null;
    }
    const name = files.find((f) => f.endsWith(".sqlite") && !f.includes(".lock."));
    if (!name) {
      return null;
    }
    const db = new Database(join(dir, "state/swarmail-bridge", name), { readonly: true });
    try {
      return db.query("SELECT * FROM state").get();
    } catch {
      return null;
    } finally {
      db.close();
    }
  };
  const completion = (promptId, stopReason = "end_turn", sessionId = "native-session") => ({
    jsonrpc: "2.0",
    method: "_x.ai/session/update",
    params: {
      sessionId,
      _meta: { isReplay: true },
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: stopReason },
    },
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const frame = (body) => {
      const payload = Buffer.from(JSON.stringify(body));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      // Split framing deliberately; a TCP/Unix read need not contain a whole frame.
      socket.write(header.subarray(0, 2));
      socket.write(Buffer.concat([header.subarray(2), payload]));
    };
    const acp = (message) => frame({ type: "acp", payload: JSON.stringify(message) });
    const handle = (message) => {
      if (message.type === "register") {
        expect(message.capabilities).toEqual({});
        frame({
          type: "registered",
          client_id: "client",
          ready: false,
          leader_protocol_version: behavior.version,
          leader_binary_version: "1.0.41",
        });
        frame({ type: "leader_ready" });
        return;
      }
      if (message.type !== "acp") {
        return;
      }
      const req = JSON.parse(message.payload);
      if (!req.method) {
        replies.push(req);
        return;
      }
      const respond = (result) => acp({ jsonrpc: "2.0", id: req.id, result });
      if (req.method === "initialize") {
        respond({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          _meta: { grokShell: true },
        });
      } else if (req.method === "authenticate") {
        expect(req.params.methodId).toBe("cached_token");
        respond({});
      } else if (req.method === "session/load") {
        loads.push(req);
        expect(req.params).toEqual({ sessionId: "native-session", cwd: dir, mcpServers: [] });
        if (behavior.sequence) {
          for (const event of behavior.sequence) {
            if (event === "disconnect") {
              socket.end();
              break;
            }
            if (event === "load reply") {
              respond({});
            } else if (event === "completion") {
              acp({
                ...behavior.replay,
                params: {
                  ...behavior.replay.params,
                  _meta: {
                    isReplay:
                      behavior.sequence.indexOf("completion") <
                      behavior.sequence.indexOf("load reply"),
                  },
                },
              });
            } else if (event === "permission") {
              acp({
                jsonrpc: "2.0",
                id: 700,
                method: "session/request_permission",
                params: { options: [{ kind: "allow_once", optionId: "allow" }] },
              });
            }
          }
          return;
        }
        if (behavior.replay) {
          acp(behavior.replay);
        }
        // The real leader broadcasts these questions to all subscribers. Bridge must not answer.
        acp({
          jsonrpc: "2.0",
          id: 700,
          method: "session/request_permission",
          params: { options: [{ kind: "allow_once", optionId: "allow" }] },
        });
        respond({});
      } else if (req.method === "_x.ai/interject") {
        requests.push({ request: req, state: state() });
        if (behavior.drop) {
          socket.destroy();
          return;
        }
        if (behavior.interjectionSequence) {
          for (const event of behavior.interjectionSequence) {
            if (event === "disconnect") {
              socket.end();
              break;
            }
            if (event === "receipt") {
              respond({ status: "queued" });
            }
            if (event === "echo") {
              acp({
                jsonrpc: "2.0",
                method: "_x.ai/session/interjection",
                params: {
                  sessionId: req.params.sessionId,
                  interjectionId: req.params.interjectionId,
                  text: req.params.text,
                },
              });
            }
            if (event === "permission") {
              acp({
                jsonrpc: "2.0",
                id: 701,
                method: "session/request_permission",
                params: { options: [{ kind: "allow_once", optionId: "allow" }] },
              });
            }
          }
          return;
        }
        respond({ status: "queued" });
        if (behavior.complete) {
          acp({
            jsonrpc: "2.0",
            method: "_x.ai/session/interjection",
            params: {
              sessionId: req.params.sessionId,
              interjectionId: req.params.interjectionId,
              text: behavior.mismatch ? "wrong" : req.params.text,
            },
          });
        }
      } else if (req.method === "session/prompt") {
        requests.push({ request: req, state: state() });
        if (behavior.drop) {
          socket.destroy();
          return;
        }
        if (behavior.complete) {
          respond({
            stopReason: "end_turn",
            _meta: { sessionId: "native-session", promptId: req.params._meta.promptId },
          });
        } else {
          acp({
            jsonrpc: "2.0",
            method: "_x.ai/queue/changed",
            params: { sessionId: "native-session", entries: [{ id: req.params._meta.promptId }] },
          });
        }
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
        const length = buffer.readUInt32BE(0);
        const body = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        handle(JSON.parse(body.toString()));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o777); // Native leader relies on its private parent directory.
  cleanups.push(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  const mail = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/wait/status") {
        return Response.json({ eligible: true });
      }
      const after = new URL(req.url).searchParams.get("after");
      offers.push(Number(after));
      if (after === "0") {
        return new Response("Swarmail: 1 new message. Call fetch_inbox.", {
          headers: { "x-swarmail-event-id": "9" },
        });
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(new Response(null, { status: 204 })), 1000);
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
      type: "grok-queue",
      id: "native-session",
      socket: socketPath,
      cwd: dir,
      timeoutMs: 1000,
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  if (legacy) {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(dir, "state");
    const journal = openWakeState(
      config.swarmailUrl,
      config.target.id,
      bridgeBinding(config.target),
    );
    journal.savePending({
      eventId: 9,
      command: {
        promptId: "legacy-prompt",
        text: "Swarmail: 1 new message. Call fetch_inbox.",
        phase: "prepared",
      },
    });
    journal.close();
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  }
  const start = () => {
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "wake-bridge", configPath],
      {
        env: { ...process.env, XDG_STATE_HOME: join(dir, "state") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(async () => {
      if (proc.exitCode === null) {
        proc.kill();
      }
      await proc.exited;
    });
    return proc;
  };
  return {
    dir,
    config,
    configPath,
    start,
    requests,
    loads,
    replies,
    offers,
    state,
    behavior,
    completion,
    sockets,
    settled: () =>
      Promise.all(
        [...sockets].map((socket) => new Promise((resolve) => socket.once("close", resolve))),
      ),
  };
}

test("legacy Grok journal persists attempted before dispatch, completes before ack, and never answers shared permission requests", async () => {
  const f = await fixture();
  const run = f.start();
  await until(() => f.offers.includes(9));
  run.kill();
  await run.exited;
  expect(f.requests).toHaveLength(1);
  const saved = JSON.parse(f.requests[0].state.pending);
  expect(saved.command.phase).toBe("attempted");
  expect(saved.command.promptId).toBe(f.requests[0].request.params._meta.promptId);
  expect(f.requests[0].state.acknowledged).toBe(0);
  expect(f.state().pending).toBeNull();
  expect(f.state().acknowledged).toBe(9);
  expect(f.replies).toEqual([]);
});

test("lost reply stays ambiguous across restarts and only exact successful replay permits acknowledgement", async () => {
  const f = await fixture();
  f.behavior.drop = true;
  const first = f.start();
  expect(await first.exited).toBe(1);
  const saved = JSON.parse(f.state().pending).command;
  expect(saved.phase).toBe("attempted");
  expect(await new Response(first.stderr).text()).toContain("no resend");
  f.behavior.drop = false;
  for (const replay of [
    null,
    f.completion(saved.promptId, "cancelled"),
    f.completion("wrong-id"),
    f.completion(saved.promptId, "end_turn", "other-session"),
  ]) {
    f.behavior.replay = replay;
    const attempt = f.start();
    expect(await attempt.exited).toBe(1);
    expect(f.state().acknowledged).toBe(0);
    expect(f.requests).toHaveLength(1);
  }
  f.behavior.replay = f.completion(saved.promptId);
  const recovered = f.start();
  await until(() => f.offers.includes(9));
  recovered.kill();
  await recovered.exited;
  expect(f.requests).toHaveLength(1);
  expect(f.state().acknowledged).toBe(9);
  expect(f.replies).toEqual([]);
}, 15000);

test("process death during queued delivery preserves the command and recovery never submits it again", async () => {
  const f = await fixture();
  f.behavior.complete = false;
  const run = f.start();
  await until(() => f.requests.length === 1);
  expect(f.state().acknowledged).toBe(0);
  const competing = f.start();
  expect(await competing.exited).toBe(1);
  expect(await new Response(competing.stderr).text()).toContain("another wake bridge owns");
  run.kill("SIGKILL");
  await run.exited;
  const saved = JSON.parse(f.state().pending).command;
  f.behavior.replay = f.completion(saved.promptId);
  const resumed = f.start();
  await until(() => f.state()?.acknowledged === 9);
  resumed.kill();
  await resumed.exited;
  expect(f.requests).toHaveLength(1);
});

test("incompatible leader fails before dispatch and changing destination refuses existing state", async () => {
  const f = await fixture();
  f.behavior.version = 99;
  const invalid = f.start();
  expect(await invalid.exited).toBe(1);
  expect(f.requests).toHaveLength(0);
  expect(JSON.parse(f.state().pending).command.phase).toBe("prepared");
  f.config.target.cwd = join(f.dir, "other");
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const changed = f.start();
  expect(await changed.exited).toBe(1);
  expect(await new Response(changed.stderr).text()).toContain("binding differs");
});

for (const legacy of [true, false]) {
  test(`SIGTERM retains unfinished Grok ${legacy ? "legacy prompt" : "steering"} and its recovery without resend`, async () => {
    const f = await fixture(legacy);
    f.behavior.complete = false;
    const run = f.start();
    await until(() => f.requests.length === 1);
    run.kill();
    expect(await run.exited).toBe(0);
    expect(f.state().acknowledged).toBe(0);
    const saved = JSON.parse(f.state().pending);
    expect(saved.command.phase).toBe("attempted");
    const recovery = f.start();
    await until(() => f.loads.length === 2);
    recovery.kill();
    expect(await recovery.exited).toBe(0);
    expect(JSON.parse(f.state().pending)).toEqual(saved);
    expect(f.state().acknowledged).toBe(0);
    expect(f.requests).toHaveLength(1);
    if (legacy) {
      expect(f.offers).toEqual([]);
    }
    expect(readFileSync(f.configPath, "utf8")).not.toContain("authorization");
  });
}

test("Grok refuses a writable socket in a non-private directory", async () => {
  const f = await fixture();
  chmodSync(f.dir, 0o755);
  const run = f.start();
  expect(await run.exited).toBe(1);
  expect(await new Response(run.stderr).text()).toContain("private parent directory");
  expect(f.requests).toHaveLength(0);
});

test("a crash after durable marking but before dispatch never authorizes a resend", async () => {
  const f = await fixture();
  f.behavior.version = 99;
  const initial = f.start();
  expect(await initial.exited).toBe(1);
  expect(f.requests).toHaveLength(0);
  const pending = JSON.parse(f.state().pending);
  expect(pending.command.phase).toBe("prepared");
  pending.command.phase = "attempted";
  const stateDir = join(f.dir, "state/swarmail-bridge");
  const name = readdirSync(stateDir).find(
    (file) => file.endsWith(".sqlite") && !file.includes(".lock."),
  );
  const db = new Database(join(stateDir, name));
  db.query("UPDATE state SET pending = ?").run(JSON.stringify(pending));
  db.close();

  f.behavior.version = 1;
  f.behavior.drop = true; // A forbidden resend must fail without leaving a running bridge.
  const recovered = f.start();
  expect(await recovered.exited).toBe(1);
  expect(await new Response(recovered.stderr).text()).toContain("no resend");
  expect(f.requests).toHaveLength(0);
  expect(f.state().acknowledged).toBe(0);
  expect(JSON.parse(f.state().pending)).toEqual(pending);
});

for (const evidence of ["success", "cancelled", "wrong prompt", "wrong session"]) {
  test(`Grok recovery checks ${evidence} evidence across protocol event orderings`, async () => {
    const f = await fixture();
    const command = {
      phase: "attempted",
      promptId: "ordering-prompt",
      text: "Swarmail: pending mail",
    };
    f.behavior.replay = f.completion(
      evidence === "wrong prompt" ? "another-prompt" : command.promptId,
      evidence === "cancelled" ? "cancelled" : "end_turn",
      evidence === "wrong session" ? "another-session" : f.config.target.id,
    );
    const failures = [];
    let checked = 0;
    const enumerate = async (sequence, remaining) => {
      if (remaining.length) {
        for (const event of remaining) {
          await enumerate(
            [...sequence, event],
            remaining.filter((item) => item !== event),
          );
        }
        return;
      }
      f.behavior.sequence = sequence;
      const marks = [];
      let admitted = false;
      try {
        await deliverGrok(
          f.config.target,
          command,
          () => {
            marks.push(command.promptId);
          },
          new AbortController().signal,
        );
        admitted = true;
      } catch (error) {
        if (!error.message.includes("pending retained, no resend")) {
          failures.push(`${sequence.join(" -> ")}: unexpected failure ${error.message}`);
        }
      }
      await f.settled();
      const delivered = sequence.slice(0, sequence.indexOf("disconnect"));
      const expected =
        evidence === "success" &&
        delivered.includes("load reply") &&
        delivered.includes("completion");
      if (admitted !== expected) {
        failures.push(`${sequence.join(" -> ")}: expected admission ${expected}, got ${admitted}`);
      }
      if (marks.length || f.requests.length || f.replies.length) {
        failures.push(
          `${sequence.join(" -> ")}: recovery resubmitted or answered a shared request`,
        );
      }
      checked++;
    };
    await enumerate([], ["load reply", "completion", "permission", "disconnect"]);
    console.log(`Grok ${evidence}: checked ${checked} event permutations`);
    expect(checked).toBe(24);
    expect(failures).toEqual([]);
  });
}

test("native Grok interjection confirms actor admission without a queued prompt or turn cancellation", async () => {
  const f = await fixture(false);
  const run = f.start();
  await until(() => f.offers.includes(9));
  run.kill();
  await run.exited;
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].request.method).toBe("_x.ai/interject");
  const saved = JSON.parse(f.requests[0].state.pending).command;
  expect(f.requests[0].request.params).toEqual({
    sessionId: "native-session",
    text: saved.text,
    interjectionId: saved.promptId,
  });
  expect(saved.phase).toBe("attempted");
  expect(saved.delivery).toBe("steer");
  expect(f.state().acknowledged).toBe(9);
  expect(f.replies).toEqual([]);
});

for (const failure of ["drop", "mismatch", "missing-echo"]) {
  test(`unconfirmed Grok interjection ${failure} stays pending and is never resent`, async () => {
    const f = await fixture(false);
    f.behavior.drop = failure === "drop";
    f.behavior.mismatch = failure === "mismatch";
    f.behavior.complete = failure !== "missing-echo";
    const first = f.start();
    expect(await first.exited).toBe(1);
    const saved = JSON.parse(f.state().pending).command;
    f.behavior.drop = false;
    f.behavior.complete = true;
    const second = f.start();
    expect(await second.exited).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(f.state().acknowledged).toBe(0);
    expect(JSON.parse(f.state().pending).command).toEqual(saved);
  });
}

test("Grok steering admits only receipt and matching echo before disconnect in every ordering", async () => {
  const f = await fixture(false);
  const failures = [];
  let checked = 0;
  const enumerate = async (sequence, remaining) => {
    if (remaining.length) {
      for (const event of remaining) {
        await enumerate(
          [...sequence, event],
          remaining.filter((x) => x !== event),
        );
      }
      return;
    }
    f.behavior.interjectionSequence = sequence;
    const command = {
      phase: "prepared",
      promptId: `order-${checked}`,
      text: "Swarmail: pending mail",
      delivery: "steer",
    };
    let marks = 0;
    let admitted = false;
    try {
      await deliverGrok(
        f.config.target,
        command,
        () => {
          marks++;
          command.phase = "attempted";
        },
        new AbortController().signal,
      );
      admitted = true;
    } catch {
      /* A closed socket retains the attempted command for manual recovery. */
    }
    await f.settled();
    const beforeClose = sequence.slice(0, sequence.indexOf("disconnect"));
    const expected = beforeClose.includes("receipt") && beforeClose.includes("echo");
    if (admitted !== expected || marks !== 1) {
      failures.push({ sequence, admitted, expected, marks });
    }
    checked++;
  };
  await enumerate([], ["receipt", "echo", "permission", "disconnect"]);
  expect(checked).toBe(24);
  expect(f.requests).toHaveLength(24);
  expect(f.replies).toEqual([]);
  expect(failures).toEqual([]);
});
