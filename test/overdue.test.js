import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../src/mail.ts";
import { checkOverdue, overdue, overdueRows } from "../src/overdue.ts";
import { createServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "swarmail-overdue-"));
const dbPath = join(dir, "mail.sqlite3");
const { server, db } = createServer(dbPath, 0, { retireIdleDays: 0 });
const env = { SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/` };
const mcp = (name, args) => call(env, name, args);
const A = "/w/alpha";
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const row = (over = {}) => ({
  sender_retired: 0,
  id: 7,
  subject: "review please",
  project: A,
  sender: "BlueLake",
  recipient: "GreenCastle",
  created_ts: 0,
  ...over,
});

test("the deadline check reminds the recipient once, then tells the operator once, and forgets acknowledged mail", async () => {
  const calls = [];
  const notes = [];
  const pass = (rows, state, now, dryRun = false) =>
    checkOverdue({
      rows,
      call: async (name, args) => calls.push([name, args]),
      notify: (n) => notes.push(n),
      state,
      minutes: 30,
      now,
      dryRun,
    });
  const t0 = 40 * 60_000;
  const dry = await pass([row()], { nudged: {}, escalated: [] }, t0, true);
  expect(dry.actions).toHaveLength(1);
  expect(dry.state.nudged).toEqual({}); // a dry run records nothing
  expect(calls).toHaveLength(0);

  let { state, actions } = await pass([row()], { nudged: {}, escalated: [] }, t0);
  expect(actions).toHaveLength(1);
  expect(calls).toHaveLength(1);
  const [name, args] = calls[0];
  expect(name).toBe("reply_message");
  // Not the reply_message defaults: to the original sender, copying ack_required.
  expect(args).toMatchObject({
    message_id: 7,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    ack_required: false,
  });

  ({ state, actions } = await pass([row()], state, t0 + 10 * 60_000));
  expect(actions).toHaveLength(0);
  ({ state } = await pass([row()], state, t0 + 30 * 60_000));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ key: "swarmail-overdue:7:GreenCastle", severity: "warn" });
  ({ state, actions } = await pass([row()], state, t0 + 60 * 60_000));
  expect(actions).toHaveLength(0);
  expect(calls).toHaveLength(1);

  ({ state } = await pass([], state, t0 + 70 * 60_000));
  expect(state).toEqual({ nudged: {}, escalated: [] });
});

test("overdue rows skip acknowledged and retired recipients and mail outside the window", async () => {
  for (const name of ["BlueLake", "GreenCastle", "RedStone", "TanOwl"]) {
    await mcp("register_agent", { project_key: A, program: "t", model: "m", name });
  }
  const send = async (to) =>
    (
      await mcp("send_message", {
        project_key: A,
        sender_name: "BlueLake",
        to,
        subject: "ack me",
        body_md: "b",
        ack_required: true,
      })
    ).id;
  const id = await send(["GreenCastle", "RedStone", "TanOwl"]);
  await mcp("acknowledge_message", { project_key: A, agent_name: "RedStone", message_id: id });
  await mcp("retire_agent", { project_key: A, agent_name: "TanOwl" });
  const later = Date.now() + 40 * 60_000;
  expect(overdueRows(dbPath, 30, 24, later).map((r) => [r.id, r.recipient])).toEqual([
    [id, "GreenCastle"],
  ]);
  expect(overdueRows(dbPath, 30, 24, Date.now())).toEqual([]); // not 30 minutes old yet
  expect(overdueRows(dbPath, 30, 24, Date.now() + 25 * 3_600_000)).toEqual([]); // older than the window
});

test("overdue rows skip a delivery the sender withdrew", async () => {
  const P = "/w/withdrawn";
  for (const name of ["BlueLake", "GreenCastle", "RedStone"]) {
    await mcp("register_agent", { project_key: P, program: "t", model: "m", name });
  }
  const { id } = await mcp("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle", "RedStone"],
    subject: "ack me",
    body_md: "b",
    ack_required: true,
  });
  db.run(
    `UPDATE message_recipients SET withdrawn_ts = 1 WHERE message_id = ?1
       AND agent_id = (SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE p.human_key = ?2 AND a.name = 'GreenCastle')`,
    [id, P],
  );
  const later = Date.now() + 40 * 60_000;
  expect(
    overdueRows(dbPath, 30, 24, later)
      .filter((r) => r.project === P)
      .map((r) => [r.id, r.recipient]),
  ).toEqual([[id, "RedStone"]]);
});

test("a reminder goes in the thread as the original sender, and a retired sender's goes to the operator instead", async () => {
  const P = "/w/gamma";
  for (const name of ["BlueLake", "GreenCastle", "PinkFox"]) {
    await mcp("register_agent", { project_key: P, program: "t", model: "m", name });
  }
  const ask = async (sender) =>
    await mcp("send_message", {
      project_key: P,
      sender_name: sender,
      to: ["GreenCastle"],
      subject: `from ${sender}`,
      body_md: "b",
      ack_required: true,
    });
  const live = await ask("BlueLake");
  const gone = await ask("PinkFox");
  await mcp("retire_agent", { project_key: P, agent_name: "PinkFox" });
  const notes = [];
  const rows = overdueRows(dbPath, 30, 24, Date.now() + 40 * 60_000).filter((r) => r.project === P);
  const { state } = await checkOverdue({
    rows,
    call: mcp,
    notify: (n) => notes.push(n),
    state: { nudged: {}, escalated: [] },
    minutes: 30,
  });
  const inbox = await mcp("fetch_inbox", {
    project_key: P,
    agent_name: "GreenCastle",
    mark_read: false,
    include_bodies: true,
  });
  const reminders = inbox.filter((m) => m.subject.startsWith("Reminder (automatic):"));
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toMatchObject({
    from: "BlueLake",
    thread_id: String(live.thread_id ?? live.id),
    ack_required: false,
  });
  expect(notes.map((n) => n.key)).toEqual([`swarmail-overdue:${gone.id}:GreenCastle`]);
  expect(state.escalated).toEqual([`${gone.id}:GreenCastle`]);
});

test("reminder retries after lost responses or lost local state create one durable reply", async () => {
  for (const failure of ["lost response", "lost state"]) {
    const project = `/w/reminder-${failure.replaceAll(" ", "-")}`;
    for (const name of ["RetrySender", "RetryReceiver"]) {
      await mcp("register_agent", { project_key: project, name, program: "test", model: "m" });
    }
    const original = await mcp("send_message", {
      project_key: project,
      sender_name: "RetrySender",
      to: ["RetryReceiver"],
      subject: "acknowledge once",
      body_md: "please acknowledge",
      ack_required: true,
    });
    const overdue = row({
      id: original.id,
      project,
      sender: "RetrySender",
      recipient: "RetryReceiver",
      created_ts: Date.now() * 1000,
    });
    const notes = [];
    let loseResponse = failure === "lost response";
    const pass = (state, now) =>
      checkOverdue({
        rows: [overdue],
        state,
        minutes: 30,
        now,
        notify: (note) => notes.push(note),
        call: async (name, args) => {
          const result = await mcp(name, args);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("response lost after acceptance");
          }
          return result;
        },
      });
    const now = Date.now() + 40 * 60000;
    await pass({ nudged: {}, escalated: [] }, now);
    // A process restart can lose the entire local pass even though the reply committed.
    const retried = await pass({ nudged: {}, escalated: [] }, now + 10 * 60000);
    const inbox = await mcp("fetch_inbox", {
      project_key: project,
      agent_name: "RetryReceiver",
      mark_read: false,
    });
    expect(inbox.filter((m) => m.subject.startsWith("Reminder (automatic):"))).toHaveLength(1);
    expect(retried.state.nudged[`${original.id}:RetryReceiver`]).toBe(now + 10 * 60000);
    expect(retried.actions).toHaveLength(1);
  }
});

test("repeated reminder failures retry sending but escalate only once across passes", async () => {
  const notes = [];
  let calls = 0;
  let state = { nudged: {}, escalated: [] };
  for (const now of [40, 50, 60]) {
    ({ state } = await checkOverdue({
      rows: [row()],
      state,
      minutes: 30,
      now: now * 60000,
      call: async () => {
        calls++;
        throw new Error("server unavailable");
      },
      notify: (note) => notes.push(note),
    }));
  }
  expect(calls).toBe(3);
  expect(notes).toHaveLength(1);
  expect(state.escalated).toEqual(["7:GreenCastle"]);
});

/** Runs `fn` with console.log silenced; the command prints what it did. */
async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** A server of its own, so the commands below see only the mail they send. */
async function overdueSetup(project) {
  const root = mkdtempSync(join(tmpdir(), "swarmail-overdue-run-"));
  const own = createServer(join(root, "mail.sqlite3"), 0, { retireIdleDays: 0 });
  const env = {
    SWARMAIL_DB: join(root, "mail.sqlite3"),
    SWARMAIL_URL: `http://127.0.0.1:${own.server.port}/mcp/`,
    XDG_STATE_HOME: join(root, "state"),
    // A deadline of zero minutes makes mail overdue the moment it exists, and a second pass escalates.
    SWARMAIL_OVERDUE_MINUTES: "0",
  };
  const m = (name, args) => call(env, name, args);
  for (const name of ["BlueLake", "GreenCastle"]) {
    await m("register_agent", { project_key: project, program: "t", model: "m", name });
  }
  const sent = await m("send_message", {
    project_key: project,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "ack me",
    body_md: "b",
    ack_required: true,
  });
  await Bun.sleep(5);
  const stop = () => {
    own.server.stop(true);
    own.db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, env, id: sent.id, stop };
}

