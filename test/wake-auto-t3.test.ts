import { expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostAlive } from "../src/proc.ts";
import type { HostProcess } from "../src/proc.ts";
import { createServer } from "../src/server.ts";
import { createTools } from "../src/tools.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  automaticBinding,
  automaticT3Threads,
  enrollSince,
  heldT3State,
  rescanDue,
} from "../src/wake-auto-t3.ts";
import type { RegisterState } from "../src/registry.ts";
import { testScratch } from "./fixtures/test-scratch.ts";
import { addT3V2Thread, createT3V2Tables } from "./fixtures/t3-v2-state.ts";

/** Settles a test server's pending response; the barriers below hold these. */
type Resolve = (response: Response) => void;

// The supervisor needs Unix file permissions for credential rotation and the tests use POSIX shell wrappers.
const test = process.platform === "linux" ? bunTest : bunTest.skip;

const scratch = testScratch();

/** T3's database with one running Codex thread, `thread-1` on native session `native-1`. */
function fixture() {
  const root = mkdtempSync(join(scratch, "case-"));
  const registry = join(root, "state/swarmail-register");
  mkdirSync(registry, { recursive: true });
  mkdirSync(join(root, ".t3/userdata"), { recursive: true });
  const db = new Database(join(root, ".t3/userdata/statev2.sqlite"));
  createT3V2Tables(db);
  addT3V2Thread(db, { threadId: "thread-1", nativeId: "native-1", updatedAt: "2026-09-30" });
  return {
    root,
    registry,
    db,
    state: join(registry, "native-1.json"),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Sets a T3 thread's settlement override; null reactivates it. Without `thread`, every thread's. */
function settleT3(db: Database, override: string | null, thread?: string) {
  db.query(
    `UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledOverride',?)${thread ? " WHERE thread_id=?" : ""}`,
  ).run(...(thread ? [override, thread] : [override]));
}

/** Archives (or with null restores) a T3 thread. Without `thread`, every thread. */
function archiveT3(db: Database, archived: string | null, thread?: string) {
  db.query(
    `UPDATE orchestration_v2_projection_threads SET archived_at=?${thread ? " WHERE thread_id=?" : ""}`,
  ).run(...(thread ? [archived, thread] : [archived]));
}

test("first read-only Codex tool registers a T3 mailbox, the next scan makes it eligible for automatic wake, and later registration retains that", async () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const message = (await req.json()) as any;
      const value = message.params.name === "list_agents" ? [] : { name: "BlueLake" };
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    },
  });
  try {
    const env = {
      ...process.env,
      HOME: f.root,
      XDG_STATE_HOME: join(f.root, "state"),
      SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
    };
    const input = {
      session_id: "native-1",
      turn_id: "turn-1",
      hook_event_name: "PreToolUse",
      cwd: repo,
      tool_input: { command: "git status --short" },
    };
    for (const turn_id of ["turn-1", "turn-2"]) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/cli.ts"), "register"],
        {
          env,
          stdin: new Blob([JSON.stringify({ ...input, turn_id })]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      if (turn_id === "turn-1") {
        expect(automaticT3Threads(f.registry, join(f.root, ".t3")).size).toBe(0);
        const source = join(import.meta.dir, "../src/wake-auto-t3.ts");
        const code = `import {enrollT3Threads} from ${JSON.stringify(source)}; enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},"2026-09-29T00:00:00Z",${JSON.stringify(env.SWARMAIL_URL)});`;
        settleT3(f.db, "settled");
        expect(await Bun.spawn([process.execPath, "-e", code]).exited).toBe(0);
        expect(JSON.parse(readFileSync(f.state, "utf8")).wakeThread).toBeUndefined();
        settleT3(f.db, null);
        expect(await Bun.spawn([process.execPath, "-e", code]).exited).toBe(0);
      }
      expect(JSON.parse(readFileSync(f.state, "utf8")).wakeThread).toBe("thread-1");
      expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual(["thread-1"]);
    }
  } finally {
    await server.stop(true);
    f.close();
  }
});

