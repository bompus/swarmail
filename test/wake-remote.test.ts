import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpWait } from "../src/canary.ts";
import { createServer } from "../src/server.ts";
import { lifecycleReconciliation } from "../src/wake-auto-t3.ts";
import { contextHook } from "../src/wake-hook.ts";
import { ensureWakeEligible } from "../src/wake-lifecycle.ts";
import { peekUnreadMailboxes, waitForOffer } from "../src/wake-state.ts";
import { TargetAuthenticationError, serverHeaders, serverUrl } from "../src/wake-target.ts";

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
  // The canary authenticates its wait with the environment it was given, as it does its other calls.
  const token = process.env.SWARMAIL_TOKEN_FILE;
  const given = { ...process.env, SWARMAIL_TOKEN_FILE: token };
  delete process.env.SWARMAIL_TOKEN_FILE;
  try {
    await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
    await send();
    expect(await httpWait(hub, 5000, given)("s-1", 0)).toContain("Swarmail:");
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
  const reconcile = await fetch(`${hub}/lifecycle/reconcile`, { method: "POST" });
  expect(reconcile.status).toBe(401);
});

const listed = async () =>
  (await call("list_agents", { project_key: P })).find((row: any) => row.name === "GreenCastle");

test("the roster says whether a session is waiting for mail and whether its host reported it ended", async () => {
  expect(await listed()).toMatchObject({ waiting_for_mail: false, session_ended_at: null });
  const open = new AbortController();
  const waiting = fetch(`${hub}/wait?session=s-1&timeout=5`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: open.signal,
  }).catch(() => null);
  await Bun.sleep(100);
  expect(await listed()).toMatchObject({ waiting_for_mail: true });
  open.abort();
  await waiting;
  await Bun.sleep(50);
  expect(await listed()).toMatchObject({ waiting_for_mail: false });
  await call("release_file_reservations", {
    project_key: P,
    agent_name: "GreenCastle",
    session_ended: true,
  });
  expect((await listed()).session_ended_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  // Any later call as the agent shows the session is back.
  await call("release_file_reservations", { project_key: P, agent_name: "GreenCastle" });
  expect((await listed()).session_ended_at).toBeNull();
});

