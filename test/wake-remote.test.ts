import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpWait } from "../src/canary.ts";
import { createServer } from "../src/server.ts";
import { ensureWakeEligible } from "../src/wake-lifecycle.ts";
import { peekUnreadMailboxes, waitForOffer } from "../src/wake-state.ts";
import { serverUrl } from "../src/wake-target.ts";

// A second loopback address stands in for a tailnet one; the token file stands in for the machine's own.
delete process.env.SWARMAIL_WAKE_MOD;
const REMOTE = "127.0.0.2";
const TOKEN = "w".repeat(40);
const P = "/w/remote-wake";
let dir: string;
let server: ReturnType<typeof createServer>["server"];
let remote: NonNullable<ReturnType<typeof createServer>["remote"]>;
let db: ReturnType<typeof createServer>["db"];
let base: string;
let hub: string;
let previous: Record<string, string | undefined>;

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
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
  const answer = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(answer.result.content[0]!.text);
};

beforeAll(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-wake-remote-")));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  previous = {
    SWARMAIL_TOKEN_FILE: process.env.SWARMAIL_TOKEN_FILE,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.SWARMAIL_TOKEN_FILE = tokenFile;
  process.env.XDG_STATE_HOME = join(dir, "state");
  const created = createServer(join(dir, "mail.sqlite3"), 0, {
    remote: { hostname: REMOTE, token: TOKEN },
  });
  ({ server, db } = created);
  remote = created.remote!;
  base = `http://127.0.0.1:${server.port}`;
  hub = `http://${REMOTE}:${server.port}`;
  for (const [name, task] of [
    ["GreenCastle", "[claude:s-1 cwd:~/w] review"],
    ["BlueLake", "sender"],
  ]) {
    await call("register_agent", {
      project_key: P,
      program: "claude-code",
      model: "m",
      name,
      task_description: task,
    });
  }
});
afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await server.stop(true);
  await remote.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const send = () =>
  call("send_message", {
    project_key: P,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "s",
    body_md: "b",
    notification_policy: "wake",
  });

test("the wake client calls send the token to a server on another machine", async () => {
  const signal = new AbortController().signal;
  await ensureWakeEligible(hub, "s-1", signal);
  expect(await peekUnreadMailboxes({ swarmailUrl: hub, target: { id: "s-1" } }, signal)).toEqual(
    [],
  );
  await send();
  const offer = await waitForOffer({ swarmailUrl: hub, target: { id: "s-1" } }, 0, signal);
  expect(offer?.hint).toContain("Swarmail: run swarmail inbox --session.");
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  await send();
  expect(await httpWait(hub)("s-1", 0)).toContain("Swarmail:");
  const reconcile = await fetch(`${hub}/lifecycle/reconcile`, { method: "POST" });
  expect(reconcile.status).toBe(401);
});

test("without the token those calls are refused instead of reading the hub's mail", async () => {
  const token = process.env.SWARMAIL_TOKEN_FILE;
  delete process.env.SWARMAIL_TOKEN_FILE;
  try {
    const peek = peekUnreadMailboxes(
      { swarmailUrl: hub, target: { id: "s-1" } },
      new AbortController().signal,
    );
    expect(
      await peek.then(
        () => null,
        (error: Error) => error,
      ),
    ).toBeInstanceOf(Error);
    const eligible = ensureWakeEligible(hub, "s-1").then(
      () => null,
      (error: Error) => error,
    );
    expect((await eligible)?.message).toContain("holding mail");
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
});

test("the Claude hook waits on a server on another machine with the token", async () => {
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
  writeFileSync(
    join(dir, "state/swarmail-register/s-1.json"),
    JSON.stringify({ name: "GreenCastle", projects: [P] }),
  );
  const hook = [
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "hook",
    "wake",
    "claude",
    "5",
  ];
  const run = (env: Record<string, string | undefined>) =>
    Bun.spawn(hook, {
      stdin: new Blob([
        JSON.stringify({
          session_id: "s-1",
          transcript_path: "/h/.claude/projects/w/s-1.jsonl",
          hook_event_name: "Stop",
        }),
      ]),
      env: { ...process.env, SWARMAIL_WAKE_URL: hub, CLAUDE_PID: String(process.pid), ...env },
      stderr: "pipe",
    });
  await send();
  const without = run({ SWARMAIL_TOKEN_FILE: undefined });
  expect(await without.exited).toBe(0);
  expect(await new Response(without.stderr).text()).not.toContain("swarmail inbox");
  const withToken = run({});
  expect(await withToken.exited).toBe(2);
  expect(await new Response(withToken.stderr).text()).toContain(
    "Swarmail: run swarmail inbox --session.",
  );
});

test("an unreadable token file is reported at once, not retried as a dropped connection", async () => {
  const bad = join(dir, "short-token");
  writeFileSync(bad, "short\n");
  const hook = [
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "hook",
    "wake",
    "claude",
    "5",
  ];
  const run = Bun.spawn(hook, {
    stdin: new Blob([
      JSON.stringify({
        session_id: "s-1",
        transcript_path: "/h/.claude/projects/w/s-1.jsonl",
        hook_event_name: "Stop",
      }),
    ]),
    env: {
      ...process.env,
      SWARMAIL_WAKE_URL: hub,
      SWARMAIL_TOKEN_FILE: bad,
      CLAUDE_PID: String(process.pid),
    },
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
  expect(await new Response(run.stderr).text()).toContain("SWARMAIL_TOKEN_FILE");
  const token = process.env.SWARMAIL_TOKEN_FILE;
  process.env.SWARMAIL_TOKEN_FILE = bad;
  try {
    const held = await ensureWakeEligible(hub, "s-1").then(
      () => null,
      (error: { message: string; retryable?: boolean }) => error,
    );
    expect(held?.message).toContain("SWARMAIL_TOKEN_FILE");
    expect(held?.retryable).toBe(false);
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
});

test("a bridge accepts a server on another machine only when it has the token to send", () => {
  expect(serverUrl(hub)).toBe(hub);
  expect(serverUrl("http://localhost:18765")).toBe("http://127.0.0.1:18765");
  for (const bad of [`http://u:p@${REMOTE}:1`, `${hub}/mcp/`, `${hub}?x=1`, "ftp://hub.example"]) {
    expect(() => serverUrl(bad)).toThrow();
  }
  const token = process.env.SWARMAIL_TOKEN_FILE;
  delete process.env.SWARMAIL_TOKEN_FILE;
  try {
    expect(() => serverUrl(hub)).toThrow("SWARMAIL_TOKEN_FILE");
    expect(serverUrl("http://127.0.0.1:18765")).toBe("http://127.0.0.1:18765");
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
});