test("enrollment and selection read only running, active Codex and Cursor threads", async () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
  const db = f.db;
  // Imported threads have no provider thread until their next turn.
  db.query(
    "INSERT INTO orchestration_v2_projection_threads VALUES ('thread-0','project-1','t','codex','full-access','default',NULL,'x','x',NULL,NULL,'{}','codex')",
  ).run();
  addT3V2Thread(db, { threadId: "thread-2", nativeId: "native-2", status: "active" });
  addT3V2Thread(db, {
    threadId: "thread-3",
    nativeId: "native-3",
    relationshipToParent: "subagent",
  });
  addT3V2Thread(db, { threadId: "thread-4", nativeId: "native-4", archivedAt: "x" });
  addT3V2Thread(db, { threadId: "thread-5", nativeId: "native-5", status: "closed" });
  // Claude's own stop hook wakes a Claude thread, so the service leaves it alone.
  addT3V2Thread(db, { threadId: "thread-6", nativeId: "native-6", driver: "claudeAgent" });
  addT3V2Thread(db, { threadId: "thread-7", nativeId: "agent-7", driver: "cursor" });
  const settledThreads: [string, string, string, string, string][] = [
    ["thread-8", "native-8", "codex", "settledOverride", "settled"],
    ["thread-9", "agent-9", "cursor", "settledAt", "2026-10-03T03:00:00Z"],
  ];
  for (const [threadId, nativeId, driver, field, value] of settledThreads) {
    addT3V2Thread(db, { threadId, nativeId, driver });
    db.query(
      "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,?,?) WHERE thread_id=?",
    ).run(`$.${field}`, value, threadId);
  }
  const calls: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const message = (await req.json()) as any;
      calls.push(message.params);
      const value = message.params.name === "list_agents" ? [] : { name: "BlueLake" };
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    },
  });
  try {
    const source = join(import.meta.dir, "../src/wake-auto-t3.ts");
    const code = `import {enrollT3Threads} from ${JSON.stringify(source)}; enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},"2026-10-03T00:00:00Z",${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(calls.filter((x) => x.name === "register_agent")).toHaveLength(2);
    expect(existsSync(f.state)).toBe(false);
    expect(JSON.parse(readFileSync(join(f.registry, "native-2.json"), "utf8"))).toMatchObject({
      name: "BlueLake",
      projects: [repo],
      wakeThread: "thread-2",
    });
    const cursor = JSON.parse(readFileSync(join(f.registry, "agent-7.json"), "utf8"));
    expect(cursor).toMatchObject({ projects: [repo], wakeThread: "thread-7" });
    expect(cursor.tags[repo].startsWith("[t3:thread-7 cursor:agent-7 ")).toBe(true);
    expect(existsSync(join(f.registry, "native-6.json"))).toBe(false);
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))].sort()).toEqual([
      "thread-2",
      "thread-7",
    ]);
    expect(existsSync(join(f.registry, "native-8.json"))).toBe(false);
    expect(existsSync(join(f.registry, "agent-9.json"))).toBe(false);
    settleT3(db, "settled", "thread-2");
    db.query(
      "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledAt','settled') WHERE thread_id='thread-7'",
    ).run();
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual([]);
    db.query(
      "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledOverride','active','$.settledAt',NULL)",
    ).run();
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))].sort()).toEqual([
      "thread-2",
      "thread-7",
    ]);
    const resumed = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(await resumed.exited, await new Response(resumed.stderr).text()).toBe(0);
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))].sort()).toEqual([
      "thread-2",
      "thread-7",
      "thread-8",
      "thread-9",
    ]);
  } finally {
    await server.stop(true);
    f.close();
  }
});

test("thread selection survives registration, end, resume, archive and provider replacement orderings", () => {
  const f = fixture();
  try {
    const events = ["register", "end", "resume", "archive", "replace", "settle", "reactivate"];
    const sequences: string[][] = [[]];
    for (let depth = 0; depth < 3; depth++) {
      for (const prefix of sequences.filter((x) => x.length === depth)) {
        for (const event of events) {
          sequences.push([...prefix, event]);
        }
      }
    }
    for (const sequence of sequences) {
      let state: RegisterState = {
        name: "BlueLake",
        projects: ["/repo"],
        tags: { "/repo": "[t3:thread-1 codex:native-1 cwd:/repo]" },
      };
      let archived = false,
        replaced = false,
        settled = false;
      for (const event of sequence) {
        if (event === "register") {
          state.wakeThread = "thread-1";
        }
        if (event === "end") {
          state.ended = "ended";
        }
        if (event === "resume") {
          delete state.ended;
        }
        if (event === "archive") {
          archived = true;
        }
        if (event === "replace") {
          replaced = true;
        }
        if (event === "settle") {
          settled = true;
        }
        if (event === "reactivate") {
          settled = false;
        }
      }
      writeFileSync(f.state, JSON.stringify(state));
      // Duplicate state must not spawn a second bridge; an old provider cannot claim its replacement.
      writeFileSync(join(f.registry, "native-old.json"), JSON.stringify(state));
      archiveT3(f.db, archived ? "archived" : null);
      settleT3(f.db, settled ? "settled" : null);
      f.db
        .query(
          "UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.nativeThreadRef.nativeId',?)",
        )
        .run(replaced ? "native-new" : "native-1");
      const selected = [...automaticT3Threads(f.registry, join(f.root, ".t3"))];
      expect(selected, sequence.join(" → ")).toEqual(
        state.wakeThread && !state.ended && !archived && !replaced && !settled ? ["thread-1"] : [],
      );
    }
  } finally {
    f.close();
  }
});

test("runtime enrollment registers a fresh read-only T3 session without native hooks and preserves its name on restart", async () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
  f.db
    .query(
      "UPDATE orchestration_v2_projection_provider_threads SET updated_at='2026-09-30T22:00:00Z'",
    )
    .run();
  const calls: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const message = (await req.json()) as any;
      calls.push(message.params);
      const value = message.params.name === "list_agents" ? [] : { name: "BlueLake" };
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    },
  });
  try {
    const source = join(import.meta.dir, "../src/wake-auto-t3.ts");
    const run = async (after: string) => {
      const code = `import {enrollT3Threads} from ${JSON.stringify(source)}; enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},${JSON.stringify(after)},${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});`;
      expect(
        await Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }).exited,
      ).toBe(0);
    };
    await run("2026-09-30T23:00:00Z");
    expect(calls).toHaveLength(0);
    await run("2026-09-30T21:00:00Z");
    await run("2026-09-30T21:00:00Z");
    expect(calls.filter((x) => x.name === "register_agent")).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.state, "utf8"))).toMatchObject({
      name: "BlueLake",
      projects: [repo],
      wakeThread: "thread-1",
    });
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual(["thread-1"]);
  } finally {
    await server.stop(true);
    f.close();
  }
});

test("enrollment skips a running T3 row last seen before the registration window", async () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
  f.db
    .query(
      "UPDATE orchestration_v2_projection_provider_threads SET updated_at='2026-09-30T22:00:00Z'",
    )
    .run();
  const calls: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const message = (await req.json()) as any;
      calls.push(message.params);
      const value = message.params.name === "list_agents" ? [] : { name: "BlueLake" };
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    },
  });
  try {
    const source = join(import.meta.dir, "../src/wake-auto-t3.ts");
    const run = async (now: string) => {
      const after = enrollSince("2026-09-01T00:00:00Z", Date.parse(now));
      const code = `import {enrollT3Threads} from ${JSON.stringify(source)}; enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},${JSON.stringify(after)},${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});`;
      expect(await Bun.spawn([process.execPath, "-e", code]).exited).toBe(0);
    };
    // The sweep has deleted this session's registration; its stale row must not bring it back.
    await run("2026-10-20T00:00:00Z");
    expect(calls).toHaveLength(0);
    expect(existsSync(f.state)).toBe(false);
    await run("2026-10-05T00:00:00Z");
    expect(JSON.parse(readFileSync(f.state, "utf8")).wakeThread).toBe("thread-1");
  } finally {
    await server.stop(true);
    f.close();
  }
});

for (const mode of [
  "registration-retry",
  "end-during-registration",
  "end-before-first-registration",
  "stopped-after-end",
]) {
  test(`runtime enrollment protects ${mode} through its actual writers`, async () => {
    const f = fixture();
    const repo = join(f.root, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
    f.db
      .query(
        "UPDATE orchestration_v2_projection_provider_threads SET updated_at='2026-09-30T22:00:00Z'",
      )
      .run();
    if (mode !== "end-before-first-registration") {
      writeFileSync(
        f.state,
        JSON.stringify({
          name: "BlueLake",
          projects: [repo],
          ...(mode === "stopped-after-end" ? { ended: "2026-09-30T21:00:00Z" } : {}),
        }),
      );
    }
    if (mode === "stopped-after-end") {
      f.db.query("UPDATE orchestration_v2_projection_provider_threads SET status='closed'").run();
    }
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let reached!: () => void;
    const registering = new Promise<void>((done) => {
      reached = done;
    });
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const msg = (await req.json()) as any;
        if (msg.params.name === "register_agent") {
          attempts++;
          reached();
          if (mode === "end-during-registration" || mode === "end-before-first-registration") {
            await held;
          }
          if (mode === "registration-retry" && attempts === 1) {
            return Response.json({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "temporarily unavailable" },
            });
          }
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(msg.params.name === "list_agents" ? [] : { name: "BlueLake" }),
              },
            ],
          },
        });
      },
    });
    const children: Bun.Subprocess[] = [];
    const module = join(import.meta.dir, "../src/wake-auto-t3.ts");
    const start = () => {
      const code = `import {enrollT3Threads} from ${JSON.stringify(module)};enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},"2026-09-30T20:00:00Z",${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});`;
      const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
      children.push(child);
      return child;
    };
    try {
      const first = start();
      if (mode === "end-during-registration" || mode === "end-before-first-registration") {
        await registering;
        const registryModule = join(import.meta.dir, "../src/registry.ts");
        const end = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import {openRegistry} from ${JSON.stringify(registryModule)};console.log("before-end");openRegistry(${JSON.stringify(dirname(f.state))}).end("native-1",()=>{},new Date("2026-09-30T23:00:00Z"));`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        children.push(end);
        const reader = end.stdout.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("before-end");
        release();
        expect(await first.exited).toBe(0);
        expect(await end.exited).toBe(0);
        expect(await start().exited).toBe(0);
        expect(JSON.parse(readFileSync(f.state, "utf8")).ended).toBe("2026-09-30T23:00:00.000Z");
        expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual([]);
      } else if (mode === "registration-retry") {
        expect(await first.exited).toBe(0);
        expect(JSON.parse(readFileSync(f.state, "utf8")).pending).toBeDefined();
        expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual([]);
        expect(await start().exited).toBe(0);
        expect(attempts).toBe(2);
        expect(JSON.parse(readFileSync(f.state, "utf8")).pending).toBeUndefined();
        expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual(["thread-1"]);
      } else {
        expect(await first.exited).toBe(0);
        expect(attempts).toBe(0);
        expect(JSON.parse(readFileSync(f.state, "utf8")).ended).toBe("2026-09-30T21:00:00Z");
      }
    } finally {
      release();
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      }
      await server.stop(true);
      f.close();
    }
  });
}

