import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canary, httpWait, roundTrip } from "../src/canary.ts";
import { call } from "../src/mail.ts";
import { createServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "swarmail-canary-"));
const { server, db } = createServer(join(dir, "mail.sqlite3"), 0);
const env = {
  SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
  SWARMAIL_WAKE_URL: `http://127.0.0.1:${server.port}`,
  XDG_STATE_HOME: join(dir, "state"),
};
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a run through the server passes, logs a line and keeps its agents", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await canary(env)).toBe(0);
    expect(await canary(env)).toBe(0);
  } finally {
    log.mockRestore();
  }
  const state = join(env.XDG_STATE_HOME, "swarmail-canary");
  const lines = readFileSync(join(state, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.map((l) => l.ok)).toEqual([true, true]);
  expect(lines[1].wake_ms).toBeLessThan(2000);
  const names = JSON.parse(readFileSync(join(state, "agents.json"), "utf8"));
  const roster = await call(env, "list_agents", { project_key: state });
  expect(roster.map((a) => a.name).sort()).toEqual([names.receiver, names.sender].sort());
});

test("a wait that never hints fails the run and names the message", async () => {
  const project = join(env.XDG_STATE_HOME, "swarmail-canary");
  const { result } = await roundTrip(
    project,
    {},
    (name, args) => call(env, name, args),
    async () => null,
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("no wake hint");
  expect(result.message_id).toBeGreaterThan(0);
});

test("the wait endpoint comes from SWARMAIL_WAKE_URL, the way a wake hook finds it", async () => {
  const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const deadUrl = `http://127.0.0.1:${gone.port}`;
  gone.stop(true); // Nothing listens there now: if the canary used SWARMAIL_URL instead, this run would pass.
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await canary({ ...env, SWARMAIL_WAKE_URL: deadUrl })).toBe(1);
  } finally {
    log.mockRestore();
  }
});

test("a wait that never answers is cut off after the wait time plus a grace period", async () => {
  const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
  try {
    const started = performance.now();
    await expect(httpWait(`http://127.0.0.1:${silent.port}`, 100)("session", 0)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    silent.stop(true);
  }
});

test("a trailing slash in SWARMAIL_WAKE_URL still reaches /wait", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await canary({ ...env, SWARMAIL_WAKE_URL: `${env.SWARMAIL_WAKE_URL}/` })).toBe(0);
  } finally {
    log.mockRestore();
  }
});
