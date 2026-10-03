import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";

const P = "/w/project";
// $0 of the shell that stands in for the host.
const script = "wake-host";
const HOOKS = {
  "swarmail hook wake": [process.execPath, join(import.meta.dir, "../src/cli.ts"), "hook", "wake"],
};
let dir, server, db, base;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "swarmail-wake-"));
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
afterAll(() => {
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
  });
const wait = (session, timeout = 5) => fetch(`${base}/wait?session=${session}&timeout=${timeout}`);

test("wakes a session for unread mail to its tagged agent only, naming recipient and sender but not the subject", async () => {
  await send("GreenCastle"); // unread before the session's first wait: announced at once
  let res = await wait("s-1");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(
    `Swarmail: 1 new message for GreenCastle in ${P} from BlueLake. Call fetch_inbox to read them.\n`,
  );
  const pending = wait("s-1");
  await Bun.sleep(100);
  await send("TanOwl"); // tag claude:s-10, not s-1
  await Bun.sleep(100);
  await send("GreenCastle");
  res = await pending;
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(
    `Swarmail: 1 new message for GreenCastle in ${P} from BlueLake. Call fetch_inbox to read them.\n`,
  );
  // Already announced: the next wait holds until newer mail or its timeout.
  expect((await wait("s-1", 1)).status).toBe(204);
});

test("a retried wait gets a lost hint again, and a restarted server does not re-announce", async () => {
  await send("GreenCastle");
  expect((await wait("s-1")).status).toBe(200);
  const retried = await fetch(`${base}/wait?session=s-1&timeout=5&retry=1`);
  expect(await retried.text()).toContain("1 new message for GreenCastle");
  expect((await wait("s-1", 1)).status).toBe(204);

  // A second server on the same database stands in for a restart.
  const other = createServer(join(dir, "mail.sqlite3"), 0, { wakePollMs: 20 });
  try {
    const waitOther = (timeout) =>
      fetch(`http://127.0.0.1:${other.server.port}/wait?session=s-1&timeout=${timeout}`);
    expect((await waitOther(1)).status).toBe(204);
    const pending = waitOther(5);
    await Bun.sleep(100);
    await send("GreenCastle");
    expect(await (await pending).text()).toContain("1 new message for GreenCastle");
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

test("names recipients with urgent or high mail first", async () => {
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
  expect(await (await wait("s-1")).text()).toBe(
    `Swarmail: 1 new message (1 urgent or high) for GreenCastle in ${Q} from BlueLake;` +
      ` 1 new message for GreenCastle in ${P} from BlueLake. Call fetch_inbox to read them.\n`,
  );
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

for (const [name, hook] of Object.entries(HOOKS)) {
  describe(name, () => {
    const shell = hook.map((arg) => `"${arg}"`).join(" ");

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
      await Bun.sleep(300);
      // The waiting Claude hook advertises its PID for the PostToolUse re-arm, and clears it on exit.
      const pidFile = join(dir, "state/swarmail-wake/s-1");
      expect(Number(readFileSync(pidFile, "utf8"))).toBe(claude.pid);
      await send("GreenCastle");
      await send("PinkFox");
      expect(await claude.exited).toBe(2);
      expect(existsSync(pidFile)).toBe(false);
      expect(await new Response(claude.stderr).text()).toContain(
        "for GreenCastle in /w/project from BlueLake",
      );
      await cursor.exited;
      expect(JSON.parse(await new Response(cursor.stdout).text()).followup_message).toContain(
        "for PinkFox in /w/project",
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
      const unrelated = Bun.spawn(["sleep", "30"]);
      const env = { ...process.env, SWARMAIL_WAKE_URL: base, XDG_STATE_HOME: join(dir, "state") };
      const input = (session, transcript = `/h/.claude/projects/w/${session}.jsonl`) =>
        JSON.stringify({ session_id: session, transcript_path: transcript }).replaceAll("'", "");
      // The parent shell stands in for Claude: CLAUDE_PID names it, and its command line ends in `claude <flag>`.
      const underClaude = (flag, session, transcript) => [
        "sh",
        "-c",
        `CLAUDE_PID=$$ ${shell} claude 5 <<'EOF'\n${input(session, transcript)}\nEOF`,
        script,
        flag,
      ];
      writeFileSync(
        join(dir, "state/swarmail-register/s-ended.json"),
        JSON.stringify({ name: null, projects: [], ended: "2026-09-30T23:00:00Z" }),
      );
      const cases = [
        { cmd: underClaude("--resume", "s-ended") }, // End record before any registration.
        { cmd: underClaude("-p", "s-1") }, // `claude -p`
        { cmd: underClaude("--resume", "s-unregistered") }, // no register-hook state
        { cmd: underClaude("--resume", "s-1", "/h/.grok/sessions/s-1.jsonl") }, // Grok or Devin started by Claude
        { cmd: [...hook, "claude", "5"], CLAUDE_PID: "", session: "s-1" }, // Devin or Cursor running ~/.claude/settings.json hooks
        { cmd: [...hook, "claude", "5"], CLAUDE_PID: String(unrelated.pid), session: "s-1" }, // ... started from a Claude session
      ];
      try {
        for (const { cmd, CLAUDE_PID, session } of cases) {
          const started = Date.now();
          const run = Bun.spawn(cmd, {
            stdin: session ? new Blob([input(session)]) : "ignore",
            env: CLAUDE_PID === undefined ? env : { ...env, CLAUDE_PID },
          });
          expect(await run.exited).toBe(0);
          expect(Date.now() - started).toBeLessThan(2000);
        }
        // Control: the same shape under a registered, interactive Claude waits for mail.
        const waits = Bun.spawn(underClaude("--resume", "s-1"), { env, stderr: "pipe" });
        await Bun.sleep(300);
        await send("GreenCastle");
        expect(await waits.exited).toBe(2);
      } finally {
        unrelated.kill();
      }
    }, 20000);

    test("the hook stops waiting when its host exits", async () => {
      // Cursor runs the hook under a shell of its own and, on quit, leaves it running.
      const out = join(dir, "orphan.out");
      const input = JSON.stringify({ conversation_id: "c-1" }).replaceAll('"', '\\"');
      const host = Bun.spawn(
        [
          "sh",
          "-c",
          `sh -c 'echo "${input}" | ${shell} cursor 60 > "$1"' "$0" "$1" & wait`,
          script,
          out,
        ],
        {
          env: { ...process.env, SWARMAIL_WAKE_URL: base, SWARMAIL_WAKE_CHUNK: "1" },
        },
      ); // checks the host every second
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
          "for PinkFox",
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
      await Bun.sleep(300);
      const newer = start();
      try {
        expect(await older.exited).toBe(0);
        expect(Number(readFileSync(pidFile, "utf8"))).toBe(newer.pid);
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
          waits.push(url.searchParams.get("timeout"));
          return waits.length === 1
            ? new Response(null, { status: 204 })
            : new Response("Swarmail: 1 new message for PinkFox in /w/project from BlueLake.");
        },
      });
      const waiting = Bun.spawn([...hook, "cursor", "15"], {
        stdin: new Blob(['{"conversation_id":"c-1"}']),
        env: { ...process.env, SWARMAIL_WAKE_URL: `http://127.0.0.1:${fake.port}` },
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
          "for PinkFox in /w/project",
        );
      } finally {
        waiting.kill();
        second?.server.stop(true);
        second?.db.close();
      }
    }, 20000);
  });
}
