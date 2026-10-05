import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWakeState, peekUnreadMailboxes } from "../src/wake-state.ts";
import { t3NoticeAdapter } from "../src/wake-t3-notice.ts";
import { createServer } from "../src/server.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
const savedHome = process.env.XDG_STATE_HOME;
const cleanups = [];
function cleanupFixtures() {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
}
afterEach(() => {
  cleanupFixtures();
  process.env.XDG_STATE_HOME = savedHome;
});

// Bun 1.4.2 on Windows reenters socket dispatch inside expect().rejects.
async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function fixture(swarmailUrl) {
  const dir = mkdtempSync(join(scratch, "case-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env.XDG_STATE_HOME = dir;
  const id = "thread-notice";
  const unread = new Set();
  let snapshotResponse;
  if (!swarmailUrl) {
    const mail = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/wait/peek" || url.searchParams.get("session") !== id) {
          return new Response(null, { status: 404 });
        }
        return snapshotResponse
          ? snapshotResponse()
          : Response.json({
              mailboxes: [...unread].sort().map((project) => ({ recipient: "BlueLake", project })),
            });
      },
    });
    cleanups.push(() => mail.stop(true));
    swarmailUrl = `http://127.0.0.1:${mail.port}`;
  }
  /** @type {import("../src/wake-target.ts").T3ControlProjection} */
  const projection = {
    thread: { id, settledAt: null, settledOverride: null },
    runs: [],
    messages: [],
    runtimeRequests: [],
    providerThreads: [{ id: "provider-thread", providerSessionId: "provider-session" }],
    providerSessions: [
      {
        id: "provider-session",
        capabilities: {
          turns: {
            supportsActiveSteering: true,
            supportsInterrupt: true,
            supportsSteeringByInterruptRestart: true,
          },
        },
      },
    ],
    providerTurns: [],
  };
  const received = [];
  const receipts = new Map();
  let loseReply = false;
  let endPromotionTarget = false;
  let raceOperation;
  let finishTurnBeforeDispatch = false;
  let providerTurnRunning = true;
  let peakQueued = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
      }
      if (req.method === "GET") {
        for (const run of projection.runs) {
          if (run.activeAttemptId === undefined) {
            run.activeAttemptId = `attempt-${run.id}`;
          }
          if (run.rootNodeId === undefined) {
            run.rootNodeId = `node-${run.id}`;
          }
          if (run.providerThreadId === undefined) {
            run.providerThreadId = "provider-thread";
          }
        }
        projection.providerTurns = projection.runs
          .filter((run) => run.status === "running")
          .map((run) => ({
            runAttemptId: run.activeAttemptId,
            status: providerTurnRunning ? "running" : "completed",
          }));
        return Response.json({ projection });
      }
      if (finishTurnBeforeDispatch) {
        providerTurnRunning = false;
      }
      return Response.json({ ticket: "fixture-ticket" });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(raw);
        const command = frame.payload;
        received.push(command);
        let success = receipts.get(command.commandId);
        if (success === undefined) {
          success = true;
          const run = projection.runs.find(
            (run) => run.id === (command.runId ?? command.queuedRunId),
          );
          if (raceOperation === command.type) {
            raceOperation = undefined;
            run.status = "running";
          }
          if (command.type === "message.dispatch") {
            let active = projection.runs.find((candidate) =>
              ["preparing", "starting", "running", "waiting"].includes(candidate.status),
            );
            if (command.deliveryIntent === "steer" && active && active.status !== "running") {
              success = false;
            } else {
              if (active && !providerTurnRunning && command.deliveryIntent === "steer") {
                active.status = "completed";
                active = undefined; // Installed explicit steer falls back to a new turn after completion.
                providerTurnRunning = true;
              }
              projection.messages.push({
                id: command.messageId,
                text: command.text,
                createdBy: "user",
                creationSource: command.creationSource,
              });
              if (command.deliveryIntent !== "steer" || !active) {
                projection.runs.push({
                  id: `run-${command.messageId}`,
                  userMessageId: command.messageId,
                  status: command.deliveryIntent === "steer" ? "running" : "queued",
                });
              }
            }
          } else if (command.type === "queued-message.promote-to-steer") {
            if (endPromotionTarget) {
              endPromotionTarget = false;
              providerTurnRunning = false;
            }
            const active = projection.runs.find(
              (candidate) => candidate.id === command.targetRunId,
            );
            success =
              run?.status === "queued" && active?.status === "running" && providerTurnRunning;
            if (success) {
              run.status = "cancelled";
            }
          } else if (run?.status !== "queued") {
            success = false;
          } else if (command.type === "queued-run.edit") {
            projection.messages.find((message) => message.id === run.userMessageId).text =
              command.text;
          } else if (command.type === "queued-run.cancel") {
            run.status = "cancelled";
          }
          peakQueued = Math.max(
            peakQueued,
            projection.runs.filter((run) => run.status === "queued").length,
          );
          receipts.set(command.commandId, success);
        }
        if (loseReply === true || loseReply === command.type) {
          loseReply = false;
          ws.close();
        } else {
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: success
                ? { _tag: "Success", value: { sequence: receipts.size } }
                : { _tag: "Failure" },
            }),
          );
        }
      },
    },
  });
  cleanups.push(() => target.stop(true));
  const authorizationFile = join(dir, "authorization");
  writeFileSync(authorizationFile, "Bearer fixture-token", { mode: 0o600 });
  const config = {
    swarmailUrl,
    target: {
      type: "t3-v2-queue",
      url: `http://127.0.0.1:${target.port}`,
      id,
      authorizationFile,
      delivery: "auto",
    },
  };
  let state = openWakeState(config.swarmailUrl, id, "{}");
  cleanups.push(() => state.close());
  const adapter = () => t3NoticeAdapter(config, state);
  const queued = () =>
    projection.runs
      .filter((run) => run.status === "queued")
      .map((run) => projection.messages.find((message) => message.id === run.userMessageId));
  const legacy = async (eventId, hint) => {
    const a = adapter();
    const command = a.prepare({ eventId, hint });
    command.operation = {
      type: "message.dispatch",
      commandId: crypto.randomUUID(),
      threadId: id,
      messageId: command.messageId,
      text: hint,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    };
    state.savePending({ eventId, command });
    // Simulate a saved command admitted before rollout, then a stopped bridge awaiting restart.
    unread.add("repo-a");
    seenOffers.add(eventId);
    await import("../src/wake-target.ts").then(({ sendT3Command }) =>
      sendT3Command(config.target, command.operation),
    );
    state.saveContext({ messageId: command.messageId });
    state.accept(eventId);
    return command.messageId;
  };
  const seenOffers = new Set();
  const deliver = async (eventId, hint) => {
    // Synthetic mail events update only the boundary fixture. Real-server cases use their own inbox.
    const match = / in (repo-[ab]) from /.exec(hint);
    if (match && !seenOffers.has(eventId)) {
      unread.add(match[1]);
    }
    seenOffers.add(eventId);
    const a = adapter();
    if (!state.pending) {
      state.savePending({ eventId, command: a.prepare({ eventId, hint }) });
    }
    await a.deliver(state.pending, () => state.markAttempted(), new AbortController().signal);
    state.accept(state.pending.eventId);
  };
  const restart = () => {
    state.close();
    state = openWakeState(config.swarmailUrl, id, "{}");
  };
  return {
    projection,
    legacy,
    unread,
    arrive: (eventId, mailbox) => {
      seenOffers.add(eventId);
      unread.add(mailbox);
    },
    snapshot: (response) => {
      snapshotResponse = response;
    },
    received,
    queued,
    deliver,
    restart,
    adapter,
    get state() {
      return state;
    },
    get peakQueued() {
      return peakQueued;
    },
    lose: (type = true) => {
      loseReply = type;
    },
    race: () => {
      raceOperation = "queued-run.edit";
    },
    raceCancel: () => {
      raceOperation = "queued-run.cancel";
    },
    racePromotion: () => {
      raceOperation = "queued-message.promote-to-steer";
    },
    endPromotionTarget: () => {
      endPromotionTarget = true;
    },
    finishTurnDuringAdmission: () => {
      finishTurnBeforeDispatch = true;
    },
  };
}