test("without SWARMAIL_NOTIFY an escalation runs nothing and is still recorded", async () => {
  const run = await overdueSetup("/w/notify");
  try {
    // The first pass reminds and the second escalates; neither may fail without a command to run.
    expect(await quiet(() => overdue([], run.env))).toBe(0);
    expect(await quiet(() => overdue([], run.env))).toBe(0);
    const state = JSON.parse(
      readFileSync(join(run.env.XDG_STATE_HOME, "swarmail-overdue", "state.json"), "utf8"),
    );
    expect(state.escalated).toEqual([`${run.id}:GreenCastle`]);
  } finally {
    run.stop();
  }
});

test.skipIf(process.platform === "win32")(
  "SWARMAIL_NOTIFY names the command that receives the escalation",
  async () => {
    const run = await overdueSetup("/w/notify-set");
    try {
      const out = join(run.root, "args.txt");
      const script = join(run.root, "notify.sh");
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`);
      chmodSync(script, 0o755);
      const env = { ...run.env, SWARMAIL_NOTIFY: script };
      await quiet(() => overdue([], env));
      expect(existsSync(out)).toBe(false); // the first pass only reminds
      await quiet(() => overdue([], env));
      const args = readFileSync(out, "utf8").trim().split("\n");
      expect(args.slice(0, 2)).toEqual(["--key", `swarmail-overdue:${run.id}:GreenCastle`]);
      expect(args).toContain("--source");
      expect(args[args.indexOf("--severity") + 1]).toBe("warn");
      expect(args[args.indexOf("--detail") + 1]).toBe("swarmail who /w/notify-set");
    } finally {
      run.stop();
    }
  },
);

test("the overdue command prints what it would do for --dry-run and records nothing", async () => {
  const run = await overdueSetup("/w/dry");
  try {
    const cli = join(import.meta.dir, "../src/cli.ts");
    const res = spawnSync(process.execPath, [cli, "overdue", "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ...run.env },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`would remind GreenCastle about #${run.id} from BlueLake`);
    expect(existsSync(join(run.env.XDG_STATE_HOME, "swarmail-overdue", "state.json"))).toBe(false);
  } finally {
    run.stop();
  }
});

