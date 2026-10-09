import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  realpathSync,
  copyFileSync,
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
import { failureNotice, hookSession, targetDir } from "../src/register-hook.ts";
import {
  ensureRegistered,
  keptTask,
  nameIn,
  openRegistry,
  rowForSession,
  withLock,
} from "../src/registry.ts";
import { t3StatePath, t3ThreadId } from "../src/t3-state.ts";
import { addT3V2Thread, createT3V2Tables } from "./fixtures/t3-v2-state.js";
import { parseTag, sessionTag } from "../src/tag.ts";
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
  const root = tmpdir();
  // Git prints forward slashes on every platform; the checkout comes back in the native form.
  const run = (common) => () => common.replaceAll("\\", "/");
  const repo = join(root, "repo");
  expect(primaryCheckout(join(root, "w", "repo-task"), run(join(repo, ".git")))).toBe(repo);
  expect(primaryCheckout(repo, run(join(repo, ".git")))).toBe(repo);
  expect(primaryCheckout(join(root, "bare"), run(join(root, "bare.git")))).toBeNull();
  expect(
    primaryCheckout(root, () => {
      throw new Error("not a repo");
    }),
  ).toBeNull();
});

test("resolves the edited file's folder, falling back to the session cwd", () => {
  const root = tmpdir();
  const home = join(root, "no-such-home");
  expect(targetDir({ cwd: home, tool_input: { file_path: join(root, "new-dir", "x.ts") } })).toBe(
    root,
  );
  expect(targetDir({ cwd: home, tool_input: {} })).toBe(home);
  expect(targetDir({ tool_input: { file_path: "relative.ts" } })).toBeNull();
  const patch = "*** Begin Patch\n*** Update File: sub/x.ts\n@@\n*** End Patch";
  expect(targetDir({ cwd: root, tool_input: { command: patch } })).toBe(root);
  expect(
    targetDir({ cwd: home, tool_input: { command: `*** Add File: ${join(root, "a", "b.ts")}` } }),
  ).toBe(root);
  expect(
    targetDir({ cwd: home, toolCall: { args: { TargetFile: join(root, "new", "c.ts") } } }),
  ).toBe(root);
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

test("a name another session holds in a project is replaced there only", () => {
  const taken = (project, name) => {
    if (name === "TanOwl" && project === "/home/u/b") {
      taken.refusal = "Registration cannot replace a bound lifecycle identity.";
      return null;
    }
    taken.refusal = undefined;
    return name ?? "BlueHarbor";
  };
  const first = { name: "TanOwl", projects: ["/home/u/a"], tags: { "/home/u/a": "[t1]" } };
  const state = ensureRegistered(first, "/home/u/b", "[t1]", taken);
  expect(state.name).toBe("TanOwl");
  expect(state.names).toEqual({ "/home/u/b": "BlueHarbor" });
  expect(nameIn(state, "/home/u/a")).toBe("TanOwl");
  expect(nameIn(state, "/home/u/b")).toBe("BlueHarbor");
  // Later registrations in each project ask for that project's name.
  const calls = [];
  const record = (project, name) => {
    calls.push([project, name]);
    return name;
  };
  ensureRegistered({ ...state, tags: {} }, "/home/u/b", "[t2]", record);
  ensureRegistered({ ...state, tags: {} }, "/home/u/a", "[t2]", record);
  expect(calls).toEqual([
    ["/home/u/b", "BlueHarbor"],
    ["/home/u/a", "TanOwl"],
  ]);
});

test("a server that does not answer keeps the name and records nothing new", () => {
  const down = () => null;
  const state = { name: "TanOwl", projects: [] };
  expect(ensureRegistered(state, "/home/u/b", "[t1]", down)).toBe(state);
});

test("ending a session releases each project's reservations under that project's name", () => {
  const dir = mkdtempSync(join(tmpdir(), "end-names-"));
  try {
    const registry = openRegistry(dir);
    registry.settle("s1", {
      since: 0,
      project: "/home/u/a",
      tag: "[t1]",
      register: (_project, name) => name ?? "TanOwl",
    });
    registry.settle("s1", {
      since: 0,
      project: "/home/u/b",
      tag: "[t1]",
      register: Object.assign((_project, name) => (name ? null : "BlueHarbor"), {
        refusal: "held",
      }),
    });
    const released = [];
    registry.end("s1", (project, name) => released.push([project, name]), new Date(1));
    expect(released).toEqual([
      ["/home/u/a", "TanOwl"],
      ["/home/u/b", "BlueHarbor"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    "registered by hook",
  );
  expect(keptTask("[claude:s cwd:~/w] registered on first edit")).toBe("registered by hook");
  expect(keptTask("[claude:s cwd:~/w] registered by hook")).toBe("registered by hook");
  expect(keptTask("Room C90 validation")).toBe("Room C90 validation");
  expect(keptTask(undefined)).toBe("registered by hook");
});

test("finds a hand-registered row by the session id in its tag", () => {
  const rows = [
    {
      name: "WildDeer",
      task_description: "[t3:c86a claude:a5ff-46 cwd:~/w] registered on first edit",
    },
    { name: "DarkDune", task_description: "[claude:a5ff cwd:~/w] TLA+ pilot" },
  ];
  const find = (tag) => rowForSession(rows, parseTag(tag))?.name ?? null;
  expect(find("[claude:a5ff cwd:~/w]")).toBe("DarkDune");
  expect(find("[claude:a5ff-46 cwd:~/w]")).toBe("WildDeer");
  expect(find("[claude:zzzz cwd:~/w]")).toBeNull();
  // A new provider session in the same T3 thread keeps the thread's row; another thread with the same session does not.
  expect(find("[t3:c86a claude:b6ee cwd:~/w]")).toBe("WildDeer");
  expect(find("[t3:d97b claude:a5ff-46 cwd:~/w]")).toBeNull();
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
  expect(
    hookSession(
      { swarmail_host: "devin", session_id: "d1" },
      { DEVIN_PROJECT_DIR: "/w", CLAUDECODE: "1" },
    ),
  ).toMatchObject({ host: "devin", sessionId: "d1", cwd: "/w" });
  expect(
    hookSession(
      { swarmail_host: "devin", session_id: "d1", cwd: "/other" },
      { DEVIN_PROJECT_DIR: "/w" },
    ),
  ).toMatchObject({ host: "devin", cwd: "/other" });
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "t3-state-")));
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

test("after the V2 cutover, finds the thread from V2's native thread reference", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "t3-state-")));
  mkdirSync(join(dir, "userdata"));
  const v1 = join(dir, "userdata/state.sqlite");
  const db = new Database(v1);
  db.run(
    "create table provider_session_runtime (thread_id text, resume_cursor_json text, last_seen_at text)",
  );
  db.run(
    "insert into provider_session_runtime values ('thread-a', '{\"threadId\":\"sess-1\"}', '1')",
  );
  db.close();
  try {
    expect(t3StatePath(dir)).toBe(v1);
    // V2 starts from a copy of V1's database and leaves the copied runtime rows frozen.
    const v2 = join(dir, "userdata/statev2.sqlite");
    copyFileSync(v1, v2);
    const copy = new Database(v2);
    createT3V2Tables(copy);
    addT3V2Thread(copy, { threadId: "thread-b", nativeId: "sess-2" });
    copy.close();
    expect(t3StatePath(dir)).toBe(v2);
    expect(t3ThreadId("sess-2", v2)).toBe("thread-b");
    expect(t3ThreadId("sess-1", v2)).toBeNull();
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-lock-")));
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-race-")));
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-retag-")));
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
      `[claude:legacy-1 cwd:${join("~", "repo")}] Claude Code session legacy-1 Room C90`,
    );
  } finally {
    mail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new provider session in a T3 thread takes over the thread's name", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-t3-thread-")));
  const mail = fakeMail((name, args) =>
    name === "list_agents"
      ? [
          { name: "QuietElm", task_description: "[claude:other-sid cwd:~/repo] unrelated" },
          {
            name: "BoldWillow",
            task_description: "[t3:thread-1 claude:old-sid cwd:~/repo] Swarmail release",
          },
        ]
      : { name: args.name ?? "FreshName" },
  );
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    mkdirSync(join(dir, ".t3/userdata"), { recursive: true });
    const t3 = new Database(join(dir, ".t3/userdata/statev2.sqlite"));
    createT3V2Tables(t3);
    addT3V2Thread(t3, { threadId: "thread-1", nativeId: "new-sid", driver: "claudeAgent" });
    t3.close();
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
      session_id: "new-sid",
      transcript_path: join(dir, ".claude/projects/repo/new-sid.jsonl"),
      cwd: repo,
      tool_input: { file_path: join(repo, "a.txt") },
    });
    await Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "register"], {
      stdin: new Blob([input]),
      env,
    }).exited;
    const register = mail.calls.find((call) => call.name === "register_agent").arguments;
    expect(register.name).toBe("BoldWillow");
    expect(register.task_description).toBe(
      `[t3:thread-1 claude:new-sid cwd:${join("~", "repo")}] Swarmail release`,
    );
  } finally {
    mail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register --tag takes the session id from the host's shell variable when none is given", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-tag-")));
  try {
    const tag = (args, env) =>
      Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "register", ...args], {
        cwd: dir,
        env: { ...process.env, HOME: dir, CODEX_THREAD_ID: "", ...env },
      })
        .stdout.toString()
        .trim();
    expect(tag(["--tag", "codex"], { CODEX_THREAD_ID: "env-sid" })).toBe("[codex:env-sid cwd:~]");
    expect(tag(["--tag", "codex", "arg-sid"], { CODEX_THREAD_ID: "env-sid" })).toBe(
      "[codex:arg-sid cwd:~]",
    );
    expect(tag(["--tag", "codex"], {})).toBe("[codex cwd:~]");
  } finally {
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

test("a registration the server refuses says so instead of blaming an unanswered server", async () => {
  // serverRegister blocks on curl, so it runs in its own process, away from the stand-in server.
  const attempt = async (url) => {
    const code = `
      import { serverRegister } from ${JSON.stringify(join(import.meta.dir, "../src/registry.ts"))};
      const session = { host: "claude", program: "claude-code", model: null, sessionId: "s1", cwd: null };
      const register = serverRegister(session, "[claude:s1]", ${JSON.stringify(url)});
      console.log(JSON.stringify({ name: register("/home/u/c", "TanGlen"), refusal: register.refusal ?? null }));`;
    const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe" });
    await proc.exited;
    return JSON.parse(await new Response(proc.stdout).text());
  };
  const refused = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const msg = await req.json();
      const reply = (result) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.params.name === "list_agents") {
        return reply({ content: [{ type: "text", text: "[]" }] });
      }
      const error = {
        error: {
          type: "INVALID_ARGUMENT",
          message: "Registration cannot replace a bound lifecycle identity.",
        },
      };
      return reply({ isError: true, content: [{ type: "text", text: JSON.stringify(error) }] });
    },
  });
  try {
    const result = await attempt(`http://127.0.0.1:${refused.port}/mcp/`);
    expect(result).toEqual({
      name: null,
      refusal: "Registration cannot replace a bound lifecycle identity.",
    });
    expect(failureNotice("/home/u/c", "[claude:s1]", result.refusal)).toContain(
      "the server refused it (Registration cannot replace a bound lifecycle identity.)",
    );
  } finally {
    refused.stop(true);
  }
  expect(await attempt("http://127.0.0.1:1/mcp/")).toEqual({ name: null, refusal: null });
  expect(failureNotice("/home/u/c", "[claude:s1]")).toContain("the server did not answer");
});

