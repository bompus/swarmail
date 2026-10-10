import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { parseTag } from "../src/tag.ts";
import { resolveProject, whoRows } from "../src/who.ts";

test("reads the session tag", () => {
  expect(parseTag("[t3:c86a claude:a5ff build:0439 cwd:~/w/x] TLA+ pilot")).toEqual({
    t3: "c86a",
    host: "claude",
    sessionId: "a5ff",
    build: "0439",
    cwd: "~/w/x",
  });
  expect(parseTag("[codex:s1 cwd:~/project folder/with  spaces ] task")?.cwd).toBe(
    "~/project folder/with  spaces ",
  );
  expect(parseTag("[opencode] task")).toMatchObject({ host: "opencode", sessionId: null });
  expect(parseTag("Claude Code session c583830b (registered on first edit)")).toBeNull();
});

test("ranks running sessions first and links untagged rows through the hook's state", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(
      join(stateDir, "c583.json"),
      JSON.stringify({
        name: "TanOwl",
        projects: ["/r"],
        host: { name: "claude", pid: 7, start: "1" },
      }),
    );
    const threads = new Map([
      [
        "room",
        {
          thread_id: "room",
          title: "Resume War Room",
          cwd: "/w/room",
          status: "running",
          last_seen_at: "2026-09-27T03:30:00Z",
        },
      ],
      [
        "idle",
        {
          thread_id: "idle",
          title: "Old task",
          cwd: "/w/idle",
          status: "stopped",
          last_seen_at: "2026-09-26T18:00:00Z",
        },
      ],
      [
        "lost",
        {
          thread_id: "lost",
          title: "Absent from visible roster",
          cwd: "/w/lost",
          status: "running",
          last_seen_at: "2026-09-27T03:00:00Z",
        },
      ],
    ]);
    const roster = [
      {
        name: "WindyOriole",
        task_description: "[t3:idle claude:s1 cwd:~/w/idle] registered on first edit",
        last_active_ts: "2026-09-27T01:00:00Z",
      },
      {
        name: "TanOwl",
        task_description: "Claude Code session c583 (registered on first edit)",
        last_active_ts: "2026-09-26T05:47:00Z",
      },
      {
        name: "WildDeer",
        task_description: "[claude:s1 cwd:~/w] registered on first edit",
        last_active_ts: "2026-09-27T03:04:00Z",
      },
    ];
    const t3For = { c583: "room" };
    const rows = whoRows(
      {
        project: "/r",
        roster,
        stateDir,
        threads,
        room: { agentName: "TanOwl" },
        checkout: () => "/r",
      },
      (id) => t3For[id] ?? null,
      (host) => host.pid === 7,
    );
    expect(rows.map((row) => row.name)).toEqual(["TanOwl", null, "WildDeer", "WindyOriole"]);
    expect(rows[0]).toMatchObject({
      sessionId: "c583",
      title: "Resume War Room",
      roomOwner: true,
      hostAlive: true,
      lastActive: "2026-09-26T05:47:00Z",
    });
    expect(rows.find((row) => row.name === "WildDeer").hostAlive).toBeNull();
    expect(rows[1]).toMatchObject({
      t3: "lost",
      task: "not in visible roster; registration and delivery unknown",
    });
    expect(rows.find((row) => row.name === "WildDeer").sameSessionAs).toEqual(["WindyOriole"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("links a roster row through the name the session holds in that project", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-names-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(
      join(stateDir, "c583.json"),
      JSON.stringify({
        name: "TanOwl",
        names: { "/b": "BlueHarbor" },
        projects: ["/a", "/b"],
        host: { name: "claude", pid: 7, start: "1" },
      }),
    );
    const roster = (name) => [
      { name, task_description: "registered by hook", last_active_ts: "2026-09-26T05:47:00Z" },
    ];
    const rowsIn = (project, name) =>
      whoRows(
        {
          project,
          roster: roster(name),
          stateDir,
          threads: new Map(),
          room: null,
          checkout: () => project,
        },
        () => null,
        () => true,
      );
    expect(rowsIn("/a", "TanOwl")[0].sessionId).toBe("c583");
    expect(rowsIn("/b", "BlueHarbor")[0].sessionId).toBe("c583");
    // The headline name is not this session's name in a project that holds a different one.
    expect(rowsIn("/b", "TanOwl")[0].sessionId).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ended session ranks below a live one even while its host process lingers", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const host = { name: "claude", pid: 7, start: "1" };
    writeFileSync(
      join(stateDir, "gone.json"),
      JSON.stringify({ name: "OldFern", projects: ["/r"], host, ended: "2026-09-28T20:00:00Z" }),
    );
    writeFileSync(
      join(stateDir, "live.json"),
      JSON.stringify({ name: "NewFern", projects: ["/r"], host }),
    );
    const roster = [
      {
        name: "OldFern",
        task_description: "[claude:gone] a",
        last_active_ts: "2026-09-28T20:00:00Z",
      },
      {
        name: "NewFern",
        task_description: "[claude:live] b",
        last_active_ts: "2026-09-28T10:00:00Z",
      },
    ];
    const rows = whoRows(
      { project: "/r", roster, stateDir, threads: new Map(), room: null },
      () => null,
      () => true,
    );
    expect(rows.map((row) => [row.name, row.ended])).toEqual([
      ["NewFern", null],
      ["OldFern", "2026-09-28T20:00:00Z"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves a bare repository name to the one project with that folder name", () => {
  const keys = ["/home/u/toolbox", "/home/u/espn", "/srv/espn"];
  const noRepo = () => null;
  expect(resolveProject("toolbox", keys, noRepo)).toBe("/home/u/toolbox");
  expect(resolveProject("/home/u/w/x", keys, () => "/home/u/x")).toBe("/home/u/x");
  expect(() => resolveProject("espn", keys, noRepo)).toThrow(
    "espn matches several projects; candidates: /home/u/espn, /srv/espn",
  );
  expect(() => resolveProject("nope", keys, noRepo)).toThrow(
    "nope matches no project; candidates: espn, toolbox",
  );
  expect(() => resolveProject("./nope", keys, noRepo)).toThrow("is not inside a git repository");
});

test("who keeps edit location separate from the launch directory and T3 title", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-location-"));
  try {
    const label = { repo: "repo", worktree: "/w/edit", branch: "feature", title: "Edit task" };
    writeFileSync(
      join(dir, "s.json"),
      JSON.stringify({ name: "BlueBranch", projects: ["/r"], worktrees: { "/r": "/w/older" } }),
    );
    const context = {
      project: "/r",
      stateDir: dir,
      roster: [
        {
          name: "BlueBranch",
          task_description: "[t3:th claude:s cwd:/launch] task",
          location: label,
        },
      ],
      threads: new Map([
        [
          "th",
          {
            thread_id: "th",
            title: "Edit task",
            cwd: "/launch",
            status: "running",
            last_seen_at: null,
          },
        ],
      ]),
      room: null,
    };
    const [row] = whoRows(
      context,
      () => null,
      () => false,
    );
    expect(row.location).toEqual(label);
    expect(row.cwd).toBe("/launch");
    expect(row.title).toBe("Edit task");
    context.roster[0].location = null;
    expect(
      whoRows(
        context,
        () => null,
        () => false,
      )[0].location,
    ).toBeNull();
    delete context.roster[0].location;
    expect(
      whoRows(
        context,
        () => null,
        () => false,
      )[0].location,
    ).toEqual({
      repo: "r",
      worktree: "/w/older",
      branch: null,
      title: "Edit task",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("who resolves native and hook-state titles while preserving T3 precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-native-"));
  const previousHome = process.env.HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.HOME = dir;
  process.env.CODEX_HOME = join(dir, ".codex");
  try {
    mkdirSync(process.env.CODEX_HOME);
    writeFileSync(
      join(process.env.CODEX_HOME, "session_index.jsonl"),
      [
        { id: "native", thread_name: "Native task" },
        { id: "hook", thread_name: "Hook task" },
        { id: "t3-native", thread_name: "Provider name" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(
      join(stateDir, "hook.json"),
      JSON.stringify({
        name: "HookFern",
        projects: ["/r"],
        tags: { "/r": "[codex:hook] task" },
        worktrees: { "/r": "/edit" },
      }),
    );
    const rows = whoRows(
      {
        project: "/r",
        stateDir,
        room: null,
        roster: [
          { name: "NativeFern", task_description: "[codex:native] task", location: null },
          { name: "HookFern", task_description: "[WIP] Legacy registration" },
          { name: "T3Fern", task_description: "[t3:thread codex:t3-native] task" },
          { name: "UnknownFern", task_description: "[codex:missing] task" },
        ],
        threads: new Map([
          [
            "thread",
            { thread_id: "thread", title: "T3 task", cwd: null, status: null, last_seen_at: null },
          ],
        ]),
      },
      () => null,
      () => false,
    );
    expect(rows.map((row) => [row.name, row.title])).toEqual([
      ["NativeFern", "Native task"],
      ["HookFern", "Hook task"],
      ["T3Fern", "T3 task"],
      ["UnknownFern", null],
    ]);
    expect(rows[0].location).toBeNull();
    expect(rows[1].location.title).toBe("Hook task");
  } finally {
    for (const [key, value] of [
      ["HOME", previousHome],
      ["CODEX_HOME", previousCodex],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capped and retired registrations remain unknown when absent from the visible roster", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-visible-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") });
    const entries = [
      ["HiddenOwl", "limited"],
      ["RetiredBear", "retired"],
      ["VisibleFox", "visible"],
    ];
    for (const [name, thread] of entries) {
      tools.register_agent({
        project_key: "/repo",
        name,
        program: "codex",
        model: "test",
        task_description: `[t3:${thread} codex:native-${thread}] task`,
      });
    }
    tools.retire_agent({ project_key: "/repo", agent_name: "RetiredBear" });
    const roster = tools.list_agents({ project_key: "/repo", limit: 1 });
    expect(roster.map((agent) => agent.name)).toEqual(["VisibleFox"]);
    const rows = whoRows({
      project: "/repo",
      roster,
      stateDir: join(dir, "state"),
      room: null,
      checkout: () => "/repo",
      threads: new Map(
        entries.map(([, thread]) => [
          thread,
          {
            thread_id: thread,
            title: thread,
            cwd: "/repo",
            status: "running",
            last_seen_at: "2026-10-05T00:00:00Z",
          },
        ]),
      ),
    });
    for (const thread of ["limited", "retired"]) {
      expect(rows.find((row) => row.t3 === thread)).toMatchObject({
        name: null,
        task: "not in visible roster; registration and delivery unknown",
      });
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("who asks git about a thread directory once however many threads share it", () => {
  const dir = mkdtempSync(join(tmpdir(), "who-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const thread = (id, cwd) => [
      id,
      { thread_id: id, title: id, cwd, status: "running", last_seen_at: null },
    ];
    const threads = new Map([
      thread("a", "/r/w"),
      thread("b", "/r/w"),
      thread("c", "/other"),
      thread("d", "/other"),
    ]);
    const asked = [];
    const rows = whoRows({
      project: "/r",
      roster: [],
      stateDir,
      threads,
      room: null,
      checkout: (cwd) => {
        asked.push(cwd);
        return cwd === "/r/w" ? "/r" : "/elsewhere";
      },
    });
    expect(rows.map((row) => row.t3).sort()).toEqual(["a", "b"]);
    expect(asked).toEqual(["/r/w", "/other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