test("automatic config rejects unverified rotation before touching credentials", async () => {
  const f = fixture();
  try {
    const config = join(f.root, "config.json");
    const header = join(f.root, "authorization");
    writeFileSync(
      config,
      JSON.stringify({
        swarmailUrl: "http://127.0.0.1:18765",
        target: {
          type: "t3-v2-queue",
          url: "http://127.0.0.1:3775",
          id: "t3-auto-wake",
          authorizationFile: header,
        },
        rotation: { baseDir: join(f.root, ".t3"), verifyBackend: false },
        enrollAfter: "2026-09-30T22:00:00Z",
      }),
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "wake-auto-t3", config, "--check"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("verified backend rotation");
    expect(() => readFileSync(header)).toThrow();
  } finally {
    f.close();
  }
});

test("supervisor state survives a T3 upgrade and credential cutover, but not a new destination", async () => {
  const { automaticBinding, automaticT3Configuration } = await import("../src/wake-auto-t3.ts");
  const { openWakeState } = await import("../src/wake-state.ts");
  const root = mkdtempSync(join(scratch, "case-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const path = join(root, "config.json");
    const configure = (target: Record<string, unknown>, rotation: Record<string, unknown>) => {
      writeFileSync(
        path,
        JSON.stringify({
          swarmailUrl: "http://127.0.0.1:18765",
          target: { type: "t3-v2-queue", id: "t3-auto-wake", ...target },
          rotation: { baseDir: join(root, ".t3"), verifyBackend: true, ...rotation },
          enrollAfter: "2026-09-30T22:00:00Z",
        }),
      );
      return automaticT3Configuration(path);
    };
    const open = (binding: string) =>
      openWakeState("http://127.0.0.1:18765", "t3-auto", binding, "swarmail-auto-t3").close();
    // The binding saved before it dropped the binary, version and credential file.
    const before = configure(
      { authorizationFile: join(root, "authorization-v1") },
      { executable: join(root, "runtime-a/t3"), version: "0.0.45-nightly.20261002.2561" },
    );
    const { url, ...target } = before.target;
    open(JSON.stringify({ ...before, target, enrollAfter: undefined }));
    const upgraded = configure(
      { authorizationFile: join(root, "authorization-v2") },
      { executable: join(root, "runtime-b/t3"), version: "0.0.46-nightly.20261003.2610" },
    );
    expect(() => open(automaticBinding(upgraded))).not.toThrow();
    expect(() => open(automaticBinding(configure({}, {})))).not.toThrow();
    expect(() => open(automaticBinding(configure({ delivery: "auto" }, {})))).not.toThrow();
    expect(() => configure({ delivery: "restart" }, {})).toThrow("explicit protocol");
    expect(() => configure({ type: "t3-v1-steer" }, {})).toThrow(
      "target type t3-v1-steer was removed: current T3 Code runs only its V2 engine, which has no V1 route; use t3-v2-queue",
    );
    expect(() => configure({ type: "opencode-v2-queue" }, {})).toThrow("explicit protocol");
    const moved = configure({}, { baseDir: join(root, "other-t3") });
    expect(() => open(automaticBinding(moved))).toThrow("binding differs");
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionEnd before the first enrollment lock prevents a stale runtime snapshot from enrolling", async () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  const actualGit = Bun.which("git")!;
  Bun.spawnSync([actualGit, "init", "-q", repo]);
  f.db.query("INSERT INTO projection_projects VALUES ('project-1',?)").run(repo);
  f.db
    .query(
      "UPDATE orchestration_v2_projection_provider_threads SET updated_at='2026-09-30T22:00:00Z'",
    )
    .run();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const msg = (await req.json()) as any;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(msg.params.name === "list_agents" ? [] : { name: "BlueLake" }),
            },
          ],
        },
      });
    },
  });
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const reached = join(f.root, "reached");
  const released = join(f.root, "released");
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!${process.execPath}
import {writeFileSync,existsSync} from "node:fs";writeFileSync(${JSON.stringify(reached)}, "yes");while(!existsSync(${JSON.stringify(released)})){await Bun.sleep(10);}const p=Bun.spawn([${JSON.stringify(actualGit)},...process.argv.slice(2)],{stdout:"inherit",stderr:"inherit"});process.exit(await p.exited);
`,
  );
  chmodSync(wrapper, 0o700);
  const module = join(import.meta.dir, "../src/wake-auto-t3.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {enrollT3Threads} from ${JSON.stringify(module)};enrollT3Threads(${JSON.stringify(f.registry)},${JSON.stringify(join(f.root, ".t3"))},"2026-09-30T20:00:00Z",${JSON.stringify(`http://127.0.0.1:${server.port}/mcp/`)});`,
    ],
    { env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(reached)) {
      if (Date.now() > deadline) {
        throw new Error("git barrier not reached");
      }
      await Bun.sleep(10);
    }
    const { openRegistry } = await import("../src/registry.ts");
    openRegistry(dirname(f.state)).end("native-1", () => {}, new Date("2026-09-30T23:00:00Z"));
    f.db.query("UPDATE orchestration_v2_projection_provider_threads SET status='closed'").run();
    writeFileSync(released, "yes");
    expect(await child.exited).toBe(0);
    expect(JSON.parse(readFileSync(f.state, "utf8")).ended).toBe("2026-09-30T23:00:00.000Z");
    expect([...automaticT3Threads(f.registry, join(f.root, ".t3"))]).toEqual([]);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    await server.stop(true);
    f.close();
  }
});