const mailboxHint = (mailbox) =>
  `Swarmail: unread mail for BlueLake in ${JSON.stringify(mailbox)}.`;

const hint = (mailbox) =>
  `Swarmail: 1 new message for BlueLake in ${mailbox} from GoldMoose. Call fetch_inbox to read it.`;

test("successive mail steers the active run across restart and retains every mailbox", async () => {
  const f = fixture();
  await f.deliver(1, hint("repo-a"));
  const runId = f.projection.runs[0].id;
  f.restart();
  await f.deliver(2, hint("repo-b"));
  expect(f.queued()).toHaveLength(0);
  expect(f.projection.runs.filter((run) => run.status === "running").map((run) => run.id)).toEqual([
    runId,
  ]);
  expect(f.projection.messages.at(-1).text).toBe(
    "Swarmail: Fetch all unread mail with swarmail inbox --session.",
  );
  expect(f.state.readContext().hints).toEqual([mailboxHint("repo-a"), mailboxHint("repo-b")]);
  expect(f.received.every((command) => command.deliveryIntent === "steer")).toBe(true);
  expect(f.state.acknowledged).toBe(2);
});

test("explicit steering starts a new turn when the provider turn ends before admission", async () => {
  const f = fixture();
  await f.deliver(1, hint("repo-a"));
  f.finishTurnDuringAdmission();
  await f.deliver(2, hint("repo-b"));
  expect(f.queued()).toHaveLength(0);
  expect(f.projection.runs.map((run) => run.status)).toEqual(["completed", "running"]);
  expect(f.state.acknowledged).toBe(2);
});

