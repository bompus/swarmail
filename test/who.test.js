import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          title: "Never registered",
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
    expect(rows[1]).toMatchObject({ t3: "lost", task: "not registered: mail cannot reach it" });
    expect(rows.find((row) => row.name === "WildDeer").sameSessionAs).toEqual(["WindyOriole"]);
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