test("the hook registers under a fresh name when the server refuses the session's own", async () => {
  // serverRegister blocks on curl, so it runs in its own process, away from the stand-in server.
  const calls = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const msg = await req.json();
      const { name, arguments: args } = msg.params;
      calls.push([name, args.name]);
      const reply = (result) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      if (name === "list_agents") {
        return reply(text([]));
      }
      if (args.name === "TanOwl") {
        const error = {
          error: { message: "Registration cannot replace a bound lifecycle identity." },
        };
        return reply({ isError: true, ...text(error) });
      }
      return reply(text({ name: args.name ?? "BlueHarbor" }));
    },
  });
  try {
    const code = `
      import { ensureRegistered, serverRegister } from ${JSON.stringify(join(import.meta.dir, "../src/registry.ts"))};
      const session = { host: "claude", program: "claude-code", model: null, sessionId: "s1", cwd: null };
      const register = serverRegister(session, "[claude:s1]", ${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});
      const state = { name: "TanOwl", projects: ["/home/u/a"], tags: { "/home/u/a": "[claude:s1]" } };
      console.log(JSON.stringify(ensureRegistered(state, "/home/u/b", "[claude:s1]", register)));`;
    const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe" });
    await proc.exited;
    const state = JSON.parse(await new Response(proc.stdout).text());
    expect(state.name).toBe("TanOwl");
    expect(state.names).toEqual({ "/home/u/b": "BlueHarbor" });
    expect(state.projects).toEqual(["/home/u/a", "/home/u/b"]);
    expect(calls.filter(([tool]) => tool === "register_agent")).toEqual([
      ["register_agent", "TanOwl"],
      ["register_agent", undefined],
    ]);
  } finally {
    server.stop(true);
  }
});