test("coalescing wake offers leaves all Swarmail messages unread in the durable inbox", async () => {
  const dir = mkdtempSync(join(scratch, "mail-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const mail = createServer(join(dir, "mail.sqlite"), 0);
  cleanups.push(() => {
    mail.server.stop(true);
    mail.db.close();
  });
  const base = `http://127.0.0.1:${mail.server.port}`;
  const f = fixture(base);
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
    const result = await response.json();
    return JSON.parse(result.result.content[0].text);
  };
  for (const name of ["GoldMoose", "BlueLake"]) {
    await call("register_agent", {
      project_key: dir,
      name,
      program: "codex",
      model: "test",
      task_description: name === "BlueLake" ? "[t3:thread-notice] test" : "sender",
    });
  }
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const sent = await call("send_message", {
      project_key: dir,
      sender_name: "GoldMoose",
      to: ["BlueLake"],
      subject: `mail-${i}`,
      body_md: `body-${i}`,
    });
    ids.push(sent.id);
    const response = await fetch(
      `${base}/wait?session=thread-notice&after=${f.state.acknowledged}&timeout=1&retry=1`,
    );
    expect(response.status).toBe(200);
    await f.deliver(Number(response.headers.get("x-swarmail-event-id")), await response.text());
  }
  const inbox = await call("fetch_inbox", {
    project_key: dir,
    agent_name: "BlueLake",
    unread_only: true,
    mark_read: false,
    include_bodies: true,
  });
  expect(inbox.map((message) => message.id).sort()).toEqual(ids.sort());
  expect(inbox.map((message) => message.body_md).sort()).toEqual(["body-0", "body-1"]);
  expect(f.queued()).toHaveLength(0);
  expect(f.received).toHaveLength(2);
  await call("fetch_inbox", {
    project_key: dir,
    agent_name: "BlueLake",
    unread_only: true,
  });
  expect(f.projection.runs.filter((run) => run.status === "running")).toHaveLength(1);
  expect(mail.db.query("SELECT count(*) AS total FROM messages").get().total).toBe(2);
});