test("a wait opened before the end report does not count, a later one does, and a stale report is ignored", async () => {
  const waitOpen = () => {
    const open = new AbortController();
    const request = fetch(`${hub}/wait?session=s-1&timeout=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: open.signal,
    }).catch(() => null);
    return async () => {
      open.abort();
      await request;
      await Bun.sleep(50);
    };
  };
  const end = (extra: Record<string, unknown> = {}) =>
    call("release_file_reservations", {
      project_key: P,
      agent_name: "GreenCastle",
      session_ended: true,
      ...extra,
    });
  const closeFirst = waitOpen();
  await Bun.sleep(100);
  await end();
  expect(await listed()).toMatchObject({ waiting_for_mail: false });
  expect((await listed()).session_ended_at).not.toBeNull();
  const closeSecond = waitOpen();
  await Bun.sleep(100);
  expect(await listed()).toMatchObject({ waiting_for_mail: true });
  // Waiting again supersedes the end report for good, not only while the wait stays open.
  expect((await listed()).session_ended_at).toBeNull();
  await closeSecond();
  await closeFirst();
  expect((await listed()).session_ended_at).toBeNull();
  // A wait left open across the end report stays out of the roster even after a later call clears the report.
  const closeThird = waitOpen();
  await Bun.sleep(100);
  await end();
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  expect(await listed()).toMatchObject({ waiting_for_mail: false, session_ended_at: null });
  await closeThird();
  // Reviving the name for someone else's mail is not the session acting, so its end report stays.
  await end();
  await call("unretire_agent", { project_key: P, agent_name: "GreenCastle" });
  expect((await listed()).session_ended_at).not.toBeNull();
  await end();
  // The agent acting again, here by reading its own inbox with nothing in it, clears the report.
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  expect((await listed()).session_ended_at).toBeNull();
  // An end reported by a session that no longer holds the name is not this session's end, and leaves the agent's
  // own end report and activity as they were.
  await end({ session_id: "s-1" });
  const before = await listed();
  expect(before.session_ended_at).not.toBeNull();
  await end({ session_id: "an-earlier-session" });
  expect(await listed()).toEqual(before);
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
});

test("reading an inbox clears the end report of the agent it read for, by thread when one is given", async () => {
  for (const [name, thread] of [
    ["AmberCliff", "thread-a"],
    ["TealDune", "thread-b"],
  ]) {
    await call("register_agent", {
      project_key: P,
      program: "claude-code",
      model: "m",
      name,
      task_description: `[t3:${thread} claude:native-9] work`,
    });
    await call("release_file_reservations", {
      project_key: P,
      agent_name: name,
      session_ended: true,
    });
  }
  const ended = async () =>
    Object.fromEntries(
      (await call("list_agents", { project_key: P }))
        .filter((row: any) => ["AmberCliff", "TealDune"].includes(row.name))
        .map((row: any) => [row.name, row.session_ended_at !== null]),
    );
  expect(await ended()).toEqual({ AmberCliff: true, TealDune: true });
  await call("fetch_session_inbox", {
    host: "claude",
    session_id: "native-9",
    t3_thread: "thread-a",
  });
  expect(await ended()).toEqual({ AmberCliff: false, TealDune: true });
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
    expect((await eligible)?.message).toContain("SWARMAIL_TOKEN_FILE");
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

test("an unreadable token file is an authentication failure shared by every thread", () => {
  const bad = join(dir, "short-token-2");
  writeFileSync(bad, "short\n");
  const token = process.env.SWARMAIL_TOKEN_FILE;
  process.env.SWARMAIL_TOKEN_FILE = bad;
  try {
    expect(() => serverHeaders(hub)).toThrow(TargetAuthenticationError);
    expect(serverHeaders("http://127.0.0.1:18765")).toEqual({});
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
});

test("the context hook authenticates with the environment it was given", async () => {
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  await send();
  const tokenFile = process.env.SWARMAIL_TOKEN_FILE!;
  const given = {
    ...process.env,
    SWARMAIL_TOKEN_FILE: tokenFile,
    SWARMAIL_WAKE_URL: hub,
    XDG_STATE_HOME: join(dir, "state"),
  };
  delete process.env.SWARMAIL_TOKEN_FILE;
  const log = console.log;
  let printed = "";
  console.log = (line: string) => {
    printed += line;
  };
  try {
    expect(await contextHook("devin", false, JSON.stringify({ session_id: "s-1" }), given)).toBe(0);
  } finally {
    console.log = log;
    process.env.SWARMAIL_TOKEN_FILE = tokenFile;
  }
  expect(printed).toContain("Swarmail:");
});

test("a token file that goes bad while the hook waits is reported, not retried", async () => {
  await call("fetch_session_inbox", { host: "claude", session_id: "s-1", limit: 1000 });
  mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
  writeFileSync(
    join(dir, "state/swarmail-register/s-1.json"),
    JSON.stringify({ name: "GreenCastle", projects: [P] }),
  );
  const copy = join(dir, "token-copy");
  writeFileSync(copy, `${TOKEN}\n`);
  const run = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "hook", "wake", "claude", "20"],
    {
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
        SWARMAIL_TOKEN_FILE: copy,
        CLAUDE_PID: String(process.pid),
      },
      stderr: "pipe",
    },
  );
  await Bun.sleep(1000);
  rmSync(copy);
  await send();
  expect(await run.exited).toBe(0);
  expect(await new Response(run.stderr).text()).toContain("SWARMAIL_TOKEN_FILE");
});

test("the supervisor's lifecycle reconciliation stops on an unreadable token file", async () => {
  const bad = join(dir, "short-token-3");
  writeFileSync(bad, "short\n");
  const token = process.env.SWARMAIL_TOKEN_FILE;
  process.env.SWARMAIL_TOKEN_FILE = bad;
  try {
    const reconcile = lifecycleReconciliation(hub, new AbortController().signal);
    const stopped = await reconcile().then(
      () => null,
      (error: Error) => error,
    );
    expect(stopped).toBeInstanceOf(TargetAuthenticationError);
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
  }
});

test("the hook reads its token file again for each poll, so a rotated token is used", async () => {
  mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
  writeFileSync(
    join(dir, "state/swarmail-register/s-1.json"),
    JSON.stringify({ name: "GreenCastle", projects: [P] }),
  );
  const file = join(dir, "rotating-token");
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  writeFileSync(file, `${first}\n`);
  const seen: (string | null)[] = [];
  const fake = Bun.serve({
    hostname: REMOTE,
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/wait") {
        seen.push(req.headers.get("authorization"));
        if (seen.length === 1) {
          writeFileSync(file, `${second}\n`);
          return new Response(null, { status: 204 });
        }
        return new Response("Swarmail: rotated");
      }
      return Response.json({ eligible: true });
    },
  });
  try {
    const run = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "hook", "wake", "claude", "20"],
      {
        stdin: new Blob([
          JSON.stringify({
            session_id: "s-1",
            transcript_path: "/h/.claude/projects/w/s-1.jsonl",
            hook_event_name: "Stop",
          }),
        ]),
        env: {
          ...process.env,
          SWARMAIL_WAKE_URL: `http://${REMOTE}:${fake.port}`,
          SWARMAIL_TOKEN_FILE: file,
          CLAUDE_PID: String(process.pid),
        },
        stderr: "pipe",
      },
    );
    expect(await run.exited).toBe(2);
    expect(seen).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
  } finally {
    await fake.stop(true);
  }
});

