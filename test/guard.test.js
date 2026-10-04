import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowUs, openDatabase } from "../src/db.ts";
import { guard } from "../src/guard.ts";
import { selfNames } from "../src/registry.ts";
import { installSwarmailGuard } from "../scripts/install-guard.ts";

let dir, repo, dbPath, env;
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
const stage = (path) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), String(Math.random()));
  git("add", path);
};
function reserve(agent, pattern, { exclusive = 1, ttl = 3600, released = null } = {}) {
  const db = openDatabase(dbPath);
  const now = nowUs();
  let project = db.query("SELECT id FROM projects WHERE human_key = ?").get(repo);
  if (!project) {
    project = db
      .query("INSERT INTO projects (slug, human_key, created_at) VALUES (?, ?, ?) RETURNING id")
      .get("p", repo, now);
  }
  db.run(
    "INSERT OR IGNORE INTO agents (project_id, name, program, model, inception_ts, last_active_ts) VALUES (?, ?, 'x', 'x', ?, ?)",
    [project.id, agent, now, now],
  );
  const { id } = db.query("SELECT id FROM agents WHERE name = ?").get(agent);
  db.run(
    "INSERT INTO file_reservations (project_id, agent_id, path_pattern, exclusive, reason, created_ts, expires_ts, released_ts) VALUES (?, ?, ?, ?, '', ?, ?, ?)",
    [project.id, id, pattern, exclusive, now, now + ttl * 1_000_000, released],
  );
  db.close();
}

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-guard-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
  dbPath = join(dir, "mail.sqlite3");
  env = { SWARMAIL_DB: dbPath, XDG_STATE_HOME: join(dir, "state") };
  reserve("GreenLake", "src/*.ts");
  reserve("GreenLake", "docs/");
  reserve("BlueRiver", "shared.md", { exclusive: 0 });
  reserve("BlueRiver", "old.md", { ttl: -1 });
  reserve("BlueRiver", "gone.md", { released: nowUs() });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("blocks a commit touching another agent's exclusive reservation, by glob or directory", () => {
  stage("src/a/b.ts");
  expect(guard("pre-commit", "", env, repo)).toBe(1);
  git("reset", "-q");
  stage("docs/guide.md");
  expect(guard("pre-commit", "", env, repo)).toBe(1);
  git("reset", "-q");
});

test("passes shared, expired and released reservations, and the holder's own", () => {
  for (const path of ["shared.md", "old.md", "gone.md"]) {
    stage(path);
  }
  expect(guard("pre-commit", "", env, repo)).toBe(0);
  stage("src/x.ts");
  expect(guard("pre-commit", "", { ...env, SWARMAIL_AGENT: "greenlake" }, repo)).toBe(0);
  expect(guard("pre-commit", "", { ...env, SWARMAIL_GUARD: "warn" }, repo)).toBe(0);
  expect(guard("pre-commit", "", { ...env, SWARMAIL_GUARD: "off" }, repo)).toBe(0);
  expect(guard("pre-commit", "", env, repo)).toBe(1);
  git("reset", "-q");
});

test("pre-push checks the commits no remote has", () => {
  stage("src/y.ts");
  git("commit", "-q", "--no-verify", "-m", "y");
  const sha = git("rev-parse", "HEAD").stdout.trim();
  expect(
    guard("pre-push", `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`, env, repo),
  ).toBe(1);
  expect(guard("pre-push", `(delete) ${"0".repeat(40)} refs/heads/main ${sha}\n`, env, repo)).toBe(
    0,
  );
});

test("finds its own names from the register hook's state for the host process", () => {
  const state = join(dir, "state", "swarmail-register");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "a.json"),
    JSON.stringify({ name: "GreenLake", host: { pid: 42, start: "7" } }),
  );
  writeFileSync(
    join(state, "b.json"),
    JSON.stringify({ name: "BlueRiver", host: { pid: 42, start: "6" } }),
  );
  expect([...selfNames(env, { pid: 42, start: "7" })]).toEqual(["GreenLake"]);
  expect([...selfNames(env, null)]).toEqual([]);
  rmSync(state, { recursive: true });
});

test("the installed hook blocks a real commit and preserves the hook chain", () => {
  const hooks = join(repo, ".git", "hooks");
  for (const hook of ["pre-commit", "pre-push"]) {
    writeFileSync(
      join(hooks, hook),
      `#!/bin/sh\nfor f in "$(dirname "$0")"/hooks.d/${hook}/*; do "$f" || exit 1; done\n`,
    );
    chmodSync(join(hooks, hook), 0o755);
    mkdirSync(join(hooks, "hooks.d", hook), { recursive: true });
    writeFileSync(join(hooks, "hooks.d", hook, "10-other"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  // Stands in for ~/.local/bin/swarmail.
  const bin = join(repo, ".git", "swarmail");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "..", "src", "cli.ts")}" "$@"\n`,
    { mode: 0o755 },
  );
  expect(installSwarmailGuard(repo, { bin, dryRun: true })).toHaveLength(2);
  installSwarmailGuard(repo, { bin });
  expect(existsSync(join(hooks, "hooks.d", "pre-commit", "10-other"))).toBe(true);
  expect(installSwarmailGuard(repo, { bin })).toEqual([]);
  stage("src/z.ts");
  const run = (extra) =>
    spawnSync("git", ["commit", "-q", "-m", "z"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env, ...extra },
    });
  const blocked = run({});
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toContain("src/z.ts  (src/*.ts, held by GreenLake)");
  expect(run({ SWARMAIL_AGENT: "GreenLake" }).status).toBe(0);
});