test("lost admission reply replays an immutable command after reopening the journal", async () => {
  const f = fixture();
  f.lose();
  await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("closed before admission");
  const original = structuredClone(f.received[0]);
  expect(f.state.acknowledged).toBe(0);
  f.restart();
  await f.deliver(1, hint("repo-a"));
  expect(f.received[1]).toEqual(original);
  expect(f.queued()).toHaveLength(0);
  expect(f.projection.runs.filter((run) => run.status === "running")).toHaveLength(1);
  expect(f.state.pending).toBeNull();
});

test("a queued notice starting during edit replans with a new id and preserves both mailboxes", async () => {
  const f = fixture();
  await f.legacy(1, hint("repo-a"));
  f.race();
  await f.deliver(2, hint("repo-b"));
  expect(f.queued()).toHaveLength(0);
  expect(f.projection.messages.at(-1).text).toBe(
    "Swarmail: Fetch all unread mail with swarmail inbox --session.",
  );
  expect(f.state.readContext().hints).toEqual([mailboxHint("repo-a"), mailboxHint("repo-b")]);
  expect(f.received.at(-1).type).toBe("message.dispatch");
  expect(f.received.at(-1).commandId).not.toBe(f.received.at(-2).commandId);
});

test("legacy duplicate queues compact without changing user prompts or automatic notifications", async () => {
  const f = fixture();
  await f.deliver(1, hint("repo-a"));
  f.received.length = 0;
  for (const [id, text, createdBy, notification] of [
    ["a", hint("repo-a"), "agent"],
    ["b", hint("repo-b"), "agent"],
    ["user", hint("user-text"), "user"],
    ["notification", hint("notification"), "agent", {}],
  ]) {
    f.projection.messages.push({ id, text, createdBy, creationSource: "server", notification });
    f.projection.runs.push({ id: `run-${id}`, userMessageId: id, status: "queued" });
  }
  f.unread.add("repo-a");
  f.unread.add("repo-b");
  const a = f.adapter();
  const offer = await a.wait(f.state.acknowledged, new AbortController().signal);
  expect(offer.eventId).toBe(1);
  await f.deliver(offer.eventId, offer.hint);
  expect(f.queued().map((message) => message.id)).toEqual(["user", "notification"]);
  expect(f.projection.messages.find((message) => message.id === "a").text).toBe(
    "Swarmail: Fetch all unread mail with swarmail inbox --session.",
  );
  expect(f.state.readContext().hints).toEqual([mailboxHint("repo-a"), mailboxHint("repo-b")]);
  expect(f.state.acknowledged).toBe(1);
});