test("a server that rejects the token is an authentication failure, not a hold to retry", async () => {
  const rejecting = Bun.serve({
    hostname: REMOTE,
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/healthz"
        ? new Response("ok")
        : new Response("no", { status: 401 }),
  });
  const url = `http://${REMOTE}:${rejecting.port}`;
  const failure = (run: () => Promise<unknown>) =>
    run().then(
      () => null,
      (error: Error) => error,
    );
  try {
    const config = { swarmailUrl: url, target: { id: "s-1" } };
    const signal = new AbortController().signal;
    expect(await failure(() => lifecycleReconciliation(url, signal)())).toBeInstanceOf(
      TargetAuthenticationError,
    );
    expect(await failure(() => ensureWakeEligible(url, "s-1"))).toBeInstanceOf(
      TargetAuthenticationError,
    );
    expect(await failure(() => waitForOffer(config, 0, signal))).toBeInstanceOf(
      TargetAuthenticationError,
    );
    expect(await failure(() => peekUnreadMailboxes(config, signal))).toBeInstanceOf(
      TargetAuthenticationError,
    );
    const hook = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "hook", "wake", "claude", "5"],
      {
        stdin: new Blob([
          JSON.stringify({
            session_id: "s-1",
            transcript_path: "/h/.claude/projects/w/s-1.jsonl",
            hook_event_name: "Stop",
          }),
        ]),
        env: { ...process.env, SWARMAIL_WAKE_URL: url, CLAUDE_PID: String(process.pid) },
        stderr: "pipe",
      },
    );
    expect(await hook.exited).toBe(0);
    expect(await new Response(hook.stderr).text()).toContain("SWARMAIL_TOKEN_FILE");
  } finally {
    await rejecting.stop(true);
  }
});

test("a rejection of a token that has since been replaced is retried, not fatal", async () => {
  const file = join(dir, "replaced-token");
  writeFileSync(file, `${"c".repeat(40)}\n`);
  const rotating = Bun.serve({
    hostname: REMOTE,
    port: 0,
    fetch() {
      writeFileSync(file, `${"d".repeat(40)}\n`);
      return new Response("no", { status: 401 });
    },
  });
  const token = process.env.SWARMAIL_TOKEN_FILE;
  process.env.SWARMAIL_TOKEN_FILE = file;
  try {
    const held = await ensureWakeEligible(`http://${REMOTE}:${rotating.port}`, "s-1").then(
      () => null,
      (error: { retryable?: boolean }) => error,
    );
    expect(held).not.toBeInstanceOf(TargetAuthenticationError);
    expect(held?.retryable).toBe(true);
  } finally {
    process.env.SWARMAIL_TOKEN_FILE = token;
    await rotating.stop(true);
  }
});
