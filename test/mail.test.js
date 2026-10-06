import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { mail } from "../src/mail.ts";
import { unreadQueues } from "../src/who.ts";

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-mail-")));
const repo = join(dir, "repo");
mkdirSync(repo);
spawnSync("git", ["init", "-q"], { cwd: repo });
const { server, db } = createServer(join(dir, "mail.sqlite3"), 0);
const env = {
  SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
  XDG_STATE_HOME: join(dir, "state"),
};
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("send and inbox act as the session's agent in the current repository", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const name of ["GreenLake", "BlueRiver"]) {
      await fetch(env.SWARMAIL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "register_agent",
            arguments: { project_key: repo, program: "x", model: "x", name },
          },
        }),
      });
    }
    expect(
      await mail(
        ["send", "BlueRiver", "Hello", "--as", "GreenLake"],
        async () => "from stdin",
        env,
        repo,
      ),
    ).toBe(0);
    expect(err.mock.calls.flat().join("\n")).toContain(
      "BlueRiver: unknown; wake support unverified",
    );
    log.mockClear();
    expect(
      await mail(
        [
          "send",
          "BlueRiver",
          "JSON result",
          "body",
          "--as",
          "GreenLake",
          "--delivery-policy",
          "durable",
          "--notification-policy",
          "quiet",
          "--json",
        ],
        async () => "",
        env,
        repo,
      ),
    ).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)[0]).notification_policy).toBe("quiet");
    expect(JSON.parse(log.mock.calls.at(-1)[0]).delivery).toMatchObject({
      persisted: true,
      historical: false,
    });
    expect(await mail(["inbox"], async () => "", env, repo)).toBe(1);
    expect(err.mock.calls.at(-1)[0]).toContain("pass --as NAME");

    const inbox = (...args) =>
      mail(["inbox", ...args], async () => "", { ...env, SWARMAIL_AGENT: "BlueRiver" }, repo);
    log.mockClear();
    expect(await inbox("--peek")).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toMatch(/from GreenLake: Hello\n {4}from stdin/);
    await inbox();
    log.mockClear();
    await inbox();
    expect(log.mock.calls[0][0]).toBe("BlueRiver: no unread messages");
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("search needs no sender name, inbox and search print JSON, who counts unread mail", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const run = (...args) => mail(args, async () => "", env, repo);
    expect(await run("search", "hello", "--json")).toBe(0);
    const found = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(found.map((m) => [m.subject, m.from, m.to])).toEqual([
      ["Hello", "GreenLake", ["BlueRiver"]],
    ]);
    expect(found[0].excerpt).toBe(">>>Hello<<<");
    log.mockClear();
    expect(await run("search", "stdin")).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("    from >>>stdin<<<");
    expect(await run("search", "nothing-like-this")).toBe(0);
    expect(log.mock.calls.at(-1)[0]).toBe('no mail matches "nothing-like-this"');

    expect(await run("send", "BlueRiver", "Queued", "body", "--as", "GreenLake")).toBe(0);
    const queue = unreadQueues(join(dir, "mail.sqlite3"), repo).get("BlueRiver");
    expect(queue?.unread).toBe(1);
    expect(Date.parse(queue?.oldest ?? "")).toBeGreaterThan(Date.now() - 60_000);

    expect(await run("inbox", "--json", "--as", "BlueRiver")).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)[0]).map((m) => m.subject)).toEqual(["Queued"]);
    expect(unreadQueues(join(dir, "mail.sqlite3"), repo).has("BlueRiver")).toBe(false);
  } finally {
    log.mockRestore();
  }
});

test("ping gets a pong while the target's wake hook waits, and fails when none waits", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await fetch(env.SWARMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: {
            project_key: repo,
            program: "x",
            model: "x",
            name: "RedHill",
            task_description: "[claude:m-1] target",
          },
        },
      }),
    });
    const waiting = fetch(`http://127.0.0.1:${server.port}/wait?session=m-1&timeout=2`);
    await Bun.sleep(100);
    const ping = (timeout) =>
      mail(
        ["ping", "RedHill", "--as", "GreenLake", "--timeout", timeout],
        async () => "",
        env,
        repo,
      );
    expect(await ping("3")).toBe(0);
    expect(log.mock.calls.at(-1)[0]).toMatch(/^pong from RedHill in /);
    expect((await waiting).status).toBe(204);
    expect(await ping("0.5")).toBe(1);
    expect(log.mock.calls.at(-1)[0]).toContain("no pong from RedHill");
  } finally {
    log.mockRestore();
  }
});