test("explicit thread recovery requires the supervisor lock, preserves other failures and mailbox state, and refuses corrupt quarantine", async () => {
  const f = fixture();
  const stateRoot = join(f.root, "state");
  const config = {
    swarmailUrl: "http://127.0.0.1:1",
    target: { type: "t3-v2-queue", id: "t3-auto-wake" },
    rotation: { verifyBackend: true, baseDir: join(f.root, ".t3") },
    enrollAfter: "2099-01-01T00:00:00Z",
  };
  const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const key = createHash("sha256").update(`${config.swarmailUrl}\nt3-auto`).digest("hex");
  const ownerDir = join(stateRoot, "swarmail-auto-t3");
  mkdirSync(ownerDir, { recursive: true });
  const db = new Database(join(ownerDir, `${key}.sqlite`));
  db.exec(
    "CREATE TABLE state(id INTEGER PRIMARY KEY,binding TEXT,acknowledged INTEGER,pending TEXT); CREATE TABLE context(id INTEGER PRIMARY KEY,value TEXT);",
  );
  // Only the fields the binding reads; the supervisor never starts here.
  db.query("INSERT INTO state VALUES(1,?,0,NULL)").run(
    automaticBinding(config as unknown as Parameters<typeof automaticBinding>[0]),
  );
  const saved = JSON.stringify({ failures: { "thread-1": "rejected", "thread-2": "ambiguous" } });
  db.query("INSERT INTO context VALUES(1,?)").run(saved);
  const mailboxKey = createHash("sha256").update(`${config.swarmailUrl}\nthread-1`).digest("hex");
  const mailbox = join(stateRoot, "swarmail-bridge", `${mailboxKey}.sqlite`);
  mkdirSync(dirname(mailbox), { recursive: true });
  const journal = new Database(mailbox);
  journal.exec(
    "CREATE TABLE state(id INTEGER PRIMARY KEY,binding TEXT,acknowledged INTEGER,pending TEXT)",
  );
  journal
    .query("INSERT INTO state VALUES(1,?,4,?)")
    .run(
      JSON.stringify({ type: "t3-v2-queue", id: "thread-1" }),
      JSON.stringify({ eventId: 5, command: { type: "t3.notice", messageId: "original-message" } }),
    );
  journal.close();
  const originalMailbox = readFileSync(mailbox);
  const retry = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "wake-auto-t3",
        configPath,
        "--retry-thread",
        "thread-1",
      ],
      { env: { ...process.env, XDG_STATE_HOME: stateRoot }, stdout: "ignore", stderr: "pipe" },
    );
    const error = new Response(child.stderr).text();
    return { exit: await child.exited, error: await error };
  };
  const read = () =>
    db.query<{ value: string }, []>("SELECT value FROM context WHERE id=1").get()!.value;
  const lock = new Database(join(ownerDir, `${key}.lock.sqlite`));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    const blocked = await retry();
    expect(blocked.exit).toBe(1);
    expect(blocked.error).toContain("another wake bridge owns this mailbox session");
    expect(read()).toBe(saved);
    lock.exec("ROLLBACK");
    expect((await retry()).exit).toBe(0);
    expect(JSON.parse(read())).toMatchObject({
      running: false,
      failures: { "thread-2": "ambiguous" },
    });
    expect(JSON.parse(read()).failures).not.toHaveProperty("thread-1");
    expect(readFileSync(mailbox)).toEqual(originalMailbox);
    for (const corrupt of [
      null,
      [],
      "invalid",
      { failures: null },
      { failures: [] },
      { failures: { "thread-1": 1 } },
    ]) {
      const raw = JSON.stringify(corrupt);
      db.query("UPDATE context SET value=? WHERE id=1").run(raw);
      const rejected = await retry();
      expect(rejected.exit).toBe(1);
      expect(rejected.error).toMatch(
        /(?:saved wake context|automatic supervisor failure state) is invalid/,
      );
      expect(read()).toBe(raw);
    }
  } finally {
    lock.close();
    db.close();
    f.close();
  }
});