for (const kind of [
  "user_input",
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]) {
  test(`pending ${kind} holds both new and previously journaled notices`, async () => {
    const f = fixture();
    f.projection.runtimeRequests.push({ status: "pending", kind });
    await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("operator response");
    expect(f.received).toHaveLength(0);
    expect(f.state.acknowledged).toBe(0);
    f.state.savePending({
      eventId: 1,
      command: {
        type: "message.dispatch",
        commandId: "legacy",
        threadId: "thread-notice",
        messageId: "legacy",
        text: hint("repo-a"),
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
    });
    await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("operator response");
    expect(f.received).toHaveLength(0);
    f.projection.runtimeRequests[0].status = "resolved";
    await f.deliver(1, hint("repo-a"));
    expect(f.received[0].commandId).toBe("legacy");
    expect(f.state.acknowledged).toBe(1);
  });
}

test("an incompatible projection retains the offer without dispatching", async () => {
  const cases = [
    ["runtimeRequests", { status: "pending" }],
    ["runtimeRequests", { status: "pending", kind: "new-approval-kind" }],
    ["runtimeRequests", { kind: "user_input", status: "unknown" }],
    ["runtimeRequests", null],
    ["runs", { id: "run", userMessageId: "message" }],
    ["runs", { id: "run", userMessageId: "message", status: "queued" }],
    ["messages", { id: "message", createdBy: "agent", creationSource: "server" }],
  ];
  for (const [field, entry] of cases) {
    const f = fixture();
    f.projection[field].push(entry);
    await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("control projection");
    expect(f.received).toHaveLength(0);
    expect(f.state.pending.eventId).toBe(1);
    expect(f.state.acknowledged).toBe(0);
  }
});

test("later mail steers the same active run without creating a queue", async () => {
  const f = fixture();
  await f.deliver(1, hint("repo-a"));
  await f.deliver(2, hint("repo-a"));
  expect(f.peakQueued).toBe(0);
  expect(f.queued()).toHaveLength(0);
  expect(f.received).toHaveLength(2);
});

test("read mail disappears from a queued notice while other unread mail remains", async () => {
  const f = fixture();
  await f.legacy(1, hint("repo-a"));
  f.projection.runs.push({ id: "human-active", status: "running", userMessageId: null });
  f.unread.clear();
  await f.deliver(2, hint("repo-b"));
  expect(f.state.readContext().hints).toEqual([mailboxHint("repo-b")]);
  expect(
    f.projection.messages.find((message) => message.id === f.state.readContext().messageId).text,
  ).toBe("Swarmail: Fetch all unread mail with swarmail inbox --session.");
});

test("an empty current inbox cancels only queued mail notices", async () => {
  const f = fixture();
  await f.legacy(1, hint("repo-a"));
  f.projection.messages.push({
    id: "human",
    text: "Swarmail: user text",
    createdBy: "user",
    creationSource: "web",
  });
  f.projection.runs.push({ id: "human-run", userMessageId: "human", status: "queued" });
  f.unread.clear();
  const offer = await f.adapter().wait(1, new AbortController().signal);
  await f.deliver(offer.eventId, offer.hint);
  expect(f.queued().map((m) => m.id)).toEqual(["human"]);
  expect(f.state.readContext()).toBeNull();
  expect(f.state.acknowledged).toBe(1);
});

test("a lost steer reply replays unchanged for mail read during restart", async () => {
  const f = fixture();
  f.lose();
  await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("closed before admission");
  const original = structuredClone(f.received[0]);
  f.unread.clear();
  f.restart();
  await f.deliver(1, hint("repo-a"));
  expect(f.received[1]).toEqual(original);
  expect(f.received).toHaveLength(2);
  expect(f.projection.runs[0].status).toBe("running");
  expect(f.queued()).toHaveLength(0);
  expect(f.state.acknowledged).toBe(1);
});

test("a notice starting during stale cancellation remains active", async () => {
  const f = fixture();
  await f.legacy(1, hint("repo-a"));
  const original = structuredClone(f.queued()[0]);
  f.unread.clear();
  f.raceCancel();
  await f.deliver(1, hint("repo-a"));
  expect(f.queued()).toHaveLength(0);
  expect(f.projection.runs[0].status).toBe("running");
  expect(f.projection.messages[0]).toEqual(original);
  expect(f.received.map((command) => command.type)).toEqual([
    "message.dispatch",
    "queued-run.cancel",
  ]);
  expect(f.state.pending).toBeNull();
});

test("human requests and settlement hold obsolete notice cancellation across restart", async () => {
  for (const guard of ["human", "settled"]) {
    const f = fixture();
    await f.legacy(1, hint("repo-a"));
    f.unread.clear();
    if (guard === "human") {
      f.projection.runtimeRequests.push({ status: "pending", kind: "permission" });
    } else {
      f.projection.thread.settledOverride = "settled";
    }
    expect(await rejected(f.deliver(1, hint("repo-a")))).toMatchObject({ retryable: true });
    const pending = structuredClone(f.state.pending);
    f.restart();
    expect(await rejected(f.deliver(1, hint("repo-a")))).toMatchObject({ retryable: true });
    expect(f.received).toHaveLength(1);
    expect(f.queued()).toHaveLength(1);
    expect(f.state.pending).toEqual(pending);
    f.projection.runtimeRequests = [];
    f.projection.thread.settledOverride = null;
    await f.deliver(1, hint("repo-a"));
    expect(f.queued()).toHaveLength(0);
    cleanupFixtures();
  }
});

test("unavailable or malformed snapshots retain the pending offer and queued notice", async () => {
  const invalid = [
    () => new Response(null, { status: 503 }),
    () => new Response("legacy wake text"),
    () => Response.json({}),
    () => Response.json({ mailboxes: [{ recipient: "BlueLake" }] }),
    () => Response.json({ mailboxes: [null] }),
    () =>
      Response.json({ mailboxes: Array(1001).fill({ recipient: "BlueLake", project: "repo-a" }) }),
    () =>
      Response.json({
        mailboxes: [
          { recipient: "BlueLake", project: "repo-a" },
          { recipient: "BlueLake", project: "repo-a" },
        ],
      }),
  ];
  for (const response of invalid) {
    const f = fixture();
    await f.legacy(1, hint("repo-a"));
    const original = structuredClone(f.queued());
    f.snapshot(response);
    expect(await rejected(f.deliver(2, hint("repo-b")))).toMatchObject({ retryable: true });
    expect(f.received).toHaveLength(1);
    expect(f.queued()).toEqual(original);
    expect(f.state.acknowledged).toBe(1);
    expect(f.state.pending.eventId).toBe(2);
    cleanupFixtures();
  }
});

test("an older core rejects snapshots without entering its mutating wait route", async () => {
  const waits = [];
  const legacy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/wait") {
        waits.push(url.search);
        return new Response("Swarmail: legacy offer", { headers: { "x-swarmail-event-id": "1" } });
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => legacy.stop(true));
  expect(
    await rejected(
      peekUnreadMailboxes(
        {
          swarmailUrl: `http://127.0.0.1:${legacy.port}`,
          target: { id: "legacy-session" },
        },
        new AbortController().signal,
      ),
    ),
  ).toMatchObject({ retryable: true });
  expect(waits).toHaveLength(0);
});