test("search follows a cursor and offers page JSON while retaining array JSON", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const run = (...args) => mail(args, async () => "", env, repo);
    for (const subject of ["paging alpha", "paging beta", "paging gamma"]) {
      expect(await run("send", "BlueRiver", subject, "body", "--as", "GreenLake")).toBe(0);
    }
    expect(await run("search", "paging", "--limit", "2", "--json-page")).toBe(0);
    const first = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(first.result).toHaveLength(2);
    expect(first.next_cursor).toBe("o2");
    expect(
      await run("search", "paging", "--limit", "2", "--cursor", first.next_cursor, "--json-page"),
    ).toBe(0);
    const second = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(second.result).toHaveLength(1);
    expect(second.next_cursor).toBeUndefined();
    expect(new Set([...first.result, ...second.result].map((m) => m.id)).size).toBe(3);
    expect(await run("search", "paging", "--limit", "2", "--json")).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toEqual(first.result);
    expect(await run("search", "paging", "--limit", "2")).toBe(0);
    expect(log.mock.calls.at(-1)[0]).toContain("--cursor o2");
    expect(await run("search", "paging", "--cursor", "bad")).toBe(1);
    expect(err.mock.calls.at(-1)[0]).toContain("cursor must be a search continuation cursor");
    expect(await run("search", "paging", "--cursor")).toBe(1);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("--help prints usage and sends nothing; an unreachable server names the remedy", async () => {
  const requests = [];
  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return new URL(request.url).pathname === "/mcp/"
        ? new Response("{}")
        : new Response("not found", { status: 404 });
    },
  });
  const cli = (...args) =>
    spawnSync(process.execPath, [join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env, SWARMAIL_URL: `http://127.0.0.1:${recorder.port}/mcp/` },
    });
  try {
    for (const args of [
      ["who", "--help"],
      ["send", "BlueRiver", "Hi", "-h"],
      ["thread", "7", "--help"],
    ]) {
      const r = cli(...args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`swarmail ${args[0]}`);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
    }
    expect(cli("--help").stdout).toContain("swarmail version");
    expect(requests).toEqual([]);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const wrong = { ...env, SWARMAIL_URL: `http://127.0.0.1:${recorder.port}/wrong/` };
      expect(await mail(["search", "x"], async () => "", wrong, repo)).toBe(1);
      expect(err.mock.calls.at(-1)[0]).toContain("answered HTTP 404");
    } finally {
      err.mockRestore();
    }
  } finally {
    recorder.stop(true);
  }
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const closed = { ...env, SWARMAIL_URL: `http://127.0.0.1:${recorder.port}/mcp/` };
    expect(await mail(["search", "x"], async () => "", closed, repo)).toBe(1);
    expect(err.mock.calls.at(-1)[0]).toContain("is `swarmail serve` running?");
  } finally {
    err.mockRestore();
  }
}, 30000);

test("thread prints a thread's messages oldest first without a sender name", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      await mail(
        ["send", "BlueRiver", "Thread start", "--as", "GreenLake"],
        async () => "first body",
        env,
        repo,
      ),
    ).toBe(0);
    const id = /sent #(\d+)/.exec(log.mock.calls.at(-1)[0])[1];
    log.mockClear();
    expect(await mail(["thread", id], async () => "", env, repo)).toBe(0);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toContain(`thread ${id}: 1 message · GreenLake`);
    expect(out).toMatch(/from GreenLake: Thread start\n {4}first body/);
    expect(await mail(["thread"], async () => "", env, repo)).toBe(64);
  } finally {
    log.mockRestore();
  }
});