for (const timing of [
  "before reconciliation",
  "during sibling removal",
  "during own removal",
  "during shutdown",
]) {
  const duringRemoval = timing !== "before reconciliation";
  const shuttingDown = timing === "during shutdown";
  const ownRemoval = timing === "during own removal" || shuttingDown;
  test(`automatic supervisor quarantines a fatal thread ${timing} through eligibility orderings and restart while siblings keep delivering`, async () => {
    const f = fixture();
    const stateRoot = join(f.root, "state");
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    let fatalCommand: any = null;
    let pausedDelivery: ((receipt: object) => void) | undefined;
    let pauseDelivery = false;
    let stopBarrier: Resolve | undefined;
    const stopGate = join(f.root, "stop-gate");
    const healthyEvent = duringRemoval && !ownRemoval ? 2 : 1;
    const pausedThread = ownRemoval ? "thread-1" : "thread-2";
    const commands: any[] = [];
    const requests = new Set<string>();
    let authenticated = true;
    let refusedTickets = 0;
    const clock = join(f.root, "clock");
    writeFileSync(clock, String(Date.now()));
    const targetOptions = {
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request, server: Bun.Server<undefined>) {
        const path = new URL(request.url).pathname;
        requests.add(new URL(request.url).host + path);
        if (path === "/api/auth/session") {
          if (!authenticated) {
            return new Response("private-auth-body", { status: 403 });
          }
          return Response.json({
            authenticated: true,
            sessionMethod: "bearer-access-token",
            expiresAt,
            scopes: ["orchestration:operate"],
          });
        }
        if (path === "/ws") {
          return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
        }
        if (path === "/api/auth/websocket-ticket") {
          if (!authenticated) {
            refusedTickets++;
            return new Response("private-auth-body", { status: 403 });
          }
          return Response.json({ ticket: "fixture-ticket" });
        }
        if (path.endsWith("/thread-3")) {
          return Response.json({ private: "private-thread-body" });
        }
        const id = path.split("/").at(path.endsWith("/bounded") ? -2 : -1);
        return Response.json({
          projection: {
            thread: { id, settledAt: null, settledOverride: null },
            runs: [],
            messages: [],
            runtimeRequests: [],
          },
        });
      },
      websocket: {
        message(ws: Bun.ServerWebSocket<undefined>, raw: string | Buffer) {
          const frame = JSON.parse(String(raw));
          if (frame._tag !== "Request") {
            return;
          }
          const command = frame.payload;
          commands.push(command);
          const reply = (receipt: object) =>
            ws.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: frame.id,
                exit: { _tag: "Success", value: receipt },
              }),
            );
          if (command.threadId === "thread-1") {
            fatalCommand = command;
          }
          if (pauseDelivery && command.threadId === pausedThread) {
            pausedDelivery = reply;
            return;
          }
          reply(command.threadId === "thread-1" ? {} : { sequence: 1 });
        },
      },
    };
    const target = Bun.serve(targetOptions);
    let movedTarget: Bun.Server<undefined> | undefined;
    const waiting = new Map<string | null, Resolve>();
    let scanBarrier: Resolve | undefined;
    const offer = (eventId = 1) =>
      new Response("Swarmail: 1 new message. Call fetch_inbox.", {
        headers: { "x-swarmail-event-id": String(eventId) },
      });
    const mail = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/lifecycle/reconcile") {
          return Response.json({ status: "ready", changed: 0 });
        }
        if (path === "/wait/status") {
          return Response.json({ eligible: true });
        }
        if (path === "/wait/peek") {
          const session = new URL(request.url).searchParams.get("session");
          return Response.json({
            mailboxes: [{ recipient: `AutoReceiver-${session}`, project: "/w/auto" }],
          });
        }
        if (new URL(request.url).pathname === "/stop") {
          return new Promise<Response>((resolve) => {
            stopBarrier = resolve;
          });
        }
        if (new URL(request.url).pathname === "/scan") {
          return new Promise<Response>((resolve) => {
            scanBarrier = resolve;
          });
        }
        const id = new URL(request.url).searchParams.get("session");
        return new Promise<Response>((resolve) => {
          const finish = (response: Response) => {
            if (waiting.get(id) === finish) {
              waiting.delete(id);
            }
            resolve(response);
          };
          waiting.set(id, finish);
          request.signal.addEventListener(
            "abort",
            () => {
              finish(new Response(null, { status: 204 }));
            },
            { once: true },
          );
        });
      },
    });
    const configPath = join(f.root, "config.json");
    const config = {
      swarmailUrl: `http://127.0.0.1:${mail.port}`,
      target: {
        type: "t3-v2-queue",
        url: `http://127.0.0.1:${target.port}`,
        id: "t3-auto-wake",
        authorizationFile: join(f.root, "authorization"),
      },
      rotation: {
        verifyBackend: true,
        baseDir: join(f.root, ".t3"),
        executable: process.execPath,
        version: "0.0.45-nightly.20260930.2481",
      },
      enrollAfter: "2099-01-01T00:00:00Z",
    };
    const ownerKey = createHash("sha256").update(`${config.swarmailUrl}\nt3-auto`).digest("hex");
    const ownerPath = join(stateRoot, "swarmail-auto-t3", ownerKey + ".sqlite");
    const status = () => {
      if (!existsSync(ownerPath)) {
        return null;
      }
      const db = new Database(ownerPath, { readonly: true });
      try {
        return JSON.parse(
          db.query<{ value: string }, []>("SELECT value FROM context WHERE id=1").get()?.value ??
            "null",
        );
      } catch {
        return null;
      } finally {
        db.close();
      }
    };
    const stopped = (id: string) => {
      const key = createHash("sha256").update(`${config.swarmailUrl}\n${id}`).digest("hex");
      const db = new Database(join(stateRoot, "swarmail-bridge", key + ".lock.sqlite"));
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK");
        return true;
      } catch {
        return false;
      } finally {
        db.close();
      }
    };
    const journal = (id: string) => {
      const key = createHash("sha256").update(`${config.swarmailUrl}\n${id}`).digest("hex");
      const db = new Database(join(stateRoot, "swarmail-bridge", key + ".sqlite"), {
        readonly: true,
      });
      try {
        return db.query("SELECT * FROM state WHERE id=1").get() as any;
      } finally {
        db.close();
      }
    };
    addT3V2Thread(f.db, { threadId: "thread-2", nativeId: "native-2", updatedAt: "2026-09-30" });
    for (const index of [1, 2]) {
      writeFileSync(
        join(f.registry, `native-${index}.json`),
        JSON.stringify({
          name: `AutoReceiver${index}`,
          projects: ["/w/auto"],
          wakeThread: `thread-${index}`,
          tags: { "/w/auto": `[t3:thread-${index} codex:native-${index} cwd:/w/auto]` },
        }),
      );
    }
    writeFileSync(configPath, JSON.stringify(config));
    let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
    let errors: Promise<string>;
    const launch = () =>
      Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "fixtures/t3-auto-cli-preload.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          "wake-auto-t3",
          configPath,
        ],
        {
          env: {
            ...process.env,
            XDG_STATE_HOME: stateRoot,
            AUTO_TEST_EXPIRES: expiresAt,
            AUTO_TEST_SCAN_URL: `http://127.0.0.1:${mail.port}/scan`,
            AUTO_TEST_NOW_FILE: clock,
            AUTO_TEST_STOP_GATE: stopGate,
            AUTO_TEST_STOP_URL: `http://127.0.0.1:${mail.port}/stop`,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
    child = launch();
    errors = new Response(child.stderr).text();
    const until = async (predicate: () => unknown) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (child.exitCode !== null) {
          throw new Error(`supervisor exited ${child.exitCode}: ${await errors}`);
        }
        if (Date.now() > deadline) {
          throw new Error("supervisor lifecycle condition timed out");
        }
        await Bun.sleep(20);
      }
    };
    const scan = async () => {
      await until(() => scanBarrier);
      const release = scanBarrier;
      scanBarrier = undefined;
      release!(new Response());
      await until(() => scanBarrier);
    };
    try {
      await until(
        () => Object.keys(status()?.subscriptions ?? {}).length === 2 && waiting.size === 2,
      );
      // Bridges run inside the supervisor, so every subscription names it.
      expect(Object.values(status().subscriptions)).toEqual([status().owner, status().owner]);
      expect(hostAlive(status().owner)).toBe(true);
      const observer = new Database(ownerPath, { readonly: true });
      expect(observer.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      observer.exec("BEGIN");
      const observed = observer
        .query<{ value: string }, []>("SELECT value FROM context WHERE id=1")
        .get()!.value;
      try {
        archiveT3(f.db, "archived", "thread-1");
        await scan();
        await until(() => Object.keys(status()?.subscriptions ?? {}).length === 1);
        await until(() => !waiting.has("thread-1")); // The removed bridge stopped polling.
        expect(
          observer.query<{ value: string }, []>("SELECT value FROM context WHERE id=1").get()!
            .value,
        ).toBe(observed);
      } finally {
        observer.exec("ROLLBACK");
        observer.close();
      }
      expect(journal("thread-1").acknowledged).toBe(0);
      archiveT3(f.db, null, "thread-1");
      await scan();
      await until(
        () => Object.keys(status()?.subscriptions ?? {}).length === 2 && waiting.has("thread-1"),
      );
      const receipts = Object.values(status().subscriptions) as HostProcess[];
      if (duringRemoval) {
        // Stop the healthy bridge first; the sibling fails while that stop is awaiting delivery.
        pauseDelivery = true;
        waiting.get(pausedThread)!(offer());
        await until(() => pausedDelivery);
        writeFileSync(stopGate, "1");
        archiveT3(f.db, "archived", ownRemoval ? "thread-1" : undefined);
        await until(() => scanBarrier);
        if (shuttingDown) {
          child.kill("SIGTERM");
        }
        scanBarrier!(new Response());
        scanBarrier = undefined;
        await until(() => stopBarrier);
        expect(stopped(pausedThread)).toBe(false);
        if (shuttingDown) {
          await until(() => stopped("thread-2"));
        }
        if (!ownRemoval) {
          waiting.get("thread-1")!(offer());
          await until(() => fatalCommand && stopped("thread-1"));
        }
        pauseDelivery = false;
        rmSync(stopGate);
        pausedDelivery!(ownRemoval ? {} : { sequence: 1 });
        pausedDelivery = undefined;
        if (shuttingDown) {
          expect(await child.exited).toBe(0);
          expect(status().failures["thread-1"]).toBe("T3 returned no command admission receipt");
          await errors;
        } else {
          await until(() => scanBarrier);
        }
        stopBarrier!(new Response());
        stopBarrier = undefined;
        archiveT3(f.db, null);
        if (shuttingDown) {
          child = launch();
          errors = new Response(child.stderr).text();
        }
        await scan();
      } else {
        waiting.get("thread-1")!(offer());
        await until(() => fatalCommand);
        await scan();
      }
      await until(() => !waiting.has("thread-1"));
      expect(child.exitCode).toBeNull();
      if (!shuttingDown) {
        expect(receipts.every((receipt) => hostAlive(receipt))).toBe(true);
      }
      expect(status()).toMatchObject({
        running: true,
        failures: { "thread-1": "T3 returned no command admission receipt" },
      });
      expect(Object.keys(status().subscriptions)).toEqual(["thread-2"]);
      const saved = journal("thread-1");
      expect(saved.acknowledged).toBe(0);
      expect(JSON.parse(saved.pending)).toMatchObject({
        eventId: 1,
        command: { type: "t3.notice", operation: { commandId: fatalCommand.commandId } },
      });
      // A restarted bridge publishes its subscription before asynchronous retry acceptance.
      await until(() => journal("thread-2").acknowledged === healthyEvent - 1);
      expect(journal("thread-2").acknowledged).toBe(healthyEvent - 1);
      const originalPending = saved.pending;
      // Enumerate eligibility changes and scans at the real supervisor boundary.
      const events = ["archive", "settle", "resume", "scan"];
      const visit = async (sequence: string[] = []) => {
        if (sequence.length === 3) {
          return;
        }
        for (const event of events) {
          const next = [...sequence, event];
          const before = f.db
            .query<{ archived_at: string | null; settled_override: string | null }, []>(
              "SELECT archived_at, json_extract(payload_json,'$.settledOverride') AS settled_override FROM orchestration_v2_projection_threads WHERE thread_id='thread-1'",
            )
            .get()!;
          if (event !== "scan") {
            archiveT3(f.db, event === "archive" ? "archived" : null, "thread-1");
            settleT3(f.db, event === "settle" ? "settled" : null, "thread-1");
          }
          await scan();
          expect(Object.keys(status().subscriptions), next.join(" -> ")).toEqual(["thread-2"]);
          expect(journal("thread-1").pending, next.join(" -> ")).toBe(originalPending);
          expect(
            commands.filter((command) => command.threadId === "thread-1"),
            next.join(" -> "),
          ).toHaveLength(1);
          await visit(next);
          archiveT3(f.db, before.archived_at, "thread-1");
          settleT3(f.db, before.settled_override, "thread-1");
          await scan();
        }
      };
      await visit();
      // Port discovery restarts only healthy bridges; a failed journal stays quarantined.
      movedTarget = Bun.serve(targetOptions);
      writeFileSync(
        join(f.root, ".t3/userdata/server-runtime.json"),
        JSON.stringify({ version: 1, pid: process.pid, port: movedTarget.port }),
      );
      await scan();
      expect(requests.has(`127.0.0.1:${movedTarget.port}/api/orchestration/threads/thread-2`)).toBe(
        true,
      );
      expect(requests.has(`127.0.0.1:${movedTarget.port}/api/orchestration/threads/thread-1`)).toBe(
        false,
      );
      expect(journal("thread-1").pending).toBe(originalPending);
      waiting.get("thread-2")!(offer(healthyEvent));
      await until(() => journal("thread-2").acknowledged === healthyEvent);
      // Restart cannot silently retry a permanently failed thread.
      child.kill("SIGTERM");
      scanBarrier!(new Response());
      scanBarrier = undefined;
      expect(await child.exited).toBe(0);
      if (!shuttingDown) {
        expect(await errors).toContain("bridge thread-1 quarantined");
      }
      archiveT3(f.db, null, "thread-1");
      child = launch();
      errors = new Response(child.stderr).text();
      await until(() => scanBarrier);
      expect(Object.keys(status().subscriptions)).toEqual(["thread-2"]);
      expect(journal("thread-1").pending).toBe(originalPending);
      expect(commands.filter((command) => command.threadId === "thread-1")).toHaveLength(1);
      // A thread-local protocol/preflight failure does not stop a healthy sibling.
      addT3V2Thread(f.db, { threadId: "thread-3", nativeId: "native-3", updatedAt: "2026-09-30" });
      writeFileSync(
        join(f.registry, "native-3.json"),
        JSON.stringify({
          name: "AutoReceiver3",
          projects: ["/w/auto"],
          wakeThread: "thread-3",
          tags: { "/w/auto": "[t3:thread-3 codex:native-3 cwd:/w/auto]" },
        }),
      );
      await scan();
      expect(status().failures["thread-3"]).toContain("preflight failed");
      expect(Object.keys(status().subscriptions)).toEqual(["thread-2"]);
      // Shared authentication failure during the cached minute is global, not thread quarantine.
      authenticated = false;
      addT3V2Thread(f.db, { threadId: "thread-4", nativeId: "native-4", updatedAt: "2026-09-30" });
      writeFileSync(
        join(f.registry, "native-4.json"),
        JSON.stringify({
          name: "AutoReceiver4",
          projects: ["/w/auto"],
          wakeThread: "thread-4",
          tags: { "/w/auto": "[t3:thread-4 codex:native-4 cwd:/w/auto]" },
        }),
      );
      scanBarrier!(new Response());
      scanBarrier = undefined;
      await until(() => child.exitCode !== null || status()?.failures?.["thread-4"]);
      expect(status().failures).not.toHaveProperty("thread-4");
      expect(await child.exited).toBe(1);
      expect(await errors).not.toContain("private-auth-body");
      expect(await errors).not.toContain("private-thread-body");
      expect(status()).toMatchObject({
        running: false,
        subscriptions: {},
        failures: { "thread-1": "T3 returned no command admission receipt" },
      });
      expect(journal("thread-1").pending).toBe(originalPending);
      expect(journal("thread-2").acknowledged).toBe(healthyEvent);
      // The same shared failure during delivery is global and leaves the saved offer pending.
      authenticated = true;
      child = launch();
      errors = new Response(child.stderr).text();
      await until(() => scanBarrier && waiting.has("thread-2"));
      authenticated = false;
      waiting.get("thread-2")!(offer(healthyEvent + 1));
      await until(() => refusedTickets === 1 && stopped("thread-2"));
      scanBarrier!(new Response());
      scanBarrier = undefined;
      await until(() => child.exitCode !== null || status()?.failures?.["thread-2"]);
      expect(status().failures).not.toHaveProperty("thread-2");
      expect(await child.exited).toBe(1);
      expect(await errors).not.toContain("private-auth-body");
      expect(journal("thread-2").acknowledged).toBe(healthyEvent);
      expect(JSON.parse(journal("thread-2").pending)).toMatchObject({ eventId: healthyEvent + 1 });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      pausedDelivery?.({ sequence: 1 });
      stopBarrier?.(new Response());
      scanBarrier?.(new Response());
      await child.exited;
      await errors;
      for (const resolve of waiting.values()) {
        resolve(new Response(null, { status: 204 }));
      }
      await mail.stop(true);
      await target.stop(true);
      await movedTarget?.stop(true);
      f.close();
    }
  }, 20000);
}