test("matching owned user/server queue is promoted without touching an unrelated user queue", async () => {
  const f = fixture();
  const id = await f.legacy(1, hint("repo-a"));
  f.projection.runs.push({ id: "human-active", status: "running", userMessageId: null });
  f.projection.messages.push({
    id: "unrelated",
    text: hint("repo-a"),
    createdBy: "user",
    creationSource: "server",
  });
  f.projection.runs.push({ id: "unrelated-run", status: "queued", userMessageId: "unrelated" });
  const offer = await f.adapter().wait(1, new AbortController().signal);
  await f.deliver(offer.eventId, offer.hint);
  expect(f.received.at(-1)).toMatchObject({
    type: "queued-message.promote-to-steer",
    queuedRunId: `run-${id}`,
    targetRunId: "human-active",
  });
  expect(f.queued().map((message) => message.id)).toEqual(["unrelated"]);
  expect(f.projection.messages.find((message) => message.id === id).createdBy).toBe("user");
});

for (const status of ["preparing", "starting", "waiting"]) {
  test(`steering holds ${status} transitions before saving an operation`, async () => {
    const f = fixture();
    f.projection.runs.push({ id: "active", status, userMessageId: null });
    expect(await rejected(f.deliver(1, hint("repo-a")))).toMatchObject({ retryable: true });
    expect(f.received).toHaveLength(0);
    expect(f.state.pending.command.operation).toBeUndefined();
    f.projection.runs[0].status = "running";
    f.restart();
    await f.deliver(1, hint("repo-a"));
    expect(f.queued()).toHaveLength(0);
    expect(f.received[0].deliveryIntent).toBe("steer");
  });
}

test("unsupported steering holds the offer rather than silently queueing", async () => {
  const f = fixture();
  f.projection.runs.push({ id: "active", status: "running", userMessageId: null });
  f.projection.providerSessions[0].capabilities.turns.supportsActiveSteering = false;
  f.projection.providerSessions[0].capabilities.turns.supportsSteeringByInterruptRestart = false;
  expect(await rejected(f.deliver(1, hint("repo-a")))).toMatchObject({ retryable: true });
  expect(f.received).toHaveLength(0);
  expect(f.state.acknowledged).toBe(0);
});

