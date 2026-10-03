import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primaryCheckout } from "../src/checkout.ts";
import { hostProcess } from "../src/proc.ts";
import {
  endSession,
  ensureRegistered,
  hookSession,
  keptTask,
  rowForSession,
  t3ThreadId,
  targetDir,
} from "../src/register-hook.ts";
import { withLock } from "../src/registry.ts";
import { sessionTag } from "../src/tag.ts";
import { createServer } from "../src/server.ts";

/** A stand-in Swarmail MCP endpoint: `handler(tool, args)` returns the tool result and every call is recorded. */
function fakeMail(handler) {
  const calls = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const msg = await req.json();
      calls.push(msg.params);
      const value = await handler(msg.params.name, msg.params.arguments);
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp/`, calls, stop: () => server.stop(true) };
}

test("resolves a worktree to its primary checkout and skips bare or missing repositories", () => {
  const run = (common) => () => common;
  expect(primaryCheckout("/w/repo-task", run("/home/u/repo/.git"))).toBe("/home/u/repo");
  expect(primaryCheckout("/home/u/repo", run("/home/u/repo/.git"))).toBe("/home/u/repo");
  expect(primaryCheckout("/srv/bare", run("/srv/bare.git"))).toBeNull();
  expect(
    primaryCheckout("/tmp", () => {
      throw new Error("not a repo");
    }),
  ).toBeNull();
});

test("resolves the edited file's folder, falling back to the session cwd", () => {
  expect(targetDir({ cwd: "/home/u", tool_input: { file_path: "/tmp/new-dir/x.ts" } })).toBe(
    "/tmp",
  );
  expect(targetDir({ cwd: "/home/u", tool_input: {} })).toBe("/home/u");
  expect(targetDir({ tool_input: { file_path: "relative.ts" } })).toBeNull();
  const patch = "*** Begin Patch\n*** Update File: sub/x.ts\n@@\n*** End Patch";
  expect(targetDir({ cwd: "/tmp", tool_input: { command: patch } })).toBe("/tmp");
  expect(targetDir({ cwd: "/home/u", tool_input: { command: "*** Add File: /tmp/a/b.ts" } })).toBe(
    "/tmp",
  );
  expect(targetDir({ cwd: "/home/u", toolCall: { args: { TargetFile: "/tmp/new/c.ts" } } })).toBe(
    "/tmp",
  );
});

test("registers once per repository and tag, keeping one name across repositories", () => {
  const calls = [];
  const register = (project, name) => {
    calls.push([project, name]);
    return name ?? "BlueLake";
  };
  let state = { name: null, projects: [] };
  state = ensureRegistered(state, "/home/u/a", "[t1]", register);
  state = ensureRegistered(state, "/home/u/a", "[t1]", register);
  state = ensureRegistered(state, "/home/u/b", "[t1]", register);
  expect(calls).toEqual([
    ["/home/u/a", null],
    ["/home/u/b", "BlueLake"],
  ]);
  expect(state).toEqual({
    name: "BlueLake",
    projects: ["/home/u/a", "/home/u/b"],
    tags: { "/home/u/a": "[t1]", "/home/u/b": "[t1]" },
  });
  const failed = { name: null, projects: [] };
  expect(ensureRegistered(failed, "/home/u/c", "[t1]", () => null)).toBe(failed);
});

test("re-registers under the same name when the tag changed or state predates tags", () => {
  const calls = [];
  const register = (project, name) => {
    calls.push([project, name]);
    return name;
  };
  const legacy = { name: "TanOwl", projects: ["/home/u/a"] };
  const next = ensureRegistered(legacy, "/home/u/a", "[t3:x claude:s]", register);
  expect(calls).toEqual([["/home/u/a", "TanOwl"]]);
  expect(next).toEqual({
    name: "TanOwl",
    projects: ["/home/u/a"],
    tags: { "/home/u/a": "[t3:x claude:s]" },
  });
});

test("keeps the agent's task text and drops the hook's placeholders", () => {
  expect(keptTask("[t3:x claude:s cwd:~/w] TLA+ pilot")).toBe("TLA+ pilot");
  expect(keptTask("Claude Code session c583830b (registered on first edit)")).toBe(
    "registered on first edit",
  );
  expect(keptTask("[claude:s cwd:~/w] registered on first edit")).toBe("registered on first edit");
  expect(keptTask("Room C90 validation")).toBe("Room C90 validation");
  expect(keptTask(undefined)).toBe("registered on first edit");
});

test("finds a hand-registered row by the session id in its tag", () => {
  const rows = [
    {
      name: "WildDeer",
      task_description: "[t3:c86a claude:a5ff-46 cwd:~/w] registered on first edit",
    },
    { name: "DarkDune", task_description: "[claude:a5ff cwd:~/w] TLA+ pilot" },
  ];
  expect(rowForSession(rows, "a5ff")?.name).toBe("DarkDune");
  expect(rowForSession(rows, "a5ff-46")?.name).toBe("WildDeer");
  expect(rowForSession(rows, "zzzz")).toBeNull();
});

test("tags the registration with ADE and session ids and a home-relative cwd", () => {
  expect(
    sessionTag(
      { t3: "dc34", host: "claude", sessionId: "b8ec" },
      "/home/u/src/repo-task",
      "/home/u",
    ),
  ).toBe("[t3:dc34 claude:b8ec cwd:~/src/repo-task]");
  expect(sessionTag({ host: "codex", sessionId: "abc" }, "/home/uv/x", "/home/u")).toBe(
    "[codex:abc cwd:/home/uv/x]",
  );
  expect(sessionTag({ host: "opencode" }, undefined, "/home/u")).toBe("[opencode]");
});

test("tells Claude hook input from Cursor, Devin and Grok input", () => {
  const transcript = "/home/u/.claude/projects/-w/s1.jsonl";
  expect(
    hookSession({ session_id: "s1", cwd: "/w", transcript_path: transcript }, {}),
  ).toMatchObject({
    host: "claude",
    program: "claude-code",
    sessionId: "s1",
    cwd: "/w",
  });
  expect(hookSession({ session_id: "s1", cwd: "/w" }, { CLAUDECODE: "1" })).toMatchObject({
    host: "claude",
  });
  expect(hookSession({ session_id: "s1", cwd: "/w" }, {})).toMatchObject({
    host: "unknown",
    program: "unknown",
    sessionId: "s1",
  });
  expect(
    hookSession({ conversation_id: "c1", session_id: "x", workspace_roots: ["/w"] }, {}),
  ).toMatchObject({
    host: "cursor",
    sessionId: "c1",
    cwd: "/w",
  });
  expect(hookSession({ session_id: "d1" }, { DEVIN_PROJECT_DIR: "/w" })).toMatchObject({
    host: "devin",
    sessionId: "d1",
    cwd: "/w",
  });
  expect(hookSession({ sessionId: "g1", cwd: "/w" }, {})).toMatchObject({
    host: "grok",
    sessionId: "g1",
  });
  expect(
    hookSession({ session_id: "x1", turn_id: "t", cwd: "/w", model: "gpt" }, {}),
  ).toMatchObject({
    host: "codex",
    program: "codex",
    sessionId: "x1",
    model: "gpt",
  });
  expect(
    hookSession({ conversationId: "a1", workspacePaths: ["/w"], modelName: "auto" }, {}),
  ).toMatchObject({
    host: "agy",
    program: "antigravity",
    sessionId: "a1",
    cwd: "/w",
    model: "auto",
  });
  expect(
    hookSession({ swarmail_host: "opencode", session_id: "ses_1", cwd: "/w" }, {}),
  ).toMatchObject({
    host: "opencode",
    sessionId: "ses_1",
  });
});

test("finds the T3 thread whose resume cursor holds the session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-state-"));
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  db.run(
    "create table provider_session_runtime (thread_id text, resume_cursor_json text, last_seen_at text)",
  );
  db.run(
    "insert into provider_session_runtime values ('thread-a', '{\"resume\":\"sess-1\"}', '1'), ('thread-b', '{\"sessionId\":\"sess-2\"}', '2')",
  );
  db.close();
  try {
    expect(t3ThreadId("sess-1", path)).toBe("thread-a");
    expect(t3ThreadId("sess-2", path)).toBe("thread-b");
    expect(t3ThreadId("sess-", path)).toBeNull();
    expect(t3ThreadId("sess-1", join(dir, "missing.sqlite"))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prints nothing on stdout for any host, since Antigravity denies the edit on any output", () => {
  const script = join(import.meta.dir, "../src/cli.ts");
  for (const input of [
    { session_id: "s1", cwd: "/" },
    {
      conversationId: "a1",
      workspacePaths: ["/"],
      toolCall: { name: "write_to_file", args: { TargetFile: "/x" } },
    },
    { session_id: "x1", turn_id: "t", cwd: "/" },
  ]) {
    const run = Bun.spawnSync(["bun", script, "register"], {
      stdin: new Blob([JSON.stringify(input)]),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
  }
});

test("a held lock makes a second registrar wait or give up, and a stale one is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-lock-"));
  const lock = join(dir, "s.lock");
  try {
    writeFileSync(lock, "");
    let ran = false;
    expect(
      withLock(
        lock,
        () => {
          ran = true;
        },
        { waitMs: 100 },
      ),
    ).toBe(false);
    expect(ran).toBe(false);
    utimesSync(lock, new Date(0), new Date(0));
    expect(
      withLock(
        lock,
        () => {
          ran = true;
        },
        { waitMs: 100 },
      ),
    ).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(lock)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent first edits of one session register once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-race-"));
  const mail = fakeMail(async (name) => {
    if (name === "list_agents") {
      return [];
    }
    await Bun.sleep(1000);
    return { name: "BlueLake" };
  });
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const env = { ...process.env, SWARMAIL_URL: mail.url, XDG_STATE_HOME: join(dir, "state") };
    const input = JSON.stringify({
      session_id: "race-1",
      cwd: repo,
      tool_input: { file_path: join(repo, "a.txt") },
    });
    const script = join(import.meta.dir, "../src/cli.ts");
    const runs = [1, 2].map(() =>
      Bun.spawn(["bun", script, "register"], { stdin: new Blob([input]), env }),
    );
    await Promise.all(runs.map((run) => run.exited));
    expect(mail.calls.filter((call) => call.name === "register_agent")).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(dir, "state/swarmail-register/race-1.json"), "utf8")).name,
    ).toBe("BlueLake");
  } finally {
    mail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edit from a session registered before tags retags its row and keeps name and task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-retag-"));
  const mail = fakeMail((name, args) =>
    name === "list_agents"
      ? [{ name: "TanOwl", task_description: "Claude Code session legacy-1 Room C90" }]
      : { name: args.name },
  );
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(dir, "state/swarmail-register"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(
      join(dir, "state/swarmail-register/legacy-1.json"),
      JSON.stringify({ name: "TanOwl", projects: [repo] }),
    );
    const env = {
      ...process.env,
      SWARMAIL_URL: mail.url,
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
      GROK_SESSION_ID: "",
      DEVIN_PROJECT_DIR: "",
      CLAUDECODE: "",
    };
    const input = JSON.stringify({
      session_id: "legacy-1",
      transcript_path: join(dir, ".claude/projects/repo/legacy-1.jsonl"),
      cwd: repo,
      tool_input: { file_path: join(repo, "a.txt") },
    });
    await Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "register"], {
      stdin: new Blob([input]),
      env,
    }).exited;
    const register = mail.calls.find((call) => call.name === "register_agent").arguments;
    expect(register.name).toBe("TanOwl");
    expect(register.task_description).toBe(
      "[claude:legacy-1 cwd:~/repo] Claude Code session legacy-1 Room C90",
    );
  } finally {
    mail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds the agent host above the hook and records its PID and start time", () => {
  const procs = {
    40: { comm: "sh", ppid: 30, start: "900" },
    30: { comm: "opencode.exe", ppid: 20, start: "800" },
    20: { comm: "node-MainThread", ppid: 1, start: "700" },
  };
  expect(hostProcess(40, (pid) => procs[pid] ?? null)).toEqual({
    name: "opencode.exe",
    pid: 30,
    start: "800",
  });
  expect(hostProcess(20, (pid) => procs[pid] ?? null)).toBeNull();
  expect(hostProcess(99, () => null)).toBeNull();
});

test("a failed registration tells Claude, then the next prompt retries against the server and reports the name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-retry-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  let server;
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const env = {
      ...process.env,
      SWARMAIL_URL: `http://127.0.0.1:${port}/mcp/`,
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
    };
    const script = join(import.meta.dir, "../src/cli.ts");
    const run = async (input) => {
      const proc = Bun.spawn(["bun", script, "register"], {
        stdin: new Blob([JSON.stringify(input)]),
        env,
      });
      await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      return out && JSON.parse(out).hookSpecificOutput;
    };
    const claude = {
      session_id: "retry-1",
      cwd: repo,
      transcript_path: join(dir, ".claude/projects/-repo/retry-1.jsonl"),
    };
    const edit = {
      ...claude,
      hook_event_name: "PreToolUse",
      tool_input: { file_path: join(repo, "a.txt") },
    };
    const prompt = { ...claude, hook_event_name: "UserPromptSubmit", prompt: "next?" };

    const failed = await run(edit);
    expect(failed.hookEventName).toBe("PreToolUse");
    expect(failed.additionalContext).toContain("registration for");
    expect(await run(prompt)).toMatchObject({ hookEventName: "UserPromptSubmit" });

    server = createServer(join(dir, "mail.sqlite3"), port);
    const registered = (await run(prompt)).additionalContext;
    const name = /registered as (\w+) in/.exec(registered)?.[1];
    expect(registered).toBe(`Swarmail: registered as ${name} in ${repo}.`);
    const roster = server.db.query("SELECT name, task_description FROM agents").all();
    expect(roster).toEqual([
      { name, task_description: `[claude:retry-1 cwd:~/repo] registered on first edit` },
    ]);
    const state = JSON.parse(
      readFileSync(join(dir, "state/swarmail-register/retry-1.json"), "utf8"),
    );
    expect(state.pending).toBeUndefined();
    expect(await run(prompt)).toBe("");
    expect(await run(edit)).toBe("");
  } finally {
    server?.server.stop(true);
    server?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("an unrecognised host gets no output even when its registration fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-unknown-"));
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const { CLAUDECODE, ...parent } = process.env;
    const env = {
      ...parent,
      SWARMAIL_URL: "http://127.0.0.1:9/mcp/",
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
    };
    const input = {
      session_id: "new-1",
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_input: { file_path: join(repo, "a.txt") },
    };
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "register"], {
      stdin: new Blob([JSON.stringify(input)]),
      env,
    });
    await proc.exited;
    expect(await new Response(proc.stdout).text()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("SessionEnd records the end and releases reservations in each project, keeping the name", () => {
  const dir = mkdtempSync(join(tmpdir(), "end-"));
  try {
    const statePath = join(dir, "s1.json");
    endSession(statePath, () => {
      throw new Error("no state, no release");
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      name: null,
      projects: [],
      ended: expect.any(String),
    });

    writeFileSync(statePath, JSON.stringify({ name: "TanOwl", projects: ["/a", "/b"] }));
    const released = [];
    endSession(
      statePath,
      (project, name) => {
        released.push([project, name]);
        if (project === "/a") {
          throw new Error("server down");
        }
      },
      new Date("2026-09-28T21:00:00Z"),
    );
    expect(released).toEqual([
      ["/a", "TanOwl"],
      ["/b", "TanOwl"],
    ]);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      name: "TanOwl",
      projects: ["/a", "/b"],
      ended: "2026-09-28T21:00:00.000Z",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