test("automatic supervisor waits out a T3 restart and follows its new port", async () => {
  const f = fixture();
  const stateRoot = join(f.root, "state");
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const seen = new Set();
  let stalledSession = false;
  const t3 = (stall = false) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.add(`${this.port} ${path}`);
        if (path === "/api/auth/session") {
          if (stall) {
            stalledSession = true;
            return new Promise((resolve) => {
              request.signal.addEventListener(
                "abort",
                () => resolve(new Response(null, { status: 204 })),
                { once: true },
              );
            });
          }
          return Response.json({
            authenticated: true,
            sessionMethod: "bearer-access-token",
            expiresAt,
            scopes: ["orchestration:operate"],
          });
        }
        const id = path.split("/").at(path.endsWith("/bounded") ? -2 : -1);
        return Response.json({
          projection: {
            thread: { id, settledAt: null, settledOverride: null },
            runs: [],
            messages: [],
            runtimeRequests: [],
          },
        });
      },
    });
  const waiting = new Set();
  const mail = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/lifecycle/reconcile") {
        return Response.json({ status: "ready", changed: 0 });
      }
      if (path === "/wait/status") {
        return Response.json({ eligible: true });
      }
      const id = new URL(request.url).searchParams.get("session");
      waiting.add(id);
      return new Promise((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            waiting.delete(id);
            resolve(new Response(null, { status: 204 }));
          },
          { once: true },
        );
      });
    },
  });
  const baseDir = join(f.root, ".t3");
  const config = {
    swarmailUrl: `http://127.0.0.1:${mail.port}`,
    target: { type: "t3-v2-queue", id: "t3-auto-wake", authorizationFile: join(f.root, "auth") },
    rotation: {
      verifyBackend: true,
      baseDir,
      executable: process.execPath,
      version: "0.0.45-nightly.20260930.2481",
    },
    enrollAfter: "2099-01-01T00:00:00Z",
  };
  // Credential state saved before discovery recorded the port; it must still match.
  const rotation = config.target.authorizationFile + ".rotation";
  mkdirSync(rotation, { mode: 0o700 });
  writeFileSync(
    join(rotation, "state.json"),
    JSON.stringify({
      binding: JSON.stringify({
        url: "http://127.0.0.1:1",
        executable: realpathSync(process.execPath),
        baseDir: realpathSync(baseDir),
        version: config.rotation.version,
        type: config.target.type,
        id: config.target.id,
        headerPath: config.target.authorizationFile,
      }),
      retired: [],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(f.registry, "native-1.json"),
    JSON.stringify({
      name: "PortReceiver",
      projects: ["/w/auto"],
      wakeThread: "thread-1",
      tags: { "/w/auto": "[t3:thread-1 codex:native-1 cwd:/w/auto]" },
    }),
  );
  const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const publish = (server: Bun.Server<undefined>) =>
    writeFileSync(
      join(baseDir, "userdata/server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port: server.port }),
    );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "fixtures/t3-auto-cli-preload.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      "wake-auto-t3",
      configPath,
    ],
    {
      env: { ...process.env, XDG_STATE_HOME: stateRoot, AUTO_TEST_EXPIRES: expiresAt },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  const until = async (predicate: () => unknown) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (child.exitCode !== null) {
        throw new Error(`supervisor exited ${child.exitCode}: ${await errors}`);
      }
      if (Date.now() > deadline) {
        throw new Error("port-follow condition timed out");
      }
      await Bun.sleep(20);
    }
  };
  const first = t3();
  let second: Bun.Server<undefined> | undefined;
  let stalled: Bun.Server<undefined> | undefined;
  try {
    await Bun.sleep(2500); // No runtime file and no configured URL: T3 is down, not changed.
    expect(child.exitCode).toBeNull();
    publish(first);
    await until(() => waiting.has("thread-1"));
    expect(seen.has(`${first.port} /api/orchestration/threads/thread-1`)).toBe(true);
    second = t3();
    publish(second);
    await first.stop(true);
    await until(
      () => seen.has(`${second!.port} /api/orchestration/threads/thread-1`) && waiting.size === 1,
    );
    expect(seen.has(`${second.port} /api/auth/session`)).toBe(true);
    const ownedPaths = [config.target.authorizationFile, join(rotation, "state.json"), f.state];
    const ownedBefore = ownedPaths.map((path) => readFileSync(path));
    stalled = t3(true);
    publish(stalled);
    await until(() => stalledSession);
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      child.exited,
      Bun.sleep(3000).then(() => {
        throw new Error("in-flight backend shutdown timed out");
      }),
    ]);
    expect(stopped).toBe(0);
    expect(ownedPaths.map((path) => readFileSync(path))).toEqual(ownedBefore);
    expect(await errors).not.toContain("T3 backend check cancelled");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await child.exited;
    await errors;
    await mail.stop(true);
    await first.stop(true);
    await second?.stop(true);
    await stalled?.stop(true);
    f.close();
  }
  expect(await errors).toContain(
    "T3 backend unavailable; waiting within the existing grace budget",
  );
}, 30000);

