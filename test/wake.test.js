import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../src/proc.ts";
import { createServer } from "../src/server.ts";
import { createWaiters } from "../src/wake.ts";

// Run from a session that has the Claude Code mod, the hooks spawned here would inherit this and stand down.
delete process.env.SWARMAIL_WAKE_MOD;

const P = "/w/project";
// Stands in for the host that runs the hook.
const HOST = join(import.meta.dir, "fixtures/wake-host.js");
const HOOKS = {
  "swarmail hook wake": [process.execPath, join(import.meta.dir, "../src/cli.ts"), "hook", "wake"],
};
let dir, server, db, base;
let previousState;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "swarmail-wake-"));
  previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dir, "state");
  // No short poll: waits here end only through the notify on send.
  ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
  base = `http://127.0.0.1:${server.port}`;
  await call("register_agent", {
    project_key: P,
    program: "claude-code",
    model: "m",
    name: "GreenCastle",
    task_description: "[t3:th-1 claude:s-1 cwd:~/w] review",
  });
  await call("register_agent", {
    project_key: P,
    program: "claude-code",
    model: "m",
    name: "TanOwl",
    task_description: "[claude:s-10] other",
  });
  await call("register_agent", {
    project_key: P,
    program: "cursor",
    model: "m",
    name: "PinkFox",
    task_description: "[cursor:c-1] cursor",
  });
  await call("register_agent", { project_key: P, program: "codex", model: "m", name: "BlueLake" });
});
beforeEach(async () => {
  await call("fetch_session_inbox", {
    host: "claude",
    session_id: "s-1",
    t3_thread: "th-1",
    limit: 1000,
  });
  await call("fetch_session_inbox", { host: "cursor", session_id: "c-1", limit: 1000 });
});
afterAll(() => {
  if (previousState === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = previousState;
  }
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name, args) {
  const res = await fetch(`${base}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return JSON.parse((await res.json()).result.content[0].text);
}
const send = (to) =>
  call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: [to],
    subject: "secret subject",
    body_md: "secret body",
    notification_policy: "wake",
  });
/**
 * The PID in the Claude hook's PID file for session s-1 once it names `pid` (or any PID), or 0 after 5 s. On Windows
 * the hook reads its host's command line through PowerShell before it waits, which takes about half a second.
 */
async function waiting(pid) {
  for (let i = 0; i < 50; i++) {
    const found = parseInt(
      existsSync(join(dir, "state/swarmail-wake/s-1")) &&
        readFileSync(join(dir, "state/swarmail-wake/s-1"), "utf8"),
    );
    if (found && (pid === undefined || found === pid)) {
      return found;
    }
    await Bun.sleep(100);
  }
  return 0;
}
const wait = (session, timeout = 5) => fetch(`${base}/wait?session=${session}&timeout=${timeout}`);

test("wakes a session for unread mail to its tagged agent only with one inbox instruction", async () => {
  await send("GreenCastle"); // unread before the session's first wait: announced at once
  let res = await wait("s-1");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Swarmail: run swarmail inbox --session.\n");
  await call("fetch_session_inbox", {
    host: "claude",
    session_id: "s-1",
    t3_thread: "th-1",
    limit: 1000,
  });
  const pending = wait("s-1");
  await Bun.sleep(100);
  await send("TanOwl"); // tag claude:s-10, not s-1
  await Bun.sleep(100);
  await send("GreenCastle");
  res = await pending;
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Swarmail: run swarmail inbox --session.\n");
  // Already announced: the next wait holds until newer mail or its timeout.
  expect((await wait("s-1", 1)).status).toBe(204);
});

test("a retried wait gets a lost hint again, and a restarted server does not re-announce", async () => {
  await send("GreenCastle");
  expect((await wait("s-1")).status).toBe(200);
  const retried = await fetch(`${base}/wait?session=s-1&timeout=5&retry=1`);
  expect(await retried.text()).toBe("Swarmail: run swarmail inbox --session.\n");
  expect((await wait("s-1", 1)).status).toBe(204);

  // A second server on the same database stands in for a restart.
  const other = createServer(join(dir, "mail.sqlite3"), 0, { wakePollMs: 20 });
  try {
    const waitOther = (timeout) =>
      fetch(`http://127.0.0.1:${other.server.port}/wait?session=s-1&timeout=${timeout}`);
    expect((await waitOther(1)).status).toBe(204);
    await call("fetch_session_inbox", {
      host: "claude",
      session_id: "s-1",
      t3_thread: "th-1",
      limit: 1000,
    });
    const pending = waitOther(5);
    await Bun.sleep(100);
    await send("GreenCastle");
    expect(await (await pending).text()).toBe("Swarmail: run swarmail inbox --session.\n");
  } finally {
    other.server.stop(true);
    other.db.close();
  }
});

