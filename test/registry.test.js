import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";

const withRegistry = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    fn(openRegistry(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("settle registers, keeps a failed registration pending for the next prompt, and skips a session that ended meanwhile", () => {
  withRegistry((registry, dir) => {
    let up = false;
    const register = () => (up ? "TealFern" : null);
    const settle = (since, project = "/r/a") =>
      registry.settle("s1", { since, project, tag: "[t1]", register, extra: { wakeThread: "th" } });

    expect(settle(1).after).toEqual({
      name: null,
      projects: [],
      pending: { project: "/r/a", tag: "[t1]" },
      wakeThread: "th",
    });
    up = true;
    expect(registry.resume("s1", 2)).toEqual({ project: "/r/a", tag: "[t1]" });
    const settled = settle(2);
    expect(settled.before.pending).toEqual({ project: "/r/a", tag: "[t1]" });
    expect(settled.after).toEqual({
      name: "TealFern",
      projects: ["/r/a"],
      tags: { "/r/a": "[t1]" },
      wakeThread: "th",
    });

    registry.end("s1", () => {}, new Date(5000));
    // Ended at or after the caller's start: the end wins and nothing is written.
    expect(settle(5000, "/r/b")).toBeNull();
    expect(settle(4000, "/r/b")).toBeNull();
    expect(registry.read("s1").ended).toBe(new Date(5000).toISOString());
    // A later prompt or edit clears the end.
    expect(settle(6000, "/r/b").after.ended).toBeUndefined();
    expect(registry.read("s1").projects).toEqual(["/r/a", "/r/b"]);
    expect(readdirSync(dir).sort()).toEqual(["s1.json"]);
  });
});

test("resume clears an end from before the prompt and leaves one recorded after it", () => {
  withRegistry((registry) => {
    registry.end("s1", () => {}, new Date(5000));
    expect(registry.resume("s1", 5000)).toBeUndefined();
    expect(registry.read("s1").ended).toBeDefined();
    expect(registry.resume("s1", 6000)).toBeUndefined();
    expect(registry.read("s1")).toEqual({ name: null, projects: [] });
  });
});

test("readers skip unreadable or foreign state and leftover temporary files", () => {
  withRegistry((registry, dir) => {
    writeFileSync(join(dir, "good.json"), JSON.stringify({ name: "GoldMoss", projects: [] }));
    writeFileSync(join(dir, "torn.json"), '{"name": "Ha');
    writeFileSync(join(dir, "left.json.tmp"), "{}");
    for (const [id, text] of [
      ["empty", "{}"],
      ["list", "[]"],
      ["null", "null"],
      ["number", "7"],
    ]) {
      writeFileSync(join(dir, `${id}.json`), text);
    }
    expect(registry.all().sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: "empty", projects: [] },
      { sessionId: "good", name: "GoldMoss", projects: [] },
    ]);
    expect(registry.read("torn")).toBeNull();
    expect(registry.read("empty")).toEqual({ projects: [] });
    expect(registry.read("number")).toBeNull();
    // A state that is not an object is replaced, not merged into.
    expect(
      registry.settle("list", { since: 0, project: "/r", tag: "[t]", register: () => "Fen" }).after,
    ).toEqual({ name: "Fen", projects: ["/r"], tags: { "/r": "[t]" } });
    expect(registry.read("missing")).toBeNull();
    registry.end("good", () => {}, new Date(0));
    expect(JSON.parse(readFileSync(join(dir, "good.json"), "utf8")).ended).toBe(
      new Date(0).toISOString(),
    );
  });
});

test("a changed edit checkout refreshes registration and survives a failed retry", () => {
  withRegistry((registry, dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    let up = true;
    const calls = [];
    const register = (project, name) => {
      calls.push([project, name]);
      return up ? (name ?? "BlueLake") : null;
    };
    const settle = (worktree) =>
      registry.settle("edit", {
        since: 0,
        project: "/r",
        tag: "[claude:edit cwd:/launch]",
        worktree,
        register,
      });
    settle(a);
    settle(a);
    expect(calls).toHaveLength(1);
    up = false;
    expect(settle(b).after.worktrees["/r"]).toBe(a);
    expect(registry.resume("edit", 0)).toEqual({
      project: "/r",
      tag: "[claude:edit cwd:/launch]",
      worktree: b,
    });
    expect(settle(undefined).after.pending).toEqual({
      project: "/r",
      tag: "[claude:edit cwd:/launch]",
      worktree: b,
    });
    up = true;
    const pending = registry.resume("edit", 0);
    expect(settle(pending.worktree).after.worktrees["/r"]).toBe(b);
    expect(registry.read("edit").pending).toBeUndefined();
    expect(calls).toEqual([
      ["/r", null],
      ["/r", "BlueLake"],
      ["/r", "BlueLake"],
    ]);
  });
});

test("a prompt drops a pending registration whose edit checkout was deleted", () => {
  withRegistry((registry, dir) => {
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const settle = (worktree) =>
      registry.settle("s1", {
        since: 0,
        project: "/r",
        tag: "[t1]",
        worktree,
        register: () => null,
      });
    expect(settle(gone).after.pending).toEqual({ project: "/r", tag: "[t1]", worktree: gone });
    expect(registry.resume("s1", 0)).toEqual({ project: "/r", tag: "[t1]", worktree: gone });
    rmSync(gone, { recursive: true });
    expect(registry.resume("s1", 0)).toBeUndefined();
    expect(registry.read("s1").pending).toBeUndefined();
  });
});

test("registration orderings preserve pending edit locations across supervisor calls", () => {
  withRegistry((registry, dir) => {
    const events = [
      { name: "edit A", worktree: "/w/a", up: true },
      { name: "edit B", worktree: "/w/b", up: true },
      { name: "supervisor", worktree: undefined, up: true },
      { name: "failed A", worktree: "/w/a", up: false },
      { name: "failed B", worktree: "/w/b", up: false },
      { name: "prompt retry", retry: true, up: true },
    ];
    const violations = [];
    const visit = (state, sequence) => {
      if (sequence.length === 3) {
        return;
      }
      for (const event of events) {
        writeFileSync(join(dir, "orders.json"), JSON.stringify(state));
        const worktree = event.retry ? state.pending?.worktree : event.worktree;
        const next =
          event.retry && !state.pending
            ? state
            : registry.settle("orders", {
                since: 0,
                project: "/r",
                tag: "[claude:s]",
                worktree,
                register: () => (event.up ? "BlueLake" : null),
              }).after;
        const nextSequence = [...sequence, event.name];
        const settled = event.up || worktree === state.worktrees?.["/r"];
        const expectedLocation =
          settled && worktree !== undefined ? worktree : state.worktrees?.["/r"];
        const expectedPending =
          worktree === undefined
            ? state.pending
            : settled
              ? undefined
              : { project: "/r", tag: "[claude:s]", worktree };
        if (
          next.worktrees?.["/r"] !== expectedLocation ||
          JSON.stringify(next.pending) !== JSON.stringify(expectedPending) ||
          (state.name && next.name !== state.name)
        ) {
          violations.push(nextSequence.join(" -> "));
        }
        visit(next, nextSequence);
      }
    };
    visit({ name: null, projects: [] }, []);
    expect(violations).toEqual([]);
  });
});