const events = [
  "mail-a",
  "mail-b",
  "read-a",
  "read-b",
  "start",
  "cancel",
  "restart",
  "settle",
  "reactivate",
];
const sequences = events.flatMap((first) =>
  events.flatMap((second) => events.map((third) => [first, second, third])),
);
for (const sequence of sequences) {
  test(`mail queue ordering: ${sequence.join(" -> ")}`, async () => {
    const failures = [];
    const f = fixture();
    const outstanding = new Set();
    const offers = [];
    let cursor = 0;
    let held = false;
    let needsReconciliation = false;
    for (const event of sequence) {
      if (event.startsWith("mail-")) {
        const mailbox = `repo-${event.slice(-1)}`;
        outstanding.add(mailbox);
        offers.push({ eventId: ++cursor, mailbox });
        f.arrive(cursor, mailbox);
      } else if (event.startsWith("read-")) {
        const mailbox = `repo-${event.slice(-1)}`;
        const context = f.state.readContext();
        needsReconciliation ||= Boolean(
          context?.hints.includes(mailboxHint(mailbox)) &&
          f.queued().some((message) => message.id === context.messageId),
        );
        f.unread.delete(mailbox);
        outstanding.delete(mailbox);
      } else if (event === "settle" || event === "reactivate") {
        held = event === "settle";
        f.projection.thread.settledOverride = held ? "settled" : null;
      } else if (event === "restart") {
        f.restart();
      } else {
        for (const run of f.projection.runs.filter((run) => run.status === "queued")) {
          run.status = event === "start" ? "running" : "cancelled";
        }
        outstanding.clear(); // Only already admitted notices have started or been cancelled.
        for (const offer of offers) {
          if (f.unread.has(offer.mailbox)) {
            outstanding.add(offer.mailbox);
          }
        }
      }
      const before = { received: f.received.length, acknowledged: f.state.acknowledged };
      if (held && offers.length) {
        expect(await rejected(f.deliver(offers[0].eventId, hint(offers[0].mailbox)))).toMatchObject(
          {
            retryable: true,
          },
        );
      } else {
        while (offers.length) {
          const offer = offers[0];
          await f.deliver(offer.eventId, hint(offer.mailbox));
          offers.shift();
          needsReconciliation = false;
        }
        if (!held && needsReconciliation && f.queued().length) {
          const reconciliation = await f
            .adapter()
            .wait(f.state.acknowledged, new AbortController().signal);
          expect(reconciliation.eventId).toBe(f.state.acknowledged);
          await f.deliver(reconciliation.eventId, reconciliation.hint);
          needsReconciliation = false;
        }
      }
      const queued = f.queued();
      if (
        f.peakQueued > 1 ||
        queued.length > 1 ||
        [...outstanding].some(
          (mailbox) =>
            !(
              f.state.readContext()?.hints.includes(mailboxHint(mailbox)) &&
              f.projection.messages.some(
                (message) => message.id === f.state.readContext()?.messageId,
              )
            ) && !offers.some((offer) => offer.mailbox === mailbox),
        ) ||
        f.state.acknowledged !== cursor - offers.length ||
        (held &&
          (f.received.length !== before.received || f.state.acknowledged !== before.acknowledged))
      ) {
        failures.push(sequence.join(" -> ") + " after " + event);
      }
    }
    expect(failures).toEqual([]);
  });
}

// A supervisor scan can lag settlement after an offer was durably saved.
test("settlement holds a journaled notice across restart until reactivation", async () => {
  for (const field of ["settledAt", "settledOverride"]) {
    const f = fixture();
    const a = f.adapter();
    f.state.savePending({ eventId: 1, command: a.prepare({ eventId: 1, hint: hint("repo-a") }) });
    // A saved operation must also stay untouched while settled.
    f.state.pending.command.operation = {
      type: "message.dispatch",
      commandId: "saved-command",
      threadId: "thread-notice",
      messageId: f.state.pending.command.messageId,
      text: hint("repo-a"),
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    };
    f.state.savePending(f.state.pending);
    const original = structuredClone(f.state.pending);
    f.projection.thread[field] = field === "settledAt" ? "2026-10-03T03:00:00Z" : "settled";
    f.restart();
    await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("settled");
    expect(f.received).toHaveLength(0);
    expect(f.state.acknowledged).toBe(0);
    expect(f.state.pending).toEqual(original);
    f.projection.thread.settledAt = null;
    f.projection.thread.settledOverride = "active";
    f.projection.runs.push({ id: "human-active", userMessageId: null, status: "running" });
    await f.deliver(1, hint("repo-a"));
    expect(f.received[0]).toEqual(original.command.operation);
    expect(f.state.acknowledged).toBe(1);
    expect(f.state.pending).toBeNull();
  }
});