test("a newer wait for the same session ends the older one", async () => {
  const first = wait("s-1", 30);
  await Bun.sleep(100);
  const started = Date.now();
  const second = wait("s-1", 1);
  expect((await first).status).toBe(409);
  expect(Date.now() - started).toBeLessThan(800); // ended by the second wait, not its own timeout
  expect((await second).status).toBe(204);
  expect((await wait("bad/session")).status).toBe(400);
});

test("one instruction covers normal and urgent mail across repositories", async () => {
  const Q = "/w/other";
  for (const [name, task] of [
    ["GreenCastle", "[claude:s-1] other repo"],
    ["BlueLake", "sender"],
  ]) {
    await call("register_agent", {
      project_key: Q,
      program: "claude-code",
      model: "m",
      name,
      task_description: task,
    });
  }
  await send("GreenCastle");
  await call("send_message", {
    project_key: Q,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "s",
    body_md: "b",
    importance: "urgent",
  });
  expect(await (await wait("s-1")).text()).toBe("Swarmail: run swarmail inbox --session.\n");
  expect((await wait("s-1", 1)).status).toBe(204);
});

test("a ping is answered while the hook waits and wakes no one", async () => {
  const pending = wait("s-1", 1);
  await Bun.sleep(100);
  await call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "swarmail ping",
    body_md: "ping",
    thread_id: "ping-t",
  });
  expect((await pending).status).toBe(204);
  const pong = db
    .query(
      `SELECT s.name AS sender, a.name AS recipient, r.read_ts FROM messages m
       JOIN agents s ON s.id = m.sender_id JOIN message_recipients r ON r.message_id = m.id
       JOIN agents a ON a.id = r.agent_id WHERE m.thread_id = 'ping-t' AND m.subject = 'swarmail pong'`,
    )
    .get();
  expect(pong).toMatchObject({ sender: "GreenCastle", recipient: "BlueLake" });
  expect(pong.read_ts).not.toBeNull();
  const unread = await call("fetch_inbox", {
    project_key: P,
    agent_name: "GreenCastle",
    unread_only: true,
    mark_read: false,
  });
  expect(unread.some((m) => m.subject === "swarmail ping")).toBe(false);
});

