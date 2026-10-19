import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testScratch } from "./fixtures/test-scratch.ts";

// Loose JSON payloads: the malformed cases need fields the store would never hold.
type Extra = Record<string, any>;

// CLI-boundary coverage: projection joins, schema failures, provenance and no database writes.
const scratch = testScratch();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const date = "2026-10-05T00:00:00.000Z";
const url = (n = 7, repo = "owner/repo") => `https://github.com/${repo}/pull/${n}`;
const link = (n = 7, extra: Extra = {}) => ({
  host: "github.com",
  repository: "owner/repo",
  number: n,
  url: url(n),
  source: "manual",
  linkedAt: date,
  snapshot: null,
  stack: null,
  ...extra,
});
const legacy = (n = 7) => ({ projectId: "p", repository: "owner/repo", number: n, url: url(n) });
const snapshot = (head: string, base: string) => ({
  state: "open",
  title: head,
  headBranch: head,
  baseBranch: base,
  isDraft: false,
  updatedAt: null,
  syncedAt: date,
});
const thread = (id: string, extra: Extra = {}): Extra => ({
  id,
  projectId: "p",
  title: id,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  historyOrigin: "native",
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  pullRequests: [link()],
  ...extra,
});
const provider = (
  id: string,
  appThreadId: string | null,
  nativeId: string | null,
  extra: Extra = {},
): Extra => ({
  id,
  appThreadId,
  ownerNodeId: null,
  driver: "codex",
  providerInstanceId: "codex-default",
  providerSessionId: `runtime-${id}`,
  nativeThreadRef: { driver: "codex", nativeId, strength: "strong" },
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
  createdAt: date,
  updatedAt: date,
  ...extra,
});
function fixture() {
  const dir = mkdtempSync(join(scratch, "case-"));
  dirs.push(dir);
  const project = join(dir, "project"),
    otherProject = join(dir, "other");
  const profile = join(dir, "t3");
  for (const path of [project, otherProject, join(profile, "userdata")]) {
    mkdirSync(path, { recursive: true });
  }
  const file = join(profile, "userdata/statev2.sqlite"),
    roster = join(dir, "mail.sqlite");
  const db = new Database(file);
  db.run(`CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT,project_id TEXT,active_provider_thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT,thread_id TEXT,owner_node_id TEXT,provider_session_id TEXT,updated_at TEXT,payload_json TEXT);
    CREATE TABLE projection_thread_pull_requests (thread_id TEXT,url TEXT);`);
  db.run("INSERT INTO projection_projects VALUES (?,?),(?,?)", ["p", project, "q", otherProject]);
  const room = new Database(roster);
  room.run(`CREATE TABLE projects (id INTEGER,human_key TEXT);
    CREATE TABLE agents (project_id INTEGER,name TEXT,program TEXT,model TEXT,task_description TEXT,retired_at INTEGER,last_active_ts INTEGER);`);
  room.run("INSERT INTO projects VALUES (1,?)", [project]);
  return {
    dir,
    project,
    profile,
    file,
    roster,
    db,
    room,
    add(t: Extra) {
      db.run("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?)", [
        t.id,
        t.projectId,
        t.activeProviderThreadId,
        JSON.stringify(t),
      ]);
    },
    addProvider(p: Extra) {
      db.run("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?,?)", [
        p.id,
        p.appThreadId,
        p.ownerNodeId,
        p.providerSessionId,
        p.updatedAt,
        JSON.stringify(p),
      ]);
    },
    agent(name: string, tag: string, retired: number | null = null) {
      room.run("INSERT INTO agents VALUES (1,?,'codex','fixture',?,?,1)", [name, tag, retired]);
    },
    close() {
      db.close();
      room.close();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, target = url(), flags: string[] = []) {
  const child = spawnSync(
    process.execPath,
    [
      join(import.meta.dir, "../src/cli.ts"),
      "pr-sessions",
      target,
      "--project",
      f.project,
      "--t3-home",
      f.profile,
      ...flags,
    ],
    { encoding: "utf8", env: { ...process.env, SWARMAIL_DB: f.roster }, timeout: 5000 },
  );
  return {
    status: child.status,
    error: child.stderr,
    output: child.status === 0 ? (JSON.parse(child.stdout) as any) : null,
  };
}
test("secondary, multiple, retained and project-scoped associations use V2 payloads", () => {
  const f = fixture();
  f.add(
    thread("secondary", {
      pullRequests: [link(8), link()],
      archivedAt: date,
      settledAt: date,
      settledOverride: "active",
      deletedAt: date,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: "parent",
        relationshipToParent: "subagent",
        rootThreadId: "parent",
      },
    }),
  );
  f.add(
    thread("fork", {
      lineage: { parentThreadId: "parent", relationshipToParent: "fork", rootThreadId: "parent" },
      forkedFrom: { type: "run", threadId: "parent", runId: "r" },
    }),
  );
  f.add(thread("wrong-project", { projectId: "q" }));
  f.add(
    thread("wrong-repo", {
      pullRequests: [link(7, { repository: "other/repo", url: url(7, "other/repo") })],
    }),
  );
  f.add(thread("copied-only", { pullRequests: [] }));
  f.db.run("INSERT INTO projection_thread_pull_requests VALUES ('copied-only',?)", [url()]);
  f.close();
  const result = run(f, "https://github.com/OWNER/REPO/pull/7");
  expect(result.status).toBe(0);
  expect(result.output.matches.map((m: any) => m.threadId)).toEqual(["fork", "secondary"]);
  const m = result.output.matches[1];
  expect({
    archive: m.archivedAt,
    deleted: m.deletedAt,
    settled: m.settledAt,
    override: m.settledOverride,
    lineage: m.lineage.relationshipToParent,
    origin: m.historyOrigin,
    links: m.visibleLinks.length,
  }).toEqual({
    archive: date,
    deleted: date,
    settled: date,
    override: "active",
    lineage: "subagent",
    origin: "v1_import",
    links: 2,
  });
  expect(result.output.matches[0].forkedFrom).toEqual({
    type: "run",
    threadId: "parent",
    runId: "r",
  });
  expect(m.swarmail).toEqual({ status: "unknown", identities: [] });
});
test("absent arrays allow legacy links; empty arrays suppress fallback and discoveries stay separate", () => {
  const f = fixture();
  const absent = thread("legacy", { linkedPullRequest: legacy() });
  delete absent.pullRequests;
  f.add(absent);
  f.add(thread("empty", { linkedPullRequest: legacy(), pullRequests: [] }));
  f.add(thread("discovered", { pullRequests: [], branchPullRequest: legacy() }));
  f.close();
  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.output.matches.map((m: any) => m.threadId)).toEqual(["discovered", "legacy"]);
  expect(result.output.matches[0].associations).toEqual([]);
  expect(result.output.matches[0].branchDiscovery.number).toBe(7);
  expect(result.output.matches[1].associations[0].linkedAt).toBe("1970-01-01T00:00:00.000Z");
});
test("exact active references are independent of root history and native IDs identify all available roster matches", () => {
  for (const [driver, host] of [
    ["codex", "codex"],
    ["claudeAgent", "claude"],
    ["cursor", "cursor"],
    ["grok", "grok"],
    ["opencode", "opencode"],
    ["antigravity", "agy"],
    ["constructor", "constructor"],
  ]) {
    const f = fixture();
    f.add(thread("t", { activeProviderThreadId: "new" }));
    f.addProvider(
      provider("old", "t", "OldNative", {
        driver,
        providerInstanceId: "claude",
        nativeThreadRef: { driver, nativeId: "OldNative", strength: "strong" },
      }),
    );
    f.addProvider(provider("new", null, "NewNative", { ownerNodeId: "node" }));
    f.addProvider(provider("child", "t", "ExcludedChild", { ownerNodeId: "other-node" }));
    f.agent("Retired", `[${host}:OldNative cwd:fixture]`, 3);
    f.agent("Current", "[t3:t codex:NewNative cwd:fixture]");
    f.agent("SecondName", "[t3:t codex:NewNative cwd:fixture]");
    f.agent("WrongT3", "[t3:other codex:NewNative cwd:fixture]");
    f.agent("WrongCase", "[codex:newnative cwd:fixture]");
    f.agent("RuntimeIsNotNative", "[codex:runtime-new cwd:fixture]");
    f.agent("ChildIsNotHistory", "[codex:ExcludedChild cwd:fixture]");
    f.close();
    const result = run(f);
    expect(result.status).toBe(0);
    const m = result.output.matches[0];
    expect(m.currentProvider).toMatchObject({
      providerThreadId: "new",
      ownerNodeId: "node",
      appThreadId: null,
      nativeId: "NewNative",
      providerSessionId: "runtime-new",
    });
    expect(m.providerHistory.entries.map((p: any) => p.providerThreadId)).toEqual(["old"]);
    expect(m.swarmail.identities.map((a: any) => a.name)).toEqual([
      "Current",
      "Retired",
      "SecondName",
    ]);
    expect(m.swarmail.identities[1].retiredAt).toBe(3);
  }
});
test("missing active rows, null native IDs and missing roster retain the association with unknowns", () => {
  const f = fixture();
  f.add(thread("missing", { activeProviderThreadId: "gone" }));
  f.add(thread("null-native", { activeProviderThreadId: "null" }));
  f.addProvider(
    provider("null", "null-native", null, {
      driver: "customProvider",
      providerInstanceId: "custom",
      nativeThreadRef: { driver: "customProvider", nativeId: null, strength: "none" },
    }),
  );
  f.close();
  rmSync(f.roster);
  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.output.matches[0].currentProvider).toBeNull();
  expect(result.output.matches[1].currentProvider.nativeId).toBeNull();
  expect(result.output.matches.every((m: any) => m.swarmail.status === "unavailable")).toBe(true);
});
test("native layers do not create visible associations and dismissed links require explicit inclusion", () => {
  const f = fixture();
  const stack = {
    kind: "native",
    id: "s",
    number: 1,
    url: "https://github.com/owner/repo/stack/1",
    base: "main",
    layers: [
      { number: 7, headBranch: "bottom", state: "open" },
      { number: 8, headBranch: "top", state: "merged" },
    ],
  };
  f.add(
    thread("native", {
      pullRequests: [
        link(7, { source: "stack", stack }),
        link(8, { source: "stack-dismissed", stack }),
      ],
    }),
  );
  f.close();
  expect(run(f, url(8)).output.matches).toEqual([]);
  const hidden = run(f, url(8), ["--include-hidden"]);
  expect(hidden.status).toBe(0);
  expect(hidden.output.matches[0].associations).toEqual([]);
  expect(hidden.output.matches[0].hiddenAssociations[0].source).toBe("stack-dismissed");
  expect(hidden.output.matches[0].chains.native[0]).toMatchObject({ links: [7], stack });
});
test("derived chains order bottom to top; ambiguous heads and cycles remain unordered", () => {
  const f = fixture();
  f.add(
    thread("ordered", {
      pullRequests: [
        link(8, { snapshot: snapshot("top", "bottom") }),
        link(7, { snapshot: snapshot("bottom", "main") }),
      ],
    }),
  );
  f.add(
    thread("ambiguous", {
      pullRequests: [
        link(7, { snapshot: snapshot("same", "main") }),
        link(8, { snapshot: snapshot("same", "main") }),
      ],
    }),
  );
  f.add(
    thread("cycle", {
      pullRequests: [
        link(7, { snapshot: snapshot("a", "b") }),
        link(8, { snapshot: snapshot("b", "a") }),
      ],
    }),
  );
  f.close();
  const result = run(f);
  expect(result.status).toBe(0);
  const byId = Object.fromEntries(result.output.matches.map((m: any) => [m.threadId, m]));
  expect(byId.ordered.chains.derived[0]).toMatchObject({ ordered: true, links: [7, 8] });
  expect(byId.ambiguous.chains.derived[0].ordered).toBe(false);
  expect(byId.cycle.chains.derived[0].ordered).toBe(false);
});
test("partially refreshed native stack snapshots preserve associations and expose disagreement", () => {
  const f = fixture();
  const stack = {
    kind: "native",
    id: "s",
    number: 1,
    url: "https://github.com/owner/repo/stack/1",
    base: "main",
    layers: [
      { number: 7, headBranch: "bottom", state: "open" },
      { number: 8, headBranch: "top", state: "open" },
    ],
  };
  const refreshed = {
    ...stack,
    layers: [{ ...stack.layers[0], state: "merged" }, stack.layers[1]],
  };
  f.add(thread("partial", { pullRequests: [link(7, { stack }), link(8, { stack: refreshed })] }));
  f.close();
  const result = run(f);
  expect(result.status).toBe(0);
  const m = result.output.matches[0];
  expect(m.associations[0].number).toBe(7);
  expect(m.chains.native[0]).toMatchObject({
    stack: null,
    snapshotAgreement: false,
    links: [7, 8],
  });
  expect(m.visibleLinks.map((l: any) => l.stack.layers[0].state)).toEqual(["open", "merged"]);
});
test("malformed or unsupported recognized input fails visibly without reporting zero matches", () => {
  for (const mutate of [
    (f: Fixture) => f.add(thread("bad", { pullRequests: null })),
    (f: Fixture) => f.add(thread("bad", { pullRequests: [link(7, { url: url(8) })] })),
    (f: Fixture) => f.add(thread("bad", { pullRequests: [link(7, { source: "future-source" })] })),
    (f: Fixture) => f.add(thread("bad", { pullRequests: [link(7, { host: "gitlab.com" })] })),
    (f: Fixture) => f.db.run("DROP TABLE orchestration_v2_projection_threads"),
    (f: Fixture) => f.db.run("DROP TABLE orchestration_v2_projection_provider_threads"),
    (f: Fixture) =>
      f.db.run("INSERT INTO orchestration_v2_projection_threads VALUES ('bad','p',NULL,'{')"),
  ]) {
    const f = fixture();
    mutate(f);
    f.close();
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.error).toContain("pr-sessions:");
    expect(result.output).toBeNull();
  }
  const f = fixture();
  f.close();
  for (const input of [
    "https://gitlab.com/owner/repo/pull/7",
    url() + "?tab=files",
    url(9007199254740992),
  ]) {
    const result = run(f, input);
    expect(result.status).toBe(1);
    expect(result.error).not.toContain("malformed metadata");
  }
  expect(run(f, url(), ["--project", f.project]).status).toBe(1);
  rmSync(f.file);
  const missing = run(f);
  expect(missing.status).toBe(1);
  expect(missing.error).toContain("local T3 store is missing");
  expect(missing.error).not.toContain("malformed metadata");
  expect(readdirSync(join(f.profile, "userdata"))).toEqual([]);
});
test("repeat invocation preserves store bytes and creates no sidecar or roster files", () => {
  const f = fixture();
  f.add(thread("t"));
  f.close();
  const inventory = () => ({
    t3: readdirSync(join(f.profile, "userdata")),
    root: readdirSync(f.dir),
    hashes: [f.file, f.roster].map((path) =>
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ),
  });
  const before = inventory(),
    first = run(f),
    second = run(f);
  expect(first.status).toBe(0);
  expect(second).toEqual(first);
  expect(inventory()).toEqual(before);
});
