import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../src/mail.ts";
import { createServer } from "../src/server.ts";

// A second loopback address stands in for a tailnet one, as in remote.test.ts.
const REMOTE = "127.0.0.2";
const TOKEN = "g".repeat(40);
const PROJECT = "git:github.com/acme/widget";
let dir: string, repo: string, tokenFile: string, hub: string;
let server: ReturnType<typeof createServer>["server"];
let remote: NonNullable<ReturnType<typeof createServer>["remote"]>;
let db: ReturnType<typeof createServer>["db"];

const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

// guard reads the hub with curl, which would block this process's own server, so it runs in a child.
async function guardRun(extra: Record<string, string>, url = hub) {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { guard } from "./src/guard.ts"; process.exit(guard("pre-commit", "", process.env, ${JSON.stringify(repo)}));`,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        SWARMAIL_AGENT: "",
        SWARMAIL_GUARD: "",
        SWARMAIL_TOKEN_FILE: tokenFile,
        SWARMAIL_URL: url,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

beforeAll(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-guard-remote-")));
  tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const created = createServer(join(dir, "mail.sqlite3"), 0, {
    remote: { hostname: REMOTE, token: TOKEN },
  });
  ({ server, db } = created);
  remote = created.remote!;
  hub = `http://${REMOTE}:${server.port}/mcp/`;
  const local = { SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/` };
  await call(local, "register_agent", {
    project_key: PROJECT,
    program: "claude-code",
    model: "m",
    name: "GreenLake",
  });
  const reserve = (paths: string[], exclusive: boolean) =>
    call(local, "file_reservation_paths", {
      project_key: PROJECT,
      agent_name: "GreenLake",
      paths,
      exclusive,
      reason: "refactor",
    });
  await reserve(["src/*.ts"], true);
  await reserve(["shared.md"], false);
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("remote", "add", "origin", "https://github.com/acme/widget.git");
  git("commit", "-q", "--allow-empty", "-m", "init");
});
afterAll(async () => {
  await server.stop(true);
  await remote.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stage = (path: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), String(Math.random()));
  git("add", path);
};

test("a commit touching a path reserved on the hub is refused, naming the holder", async () => {
  stage("src/a.ts");
  const run = await guardRun({});
  expect(run.code).toBe(1);
  expect(run.out).toContain("src/a.ts");
  expect(run.out).toContain("held by GreenLake");
  git("reset", "-q");
});

test("the holder, a shared reservation and a warning-only guard let the commit through", async () => {
  stage("src/a.ts");
  expect((await guardRun({ SWARMAIL_AGENT: "GreenLake" })).code).toBe(0);
  expect((await guardRun({ SWARMAIL_GUARD: "warn" })).code).toBe(0);
  git("reset", "-q");
  stage("shared.md");
  expect((await guardRun({})).code).toBe(0);
  git("reset", "-q");
});

test("a hub address that is not a URL skips the check instead of failing the commit", async () => {
  stage("src/a.ts");
  const run = await guardRun({}, "hub.example.invalid");
  expect(run.code).toBe(0);
  expect(run.out).toContain("is not a URL");
  git("reset", "-q");
});

test("a repository the hub has never seen has no reservations and prints nothing", async () => {
  git("remote", "set-url", "origin", "https://github.com/acme/unknown.git");
  stage("src/a.ts");
  const run = await guardRun({});
  expect(run.code).toBe(0);
  expect(run.out).toBe("");
  git("remote", "set-url", "origin", "https://github.com/acme/widget.git");
  git("reset", "-q");
});

test("an unreachable hub is reported and does not block the commit", async () => {
  stage("src/a.ts");
  const run = await guardRun({}, `http://${REMOTE}:1/mcp/`);
  expect(run.code).toBe(0);
  expect(run.out).toContain("could not read reservations");
  expect(run.out).not.toContain(TOKEN);
});

test("a hub that lacks the tool is reported, not taken for a project with no reservations", async () => {
  const old = Bun.serve({
    hostname: REMOTE,
    port: 0,
    fetch: () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "NOT_FOUND: Unknown tool 'list_file_reservations'" }],
        },
      }),
  });
  try {
    stage("src/a.ts");
    const run = await guardRun({}, `http://${REMOTE}:${old.port}/mcp/`);
    expect(run.code).toBe(0);
    expect(run.out).toContain("could not read reservations");
  } finally {
    await old.stop(true);
    git("reset", "-q");
  }
});