test("automatic scans repeat only after a T3 commit, a registry write, a reopen or the rescan interval", () => {
  const f = fixture();
  const t3 = heldT3State(join(f.root, ".t3"));
  let now = 0;
  try {
    const due = rescanDue(t3, f.registry, () => now);
    expect(due()).toBe(true);
    expect(due()).toBe(false);
    f.db
      .query("UPDATE orchestration_v2_projection_provider_threads SET updated_at='2026-10-01'")
      .run();
    expect(due()).toBe(true);
    expect(due()).toBe(false);
    Bun.sleepSync(25); // Past the file system's timestamp granularity.
    writeFileSync(f.state + ".tmp", "{}\n");
    renameSync(f.state + ".tmp", f.state);
    expect(due()).toBe(true);
    expect(due()).toBe(false);
    t3.close();
    expect(due()).toBe(true);
    now = 59_999;
    expect(due()).toBe(false);
    now = 60_000;
    expect(due()).toBe(true);
  } finally {
    t3.close();
    f.close();
  }
});

const HOLD_REASONS: Record<string, string> = {
  unavailable: "core reported unavailable",
  malformed: "unexpected response",
  missing: "HTTP 404",
};
for (const initial of ["unavailable", "malformed", "missing"]) {
  test(`lifecycle ${initial} holds automatic startup before credentials, then a ready core resumes the same supervisor`, async () => {
    const f = fixture();
    const core = createServer(join(f.root, "mail.sqlite"), 0);
    let mode = initial,
      stopping = false,
      releaseScan: Resolve | undefined;
    let targetReads = 0;
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        targetReads++;
        return Response.json({
          authenticated: true,
          sessionMethod: "bearer-access-token",
          expiresAt,
          scopes: ["orchestration:operate"],
        });
      },
    });
    const requests: { method: string; body: string }[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/scan") {
          return stopping
            ? new Response()
            : new Promise<Response>((resolve) => {
                releaseScan = resolve;
              });
        }
        if (url.pathname === "/lifecycle/reconcile") {
          requests.push({ method: req.method, body: await req.text() });
          if (mode === "unavailable") {
            return Response.json({ status: "unavailable", changed: 0 });
          }
          if (mode === "malformed") {
            return new Response("private-response-fixture");
          }
          if (mode === "missing") {
            return new Response("private-response-fixture", { status: 404 });
          }
        }
        return fetch(new URL(url.pathname + url.search, `http://127.0.0.1:${core.server.port}`), {
          method: req.method,
        });
      },
    });
    const header = join(f.root, "authorization");
    const config = join(f.root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        swarmailUrl: `http://127.0.0.1:${proxy.port}`,
        target: {
          type: "t3-v2-queue",
          url: `http://127.0.0.1:${target.port}`,
          authorizationFile: header,
        },
        rotation: {
          baseDir: join(f.root, ".t3"),
          verifyBackend: true,
          executable: process.execPath,
          version: "0.0.45-nightly.20260930.2481",
        },
        enrollAfter: "2099-01-01T00:00:00Z",
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures/t3-auto-cli-preload.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "wake-auto-t3",
        config,
      ],
      {
        env: {
          ...process.env,
          XDG_STATE_HOME: join(f.root, "state"),
          AUTO_TEST_SCAN_URL: `http://127.0.0.1:${proxy.port}/scan`,
          AUTO_TEST_EXPIRES: expiresAt,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const errors = new Response(child.stderr).text();
    const until = async (fn: () => unknown) => {
      const deadline = Date.now() + 8000;
      while (!fn()) {
        if (child.exitCode !== null) {
          throw new Error(`supervisor exited: ${await errors}`);
        }
        if (Date.now() > deadline) {
          throw new Error("lifecycle startup barrier timed out");
        }
        await Bun.sleep(10);
      }
    };
    try {
      await until(() => releaseScan);
      expect(targetReads).toBe(0);
      expect(existsSync(header)).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(requests).toEqual([{ method: "POST", body: "" }]);
      mode = "ready";
      const resume = releaseScan;
      releaseScan = undefined;
      resume!(new Response());
      await until(() => releaseScan && targetReads > 0);
      expect(existsSync(header)).toBe(true);
      expect(requests).toHaveLength(2);
    } finally {
      stopping = true;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      releaseScan?.(new Response());
      await child.exited;
      await proxy.stop(true);
      await target.stop(true);
      await core.server.stop(true);
      core.db.close();
      f.close();
    }
    expect(await errors).toContain(
      `lifecycle reconciliation unavailable; holding scan (${HOLD_REASONS[initial]})`,
    );
    expect(await errors).toMatch(/lifecycle reconciliation ready; scan resumed after \d+ s/);
    expect(await errors).not.toContain("private-response-fixture");
  });
}