test("the shell-free re-arm starts a wait only for a registered session with no live waiter", async () => {
  const state = join(dir, "rearm-state");
  const env = {
    ...process.env,
    SWARMAIL_WAKE_URL: base,
    CLAUDE_PID: String(process.pid),
    CLAUDE_CODE_SESSION_ID: "s-1",
    XDG_STATE_HOME: state,
  };
  const input = JSON.stringify({
    session_id: "s-1",
    transcript_path: "/h/.claude/projects/w/s-1.jsonl",
  });
  const cli = join(import.meta.dir, "../src/cli.ts");
  const rearm = (extra = {}, args = ["rearm"]) =>
    Bun.spawn([process.execPath, cli, "hook", ...args], {
      stdin: new Blob([input]),
      env: { ...env, ...extra },
      stderr: "pipe",
    });
  const skips = async (extra) => {
    const started = Date.now();
    expect(await rearm(extra).exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  };
  const pidFile = join(state, "swarmail-wake/s-1");
  await skips(); // not registered
  mkdirSync(join(state, "swarmail-register"), { recursive: true });
  writeFileSync(join(state, "swarmail-register/s-1.json"), "{}");
  await skips({ CLAUDE_CODE_SESSION_ID: "" });
  await skips({ SWARMAIL_WAKE_MOD: "1" }); // the Swarmail mod waits instead
  mkdirSync(join(state, "swarmail-wake"));
  writeFileSync(pidFile, `${process.pid}\n${processIdentity(process.pid).start}\n`);
  await skips(); // a live waiter
  expect(await rearm({}, ["wake", "claude", "soon"]).exited).toBe(64);
  // The waiter exited without cleaning up, and a live process now holds its PID: the start time differs.
  writeFileSync(pidFile, `${process.pid}\n1\n`);
  // The arguments cmd passes for the Windows command, which has no `;` separator there.
  const waits = rearm({}, ["rearm;", "exit", "$LASTEXITCODE"]);
  // The wait writes its PID file only after it reads its host's command line, which on Windows starts
  // PowerShell: normally about a second, but a loaded runner has taken longer than 5 s.
  for (let i = 0; i < 150 && parseInt(readFileSync(pidFile, "utf8")) !== waits.pid; i++) {
    await Bun.sleep(100);
  }
  expect(parseInt(readFileSync(pidFile, "utf8"))).toBe(waits.pid);
  await send("GreenCastle");
  expect(await waits.exited).toBe(2);
  expect(await new Response(waits.stderr).text()).toBe("Swarmail: run swarmail inbox --session.\n");
}, 20000);

for (const [name, hook] of Object.entries(HOOKS)) {
  describe(name, () => {
    test("the hook script wakes Claude with exit 2 and Cursor with a followup message", async () => {
      mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
      writeFileSync(join(dir, "state/swarmail-register/s-1.json"), "{}");
      const env = {
        ...process.env,
        SWARMAIL_WAKE_URL: base,
        CLAUDE_PID: String(process.pid),
        XDG_STATE_HOME: join(dir, "state"),
      };
      const run = (host, input) =>
        Bun.spawn([...hook, host, "5"], {
          stdin: new Blob([JSON.stringify(input)]),
          env,
          stderr: "pipe",
        });

      const claude = run("claude", {
        session_id: "s-1",
        transcript_path: "/h/.claude/projects/w/s-1.jsonl",
        hook_event_name: "Stop",
      });
      const cursor = run("cursor", { conversation_id: "c-1", hook_event_name: "stop" });
      // The waiting Claude hook advertises its PID for the PostToolUse re-arm, and clears it on exit.
      const pidFile = join(dir, "state/swarmail-wake/s-1");
      expect(await waiting(claude.pid)).toBe(claude.pid);
      await send("GreenCastle");
      await send("PinkFox");
      expect(await claude.exited).toBe(2);
      expect(existsSync(pidFile)).toBe(false);
      expect(await new Response(claude.stderr).text()).toContain(
        "Swarmail: run swarmail inbox --session.\n",
      );
      await cursor.exited;
      expect(JSON.parse(await new Response(cursor.stdout).text()).followup_message).toContain(
        "Swarmail: run swarmail inbox --session.",
      );

      // With no server, Claude gets no output and Cursor an empty decision.
      const down = { ...process.env, SWARMAIL_WAKE_URL: "http://127.0.0.1:9" };
      const idle = Bun.spawn([...hook, "cursor", "1"], {
        stdin: new Blob(['{"conversation_id":"c-1"}']),
        env: down,
      });
      expect(await idle.exited).toBe(0);
      expect((await new Response(idle.stdout).text()).trim()).toBe("{}");
    }, 20000);

    test("the Claude hook exits at once outside a registered, long-lived Claude session", async () => {
      // Claude holds `claude -p` open, and a one-prompt SDK process ~30 s, while an async hook runs.
      const unrelated = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
      const env = { ...process.env, SWARMAIL_WAKE_URL: base, XDG_STATE_HOME: join(dir, "state") };
      const input = (session, transcript = `/h/.claude/projects/w/${session}.jsonl`) =>
        JSON.stringify({ session_id: session, transcript_path: transcript });
      // The host stands in for Claude: CLAUDE_PID names it, and its command line ends in the flag.
      const underClaude = (flag, session, transcript) => ({
        cmd: [process.execPath, HOST, flag],
        host: {
          HOST_HOOK: JSON.stringify([...hook, "claude", "5"]),
          HOST_INPUT: input(session, transcript),
        },
      });
      writeFileSync(
        join(dir, "state/swarmail-register/s-ended.json"),
        JSON.stringify({ name: null, projects: [], ended: "2026-09-30T23:00:00Z" }),
      );
      const cases = [
        underClaude("--resume", "s-ended"), // End record before any registration.
        underClaude("-p", "s-1"), // `claude -p`
        underClaude("--resume", "s-unregistered"), // no register-hook state
        underClaude("--resume", "s-1", "/h/.grok/sessions/s-1.jsonl"), // Grok or Devin started by Claude
        { cmd: [...hook, "claude", "5"], CLAUDE_PID: "", session: "s-1" }, // Devin or Cursor running ~/.claude/settings.json hooks
        { cmd: [...hook, "claude", "5"], CLAUDE_PID: String(unrelated.pid), session: "s-1" }, // ... started from a Claude session
        { ...underClaude("--resume", "s-1"), extra: { SWARMAIL_WAKE_MOD: "1" } }, // the Swarmail mod waits instead
      ];
      try {
        for (const { cmd, host, CLAUDE_PID, session, extra } of cases) {
          const started = Date.now();
          const run = Bun.spawn(cmd, {
            stdin: session ? new Blob([input(session)]) : "ignore",
            env: { ...env, ...host, ...(CLAUDE_PID !== undefined && { CLAUDE_PID }), ...extra },
          });
          expect(await run.exited).toBe(0);
          // Reading the host's command line on Windows takes PowerShell about half a second.
          expect(Date.now() - started).toBeLessThan(3000);
        }
        // Control: the same shape under a registered, interactive Claude waits for mail.
        const control = underClaude("--resume", "s-1");
        const waits = Bun.spawn(control.cmd, { env: { ...env, ...control.host }, stderr: "pipe" });
        expect(await waiting()).toBeGreaterThan(0);
        await send("GreenCastle");
        expect(await waits.exited).toBe(2);
      } finally {
        unrelated.kill();
      }
    }, 20000);

    test("the hook stops waiting when its host exits", async () => {
      // Cursor runs the hook under a shell of its own and, on quit, leaves it running.
      const out = join(dir, "orphan.out");
      const host = Bun.spawn([process.execPath, HOST], {
        env: {
          ...process.env,
          SWARMAIL_WAKE_URL: base,
          SWARMAIL_WAKE_CHUNK: "1", // checks the host every second
          HOST_HOOK: JSON.stringify([...hook, "cursor", "60"]),
          HOST_INPUT: JSON.stringify({ conversation_id: "c-1" }),
          HOST_OUT: out,
          HOST_NEST: "1",
        },
      });
      await Bun.sleep(500);
      host.kill("SIGKILL");
      for (let i = 0; i < 100 && !(existsSync(out) && readFileSync(out, "utf8")); i++) {
        await Bun.sleep(100);
      }
      expect(readFileSync(out, "utf8").trim()).toBe("{}");
    }, 20000);

    test("a hook replaced by a newer one for the same session exits instead of waiting again", async () => {
      // Claude starts a Stop hook after every turn, while the previous turn's hook may still be waiting.
      const env = { ...process.env, SWARMAIL_WAKE_URL: base, SWARMAIL_WAKE_CHUNK: "1" };
      const start = () =>
        Bun.spawn([...hook, "cursor", "20"], {
          stdin: new Blob(['{"conversation_id":"c-1"}']),
          env,
        });
      const older = start();
      await Bun.sleep(300);
      const newer = start();
      try {
        const started = Date.now();
        expect(await older.exited).toBe(0);
        expect(Date.now() - started).toBeLessThan(3000);
        await send("PinkFox");
        expect(await newer.exited).toBe(0);
        expect(JSON.parse(await new Response(newer.stdout).text()).followup_message).toContain(
          "Swarmail: run swarmail inbox --session.",
        );
      } finally {
        older.kill();
        newer.kill();
      }
    }, 20000);

    test("a replaced Claude hook leaves the PID file to the hook that replaced it", async () => {
      // The PostToolUse re-arm and the Stop hook can both start a wait for one session.
      mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
      writeFileSync(join(dir, "state/swarmail-register/s-1.json"), "{}");
      const env = {
        ...process.env,
        SWARMAIL_WAKE_URL: base,
        CLAUDE_PID: String(process.pid),
        XDG_STATE_HOME: join(dir, "state"),
      };
      const start = () =>
        Bun.spawn([...hook, "claude", "20"], {
          stdin: new Blob([
            JSON.stringify({
              session_id: "s-1",
              transcript_path: "/h/.claude/projects/w/s-1.jsonl",
            }),
          ]),
          env,
          stderr: "pipe",
        });
      const pidFile = join(dir, "state/swarmail-wake/s-1");
      const older = start();
      expect(await waiting(older.pid)).toBe(older.pid);
      const newer = start();
      try {
        expect(await older.exited).toBe(0);
        expect(parseInt(readFileSync(pidFile, "utf8"))).toBe(newer.pid);
        await send("GreenCastle");
        expect(await newer.exited).toBe(2);
        expect(existsSync(pidFile)).toBe(false);
      } finally {
        older.kill();
        newer.kill();
      }
    }, 20000);

    test("the hook waits again when the server ends a wait before the hook's own time is up", async () => {
      // The server ends each /wait after at most a day, and Claude's hook waits about 23 days.
      const waits = [];
      const fake = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return new Response("ok");
          }
          if (url.pathname === "/wait/status") {
            return Response.json({ eligible: true });
          }
          waits.push(url.searchParams.get("timeout"));
          return waits.length === 1
            ? new Response(null, { status: 204 })
            : new Response("Swarmail: 1 new message for PinkFox in /w/project from BlueLake.", {
                headers: { "x-swarmail-event-id": "1" },
              });
        },
      });
      const waiting = Bun.spawn([...hook, "cursor", "15"], {
        stdin: new Blob(['{"conversation_id":"c-1"}']),
        env: {
          ...process.env,
          XDG_STATE_HOME: join(dir, "fake-state"),
          SWARMAIL_WAKE_URL: `http://127.0.0.1:${fake.port}`,
        },
      });
      try {
        expect(await waiting.exited).toBe(0);
        expect(JSON.parse(await new Response(waiting.stdout).text()).followup_message).toContain(
          "for PinkFox in /w/project",
        );
        expect(waits).toHaveLength(2);
      } finally {
        waiting.kill();
        fake.stop(true);
      }
    }, 20000);

    test("the hook reconnects after a server restart and still gets the hint", async () => {
      const first = createServer(join(dir, "mail.sqlite3"), 0, { wakePollMs: 20 });
      const port = first.server.port;
      const waiting = Bun.spawn([...hook, "cursor", "15"], {
        stdin: new Blob(['{"conversation_id":"c-1"}']),
        env: { ...process.env, SWARMAIL_WAKE_URL: `http://127.0.0.1:${port}` },
      });
      let second;
      try {
        await Bun.sleep(300);
        first.server.stop(true);
        first.db.close();
        second = createServer(join(dir, "mail.sqlite3"), port, { wakePollMs: 20 });
        await send("PinkFox");
        expect(await waiting.exited).toBe(0);
        expect(JSON.parse(await new Response(waiting.stdout).text()).followup_message).toContain(
          "Swarmail: run swarmail inbox --session.",
        );
      } finally {
        waiting.kill();
        second?.server.stop(true);
        second?.db.close();
      }
    }, 20000);
  });
}

