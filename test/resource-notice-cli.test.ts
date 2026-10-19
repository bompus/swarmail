import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createTools } from "../src/tools.ts";
import { mail } from "../src/mail.ts";

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swm-resource-")));
const repo = join(dir, "repo");
mkdirSync(repo);
spawnSync("git", ["init", "-q"], { cwd: repo });
const { server, db } = createServer(join(repo, "mail.sqlite3"), 0);
const env = {
  SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
  SWARMAIL_AGENT: "BlueLake",
  XDG_STATE_HOME: join(repo, "state"),
};
const tools = createTools(db, { databasePath: ":memory:" });
for (const name of ["BlueLake", "GreenCastle"]) {
  tools.register_agent({ project_key: repo, name, program: "test", model: "test" });
}
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const payload = {
  resource_id: "heavy-local-work",
  phase_id: "suite-42",
  state: "released",
  next_action: "none",
};

test("CLI JSON stdin sends a quiet typed notice, retries once and displays readable inbox text", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const args = [
      "send",
      "GreenCastle",
      "--resource-notice",
      "--idempotency-key",
      "cli-release",
      "--json",
    ];
    expect(await mail(args, async () => JSON.stringify(payload), env, repo)).toBe(0);
    const first = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(first).toMatchObject({
      subject: "Resource released",
      body_md: "Resource `heavy-local-work` was released by phase `suite-42`. No action requested.",
      notification_policy: "quiet",
    });
    expect(await mail(args, async () => JSON.stringify(payload), env, repo)).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toMatchObject({
      id: first.id,
      idempotent_replay: true,
    });
    expect(db.query("SELECT count(*) AS n FROM messages").get().n).toBe(1);
    log.mockClear();
    expect(await mail(["inbox", "--peek", "--as", "GreenCastle"], async () => "", env, repo)).toBe(
      0,
    );
    expect(log.mock.calls.flat().join("\n")).toContain(
      "    Resource `heavy-local-work` was released by phase `suite-42`. No action requested.",
    );
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("CLI malformed notices and mixed text or delivery options fail before any network request", async () => {
  const network = spyOn(globalThis, "fetch");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const base = ["send", "GreenCastle", "--resource-notice", "--idempotency-key", "invalid-cli"];
    const cases = [
      [base, "{"],
      [base, "null"],
      [base, JSON.stringify({ ...payload, details: "unrelated compiler errors" })],
      [base.slice(0, 3), JSON.stringify(payload)],
      [[...base, "Subject", "body"], JSON.stringify(payload)],
      [[...base, "--notification-policy", "wake"], JSON.stringify(payload)],
      [[...base, "--delivery-policy", "durable"], JSON.stringify(payload)],
      [[...base, "--extra"], JSON.stringify(payload)],
      [["send", "GreenCastle,BlueLake", ...base.slice(2)], JSON.stringify(payload)],
      [["inbox", "--resource-notice"], JSON.stringify(payload)],
    ];
    for (const [args, input] of cases) {
      expect(await mail(args, async () => input, env, repo)).toBe(1);
    }
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    err.mockRestore();
  }
});