test("a failing operator command is retried alone, and the rest of the pass is kept", async () => {
  const rows = [row({ id: 7 }), row({ id: 8 }), row({ id: 9 })];
  const t0 = 40 * 60_000;
  const calls = [];
  let failing = true;
  const pass = (state, now) =>
    checkOverdue({
      rows,
      state,
      minutes: 30,
      now,
      call: async (name, args) => calls.push(args.message_id),
      notify: (note) => {
        if (failing && note.key.endsWith("8:GreenCastle")) {
          throw new Error("notifier down");
        }
      },
    });
  let { state } = await pass({ nudged: {}, escalated: [] }, t0);
  expect(calls).toEqual([7, 8, 9]);
  const second = await pass(state, t0 + 30 * 60_000);
  // The failure is reported, not thrown, so the other two reports and the state still count.
  expect(second.failures).toHaveLength(1);
  expect(second.failures[0]).toContain("8:GreenCastle");
  expect(second.state.escalated).toEqual(["7:GreenCastle", "9:GreenCastle"]);
  expect(Object.keys(second.state.nudged).sort()).toEqual([
    "7:GreenCastle",
    "8:GreenCastle",
    "9:GreenCastle",
  ]);
  failing = false;
  const third = await pass(second.state, t0 + 40 * 60_000);
  expect(third.failures).toEqual([]);
  expect(third.state.escalated).toHaveLength(3);
});

test.skipIf(process.platform === "win32")(
  "the command saves its state and exits 1 when the SWARMAIL_NOTIFY command fails",
  async () => {
    const run = await overdueSetup("/w/notify-fails");
    try {
      const script = join(run.root, "fail.sh");
      writeFileSync(script, "#!/bin/sh\nexit 3\n");
      chmodSync(script, 0o755);
      const env = { ...run.env, SWARMAIL_NOTIFY: script };
      expect(await quiet(() => overdue([], env))).toBe(0); // the reminder pass
      expect(await quiet(() => overdue([], env))).toBe(1); // the report fails
      // A command that cannot start is a failed report too, not a crash.
      expect(
        await quiet(() => overdue([], { ...env, SWARMAIL_NOTIFY: join(run.root, "missing") })),
      ).toBe(1);
      const state = JSON.parse(
        readFileSync(join(env.XDG_STATE_HOME, "swarmail-overdue", "state.json"), "utf8"),
      );
      expect(Object.keys(state.nudged)).toEqual([`${run.id}:GreenCastle`]);
      expect(state.escalated).toEqual([]);
    } finally {
      run.stop();
    }
  },
);