// Last: it leaves GreenCastle mail unread, which the tests above count.
test("a wait by T3 thread id wakes the thread's agent", async () => {
  await send("GreenCastle"); // tag t3:th-1
  const res = await wait("th-1", 1);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Swarmail: run swarmail inbox --session.\n");
});

describe("read-only unread mailbox peek", () => {
  const session = "peek-native";
  const thread = "peek-thread";
  const projects = ['/w/peek"one', "/w/peek-two"];
  const peek = (id = session, extra = "") => fetch(`${base}/wait/peek?session=${id}${extra}`);

  test("scopes exact identities, prioritizes mailboxes and leaves offered mail, pings and receipts unchanged", async () => {
    for (const project_key of projects) {
      for (const [name, task_description] of [
        ["SilverLake", `[t3:${thread} codex:${session}]`],
        ["GoldOwl", "sender"],
        ["RedFox", "[codex:peek-unrelated]"],
      ]) {
        await call("register_agent", {
          project_key,
          name,
          task_description,
          program: "codex",
          model: "m",
        });
      }
      await call("send_message", {
        project_key,
        sender_name: "GoldOwl",
        to: ["SilverLake", "RedFox"],
        subject: "private subject",
        body_md: "private body",
        ack_required: true,
        importance: project_key === projects[1] ? "urgent" : "normal",
      });
    }
    await call("send_message", {
      project_key: projects[0],
      sender_name: "GoldOwl",
      to: ["SilverLake"],
      subject: "swarmail ping",
      body_md: "ping",
    });
    await call("register_agent", {
      project_key: projects[0],
      name: "SilverOwl",
      program: "codex",
      model: "m",
      task_description: `[codex:${session}]`,
    });
    await call("send_message", {
      project_key: projects[0],
      sender_name: "GoldOwl",
      to: ["SilverOwl"],
      subject: "swarmail ping",
      body_md: "ping-only mailbox",
    });
    const snapshot = () => ({
      receipts: db.query("SELECT * FROM message_recipients ORDER BY message_id, agent_id").all(),
      messages: db.query("SELECT * FROM messages ORDER BY id").all(),
      cursors: db.query("SELECT * FROM wake_cursors ORDER BY session").all(),
    });
    const before = snapshot();
    const expected = {
      mailboxes: [
        { recipient: "SilverLake", project: projects[1] },
        { recipient: "SilverLake", project: projects[0] },
      ],
    };
    const response = await peek(session, "&after=999999999&retry=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(await (await peek(thread)).json()).toEqual(expected);
    expect(snapshot()).toEqual(before);
    const offered = await wait(session);
    expect(offered.status).toBe(200);
    const accepted = await fetch(
      `${base}/wait?session=${session}&after=${offered.headers.get("x-swarmail-event-id")}&retry=1&timeout=1`,
    );
    expect(accepted.status).toBe(204);
    expect(
      db.query("SELECT announced FROM wake_cursors WHERE session = ?").get(session).announced,
    ).toBeGreaterThan(0);
    const afterOffer = snapshot();
    expect(await (await peek()).json()).toEqual(expected);
    expect(snapshot()).toEqual(afterOffer);
    for (const project_key of projects) {
      await call("fetch_inbox", { project_key, agent_name: "SilverLake", unread_only: true });
    }
    expect(await (await peek()).json()).toEqual({ mailboxes: [] });
    await call("send_message", {
      project_key: projects[0],
      sender_name: "GoldOwl",
      to: ["SilverLake"],
      subject: "new",
      body_md: "new",
      notification_policy: "wake",
    });
    await call("retire_agent", { project_key: projects[0], agent_name: "SilverLake" });
    expect(await (await peek()).json()).toEqual({ mailboxes: [] });
    expect(await (await peek("peek-unknown")).json()).toEqual({ mailboxes: [] });
    expect((await peek("bad/session")).status).toBe(400);
  });

  test("does not replace an outstanding long poll", async () => {
    const id = "peek-waiter";
    await call("register_agent", {
      project_key: P,
      name: "WhiteOwl",
      program: "codex",
      model: "m",
      task_description: `[codex:${id}]`,
    });
    const waiters = createWaiters(db);
    // Registration happens synchronously before wait returns its pending promise.
    const polling = waiters.wait(id, 5000);
    expect(waiters.peek(id)).toEqual({ mailboxes: [] });
    await send("WhiteOwl");
    waiters.notify();
    expect((await polling).hint).toBe("Swarmail: run swarmail inbox --session.");
    expect(waiters.peek(id).mailboxes).toEqual([{ recipient: "WhiteOwl", project: P }]);
  });

  test("rejects an oversized snapshot instead of returning a partial mailbox set", async () => {
    const project = db
      .query(
        "INSERT INTO projects(slug, human_key, created_at) VALUES ('peek-limit', ?, 1) RETURNING id",
      )
      .get("/w/peek-limit");
    const insertAgent = db.query(
      "INSERT INTO agents(project_id, name, program, model, inception_ts, last_active_ts, session_id) VALUES (?, ?, 'codex', 'm', 1, 1, 'peek-limit') RETURNING id",
    );
    const insertMail = db.query(
      "INSERT INTO messages(project_id, sender_id, subject, body_md, created_ts, recipients_json) VALUES (?, ?, 's', 'b', 1, '{}') RETURNING id",
    );
    const insertReceipt = db.query(
      "INSERT INTO message_recipients(message_id, agent_id, created_ts) VALUES (?, ?, 1)",
    );
    db.transaction(() => {
      for (let i = 0; i < 1001; i++) {
        const agent = insertAgent.get(project.id, `Limit${i}`);
        const message = insertMail.get(project.id, agent.id);
        insertReceipt.run(message.id, agent.id);
      }
    })();
    const response = await peek("peek-limit");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unread mailbox snapshot unavailable");
    expect(db.query("SELECT * FROM wake_cursors WHERE session = 'peek-limit'").get()).toBeNull();
  });
});