test("missing or unknown settlement metadata holds the saved offer without dispatch", async () => {
  for (const change of [
    (thread) => delete thread.settledAt,
    (thread) => delete thread.settledOverride,
    (thread) => {
      thread.settledAt = false;
    },
    (thread) => {
      thread.settledOverride = "unknown";
    },
  ]) {
    const f = fixture();
    change(f.projection.thread);
    await expect(f.deliver(1, hint("repo-a"))).rejects.toThrow("settlement state unavailable");
    expect(f.received).toHaveLength(0);
    expect(f.state.acknowledged).toBe(0);
    expect(f.state.pending.eventId).toBe(1);
  }
});

for (const text of ["/compact", "/logout", "  /COMPACT  "]) {
  test(`native maintenance ${text.trim()} holds steering until the run finishes`, async () => {
    const f = fixture();
    f.projection.messages.push({
      id: "maintenance",
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "server",
    });
    f.projection.runs.push({
      id: "maintenance-run",
      status: "running",
      userMessageId: "maintenance",
    });
    expect(await rejected(f.deliver(1, hint("repo-a")))).toMatchObject({ retryable: true });
    expect(f.received).toHaveLength(0);
    expect(f.state.pending.command.operation).toBeUndefined();
    f.projection.runs[0].status = "completed";
    f.restart();
    await f.deliver(1, hint("repo-a"));
    expect(f.received[0].deliveryIntent).toBe("steer");
    expect(f.queued()).toHaveLength(0);
    expect(f.state.acknowledged).toBe(1);
  });
}

for (const race of ["lost reply", "source started", "target ended"]) {
  test(`legacy queue promotion ${race} preserves the saved operation and never duplicates delivery`, async () => {
    const f = fixture();
    const id = await f.legacy(1, hint("repo-a"));
    f.projection.runs.push({ id: "human-active", status: "running", userMessageId: null });
    if (race === "lost reply") {
      f.lose("queued-message.promote-to-steer");
    }
    if (race === "source started") {
      f.racePromotion();
    }
    if (race === "target ended") {
      f.endPromotionTarget();
    }
    let held = false;
    try {
      await f.deliver(1, hint("repo-a"));
    } catch (error) {
      held = true;
      expect(error.retryable).toBe(true);
    }
    const operation = structuredClone(f.received.at(-1));
    expect(operation.type).toBe("queued-message.promote-to-steer");
    if (race === "lost reply") {
      expect(held).toBe(true);
      f.restart();
      await f.deliver(1, hint("repo-a"));
      expect(f.received.at(-1)).toEqual(operation);
      expect(f.queued()).toHaveLength(0);
      expect(f.projection.messages.filter((m) => m.id === id)).toHaveLength(1);
    } else if (race === "source started") {
      expect(held).toBe(false);
      expect(f.projection.runs.find((r) => r.id === `run-${id}`).status).toBe("running");
      expect(f.received.filter((c) => c.type === "message.dispatch")).toHaveLength(1); // original legacy admission
    } else {
      expect(held).toBe(true);
      expect(f.queued()).toHaveLength(1);
      expect(f.state.pending.command.operation).toBeUndefined();
      f.projection.runs.find((r) => r.id === "human-active").status = "completed";
      f.projection.runs.find((r) => r.id === `run-${id}`).status = "running";
      f.restart();
      await f.deliver(1, hint("repo-a"));
      expect(f.state.pending).toBeNull();
    }
    expect(f.state.acknowledged).toBe(1);
  });
}