test("scan orderings reconcile verified closure and recovery while the T3 backend is unavailable", async () => {
  const f = fixture();
  const sourcePath = join(f.root, ".t3/userdata/statev2.sqlite");
  const source = f.db;
  addT3V2Thread(source, { threadId: "thread-one", nativeId: "native-one" });
  source.exec(`CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT PRIMARY KEY,schema_version INTEGER,last_sequence INTEGER);
    INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,1);
    CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE);
    INSERT INTO orchestration_events VALUES(1,'event-1');`);
  source
    .query(
      "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledAt',NULL,'$.settledOverride',NULL)",
    )
    .run();
  const core = createServer(join(f.root, "mail.sqlite"), 0, {
    t3Lifecycle: {
      profile: "fixture",
      databasePath: sourcePath,
      eventTable: "orchestration_events",
    },
  });
  const tools = createTools(core.db, { databasePath: join(f.root, "mail.sqlite") });
  tools.register_agent!({
    project_key: f.root,
    name: "GreenCastle",
    program: "codex",
    model: "test",
    task_description: "[t3:thread-one codex:native-one]",
  });
  tools.register_agent!({ project_key: f.root, name: "BlueLake", program: "test", model: "test" });
  tools.send_message!({
    project_key: f.root,
    sender_name: "BlueLake",
    to: ["GreenCastle"],
    subject: "retained",
    body_md: "history",
  });
  let releaseScan: Resolve | undefined,
    stopping = false,
    requests = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/scan") {
        return stopping
          ? new Response()
          : new Promise((resolve) => {
              releaseScan = resolve;
            });
      }
      expect(url.pathname).toBe("/lifecycle/reconcile");
      expect(req.method).toBe("POST");
      expect(await req.text()).toBe("");
      requests++;
      return fetch(new URL(url.pathname, `http://127.0.0.1:${core.server.port}`), {
        method: "POST",
      });
    },
  });
  const config = join(f.root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      swarmailUrl: `http://127.0.0.1:${proxy.port}`,
      target: { type: "t3-v2-queue", authorizationFile: join(f.root, "authorization") },
      rotation: {
        baseDir: join(f.root, ".t3"),
        verifyBackend: true,
        executable: process.execPath,
        version: "0.0.45-nightly.20260930.2481",
      },
      enrollAfter: "2099-01-01T00:00:00Z",
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "fixtures/t3-auto-cli-preload.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      "wake-auto-t3",
      config,
    ],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(f.root, "state"),
        AUTO_TEST_SCAN_URL: `http://127.0.0.1:${proxy.port}/scan`,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  const until = async () => {
    const deadline = Date.now() + 5000;
    while (!releaseScan) {
      if (child.exitCode !== null) {
        throw new Error(`supervisor exited: ${await errors}`);
      }
      if (Date.now() > deadline) {
        throw new Error("source reconciliation barrier timed out");
      }
      await Bun.sleep(10);
    }
  };
  const scan = async () => {
    const resume = releaseScan;
    releaseScan = undefined;
    resume!(new Response());
    await until();
  };
  const roster = () =>
    (tools.list_agents!({ project_key: f.root }) as { name: string }[]).some(
      (agent) => agent.name === "GreenCastle",
    );
  let revision = 1;
  const transition = (state: string) => {
    revision++;
    source
      .query("INSERT INTO orchestration_events VALUES (?,?)")
      .run(revision, `event-${revision}`);
    source.query("UPDATE orchestration_v2_projection_metadata SET last_sequence=?").run(revision);
    source
      .query(
        "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledOverride',?)",
      )
      .run(state === "closed" ? "settled" : null);
  };
  try {
    await until();
    expect(roster()).toBe(true);
    const events = ["close", "open", "source-failure", "recover"];
    let sequences = 0;
    for (const [first, second] of events.flatMap((first) =>
      events.map((second) => [first, second]),
    )) {
      source.query("UPDATE orchestration_v2_projection_metadata SET schema_version=2").run();
      transition("active");
      await scan();
      let verifiedActive = true,
        sourceReady = true,
        intendedActive = true;
      for (const event of [first, second]) {
        if (event === "close" || event === "open") {
          intendedActive = event === "open";
          transition(intendedActive ? "active" : "closed");
        } else {
          sourceReady = event === "recover";
          source
            .query("UPDATE orchestration_v2_projection_metadata SET schema_version=?")
            .run(sourceReady ? 2 : 99);
        }
        await scan();
        if (sourceReady) {
          verifiedActive = intendedActive;
        }
        expect(roster(), `${first} -> ${second}`).toBe(verifiedActive);
        expect(
          core.db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n,
        ).toBe(1);
      }
      sequences++;
    }
    expect(sequences).toBe(16);
    expect(requests).toBe(49);
    expect(child.exitCode).toBeNull();
  } finally {
    stopping = true;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    releaseScan?.(new Response());
    await child.exited;
    await proxy.stop(true);
    await core.server.stop(true);
    core.db.close();
    f.close();
  }
  expect(await errors).toContain(
    "T3 backend unavailable; waiting within the existing grace budget",
  );
});