test("a failed registration tells Claude, then the next prompt retries against the server and reports the name", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-retry-")));
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
      {
        name,
        task_description: `[claude:retry-1 cwd:${join("~", "repo")}] registered by hook`,
      },
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

test("a claude -p run registers on its first edit, not at start", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-headless-")));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = createServer(join(dir, "mail.sqlite3"), port);
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const { CLAUDECODE, ...parent } = process.env;
    const env = {
      ...parent,
      CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
      SWARMAIL_URL: `http://127.0.0.1:${port}/mcp/`,
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
    };
    const run = async (input) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "register"], {
        stdin: new Blob([JSON.stringify(input)]),
        env,
      });
      await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      return out && JSON.parse(out);
    };
    const roster = () => server.db.query("SELECT name FROM agents").all();
    const claude = {
      session_id: "headless-1",
      cwd: repo,
      transcript_path: join(dir, ".claude/projects/-repo/headless-1.jsonl"),
    };
    expect(await run({ ...claude, hook_event_name: "SessionStart", source: "startup" })).toBe("");
    expect(await run({ ...claude, hook_event_name: "SessionEnd" })).toBe("");
    expect(roster()).toEqual([]);

    // A headless run that edits files still registers, once.
    const edit = {
      ...claude,
      session_id: "headless-2",
      hook_event_name: "PreToolUse",
      tool_input: { file_path: join(repo, "a.txt") },
    };
    expect(
      await run({ ...claude, session_id: "headless-2", hook_event_name: "SessionStart" }),
    ).toBe("");
    await run(edit);
    expect(roster()).toHaveLength(1);
  } finally {
    server.server.stop(true);
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("a session registers at start, keeps that one name through edits, restarts and hand registration", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-start-")));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = createServer(join(dir, "mail.sqlite3"), port);
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const { CLAUDECODE, ...parent } = process.env;
    const env = {
      ...parent,
      SWARMAIL_URL: `http://127.0.0.1:${port}/mcp/`,
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
    };
    const run = async (input) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "register"], {
        stdin: new Blob([JSON.stringify(input)]),
        env,
      });
      await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      return out && JSON.parse(out);
    };
    const roster = () =>
      server.db.query("SELECT name, task_description FROM agents ORDER BY id").all();
    const claude = {
      session_id: "start-1",
      cwd: repo,
      transcript_path: join(dir, ".claude/projects/-repo/start-1.jsonl"),
    };
    const start = { ...claude, hook_event_name: "SessionStart", source: "startup" };

    const started = (await run(start)).hookSpecificOutput;
    expect(started.hookEventName).toBe("SessionStart");
    const name = /registered as (\w+) in/.exec(started.additionalContext)?.[1];
    expect(started.additionalContext).toContain(`Use ${name} as your agent name`);
    const tag = `[claude:start-1 cwd:${join("~", "repo")}]`;
    expect(roster()).toEqual([{ name, task_description: `${tag} registered by hook` }]);

    const edit = {
      ...claude,
      hook_event_name: "PreToolUse",
      tool_input: { file_path: join(repo, "a.txt") },
    };
    expect(await run(edit)).toBe("");
    // After compaction the session has lost its name, so the start hook repeats it.
    const again = (await run({ ...start, source: "compact" })).hookSpecificOutput;
    expect(again.additionalContext).toContain(`registered as ${name} in ${repo}`);

    // The agent registering by hand with its tag, and no name, gets the same agent back.
    // The server runs in this process, so the call can't block on curl the way the hook's does.
    const res = await fetch(env.SWARMAIL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "macro_start_session",
          arguments: {
            human_key: repo,
            program: "claude-code",
            model: "test",
            task_description: `${tag} README edits`,
          },
        },
      }),
    });
    const hand = JSON.parse((await res.json()).result.content[0].text);
    expect(hand.agent.name).toBe(name);
    expect(roster()).toHaveLength(1);

    // The edit location follows another worktree of the same project, while the launch tag and name stay.
    const git = (...args) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...args]);
      expect(result.exitCode).toBe(0);
    };
    git(
      "-c",
      "user.name=Tester",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    const edited = join(dir, "edited checkout");
    git("worktree", "add", "-qb", "edit-branch", edited);
    expect(await run({ ...edit, tool_input: { file_path: join(edited, "new", "a.txt") } })).toBe(
      "",
    );
    const row = server.db.query("SELECT name, cwd, worktree FROM agents WHERE name = ?").get(name);
    expect(row).toEqual({ name, cwd: join("~", "repo"), worktree: edited });
    await run({ ...start, source: "compact" });
    expect(server.db.query("SELECT worktree FROM agents WHERE name = ?").get(name).worktree).toBe(
      edited,
    );

    expect(await run(edit)).toBe("");
    expect(server.db.query("SELECT worktree FROM agents WHERE name = ?").get(name).worktree).toBe(
      repo,
    );

    // A failed edit in B must be superseded by a newer successful edit in A before the prompt retries it.
    const online = env.SWARMAIL_URL;
    env.SWARMAIL_URL = "http://127.0.0.1:1/mcp/";
    try {
      await run({ ...edit, tool_input: { file_path: join(edited, "a.txt") } });
    } finally {
      env.SWARMAIL_URL = online;
    }
    const stateFile = join(env.XDG_STATE_HOME, "swarmail-register", "start-1.json");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).pending.worktree).toBe(edited);
    await run(edit);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).pending).toBeUndefined();
    await run({ ...claude, hook_event_name: "UserPromptSubmit" });
    expect(server.db.query("SELECT worktree FROM agents WHERE name = ?").get(name).worktree).toBe(
      repo,
    );

    // Cursor's own sessionStart payload (captured from the Cursor CLI) gets Cursor's flat output.
    const cursor = await run({
      conversation_id: "13ff971f-ae2c-474b-b587-12f163fba67e",
      session_id: "13ff971f-ae2c-474b-b587-12f163fba67e",
      hook_event_name: "sessionStart",
      is_background_agent: false,
      workspace_roots: [repo],
      transcript_path: null,
    });
    const cursorName = /registered as (\w+) in/.exec(cursor.additional_context)?.[1];
    expect(cursorName).toBeTruthy();
    expect(cursorName).not.toBe(name);
    expect(roster().map((row) => row.name)).toEqual([name, cursorName]);

    // Outside a repository there is nothing to register in, so the session learns its tag.
    const home = join(dir, "elsewhere");
    mkdirSync(home);
    const loose = (await run({ ...start, session_id: "start-2", cwd: home })).hookSpecificOutput
      .additionalContext;
    expect(loose).toContain("your session tag is [claude:start-2 cwd:");
    expect(roster()).toHaveLength(2);
  } finally {
    server.server.stop(true);
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("an unrecognised host gets no output even when its registration fails", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-unknown-")));
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "end-")));
  try {
    const statePath = join(dir, "s1.json");
    const registry = openRegistry(dir);
    registry.end("s1", () => {
      throw new Error("no state, no release");
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      name: null,
      projects: [],
      ended: expect.any(String),
    });

    writeFileSync(statePath, JSON.stringify({ name: "TanOwl", projects: ["/a", "/b"] }));
    const released = [];
    registry.end(
      "s1",
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
