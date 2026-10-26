import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, bearerToken } from "../src/paths.ts";
import { call } from "../src/mail.ts";
import { createServer, isRemoteAddress, main } from "../src/server.ts";

// A second loopback address stands in for a tailnet one: same port, different bind address.
const REMOTE = "127.0.0.2";
const TOKEN = "t".repeat(40);
const RELAY = join(import.meta.dir, "..", "packages", "mcp-relay", "index.mjs");
let dir: string;
let server: ReturnType<typeof createServer>["server"];
let remote: NonNullable<ReturnType<typeof createServer>["remote"]>;
let db: ReturnType<typeof createServer>["db"];
let tokenFile: string;

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-remote-")));
  tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const created = createServer(join(dir, "mail.sqlite3"), 0, {
    remote: { hostname: REMOTE, token: TOKEN },
  });
  ({ server, db } = created);
  remote = created.remote!;
});
afterAll(async () => {
  await server.stop(true);
  await remote.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const list = (url: string, authorization?: string) =>
  fetch(`${url}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization && { authorization }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("the remote listener refuses a request without the token and answers one with it", async () => {
  const url = `http://${REMOTE}:${server.port}`;
  expect((await list(url)).status).toBe(401);
  expect((await list(url, "Bearer wrong")).status).toBe(401);
  expect((await list(url, `Bearer ${TOKEN}x`)).status).toBe(401);
  const ok = await list(url, `Bearer ${TOKEN}`);
  expect(ok.status).toBe(200);
  const wait = await fetch(`${url}/wait?session=sid&timeout=0`);
  expect(wait.status).toBe(401);
});

test("the status route and the loopback listener stay open without a token", async () => {
  expect((await fetch(`http://${REMOTE}:${server.port}/healthz`)).status).toBe(200);
  expect((await list(`http://127.0.0.1:${server.port}`)).status).toBe(200);
});

test("a browser origin is still refused with the right token", async () => {
  const res = await fetch(`http://${REMOTE}:${server.port}/mcp/`, {
    method: "POST",
    headers: { origin: "http://evil.example", authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(res.status).toBe(403);
});

test("the command sends the token from SWARMAIL_TOKEN_FILE", async () => {
  const env = {
    SWARMAIL_URL: `http://${REMOTE}:${server.port}/mcp/`,
    SWARMAIL_TOKEN_FILE: tokenFile,
  };
  expect((await call(env, "ensure_project", { human_key: "/remote/project" })).slug).toBe(
    "remote-project",
  );
  const refused = await call({ SWARMAIL_URL: env.SWARMAIL_URL }, "ensure_project", {
    human_key: "/remote/project",
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
});

test("the relay sends the token from SWARMAIL_TOKEN_FILE", async () => {
  const proc = Bun.spawn(["node", RELAY], {
    env: {
      ...process.env,
      SWARMAIL_URL: `http://${REMOTE}:${server.port}/mcp/`,
      SWARMAIL_TOKEN_FILE: tokenFile,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  await proc.stdin.end();
  const out = JSON.parse((await new Response(proc.stdout).text()).trim());
  expect(out.result.tools.length).toBeGreaterThan(0);
});

test("the relay does not read the token file for a loopback URL", async () => {
  const proc = Bun.spawn(["node", RELAY], {
    env: {
      ...process.env,
      SWARMAIL_URL: `http://127.0.0.1:${server.port}/mcp/`,
      SWARMAIL_TOKEN_FILE: join(dir, "missing"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  await proc.stdin.end();
  const out = JSON.parse((await new Response(proc.stdout).text()).trim());
  expect(out.result.tools.length).toBeGreaterThan(0);
});

test("a token file needs a token of at least 32 characters", () => {
  const short = join(dir, "short");
  writeFileSync(short, "tooshort\n");
  expect(bearerToken({})).toBeNull();
  expect(bearerToken({ SWARMAIL_TOKEN_FILE: tokenFile })).toBe(TOKEN);
  expect(() => bearerToken({ SWARMAIL_TOKEN_FILE: short })).toThrow("at least 32");
  expect(() => bearerToken({ SWARMAIL_TOKEN_FILE: join(dir, "missing") })).toThrow();
});

test("addresses the remote listener may bind", () => {
  for (const host of ["100.119.136.117", "192.168.1.20", "fd7a:115c:a1e0::1"]) {
    expect(isRemoteAddress(host)).toBe(true);
  }
});

test("a loopback URL gets no token, so a broken token file cannot break local use", async () => {
  const broken = { SWARMAIL_TOKEN_FILE: join(dir, "missing") };
  expect(authHeaders({ ...broken, SWARMAIL_URL: "http://127.0.0.1:18765/mcp/" })).toEqual({});
  expect(authHeaders({ ...broken, SWARMAIL_URL: "http://[::1]:18765/mcp/" })).toEqual({});
  expect(authHeaders({ SWARMAIL_TOKEN_FILE: tokenFile }, "http://100.64.0.1:18765/mcp/")).toEqual({
    authorization: `Bearer ${TOKEN}`,
  });
  // For a remote server the token file's own error reaches the user, not "cannot reach Swarmail".
  const failure = await call(
    { ...broken, SWARMAIL_URL: "http://100.64.0.1:18765/mcp/" },
    "ensure_project",
    { human_key: "/remote/project" },
  ).catch((error: Error) => error);
  expect((failure as Error).message).toContain("missing");
});

test("the server will not start on a loopback or wildcard address, or without a token", () => {
  const start = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      main([]);
    } finally {
      process.env = saved;
    }
  };
  for (const host of [
    "127.0.0.1",
    "127.0.0.2",
    "0.0.0.0",
    "::",
    "0:0:0:0:0:0:0:0",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.2",
    "::ffff:100.64.0.1",
    "fe80::1%eth0",
    "localhost",
    "",
  ]) {
    expect(() => start({ SWARMAIL_HOST: host, SWARMAIL_TOKEN_FILE: tokenFile })).toThrow(
      "non-loopback address",
    );
  }
  const noToken = { SWARMAIL_HOST: "100.64.0.1" };
  delete process.env.SWARMAIL_TOKEN_FILE;
  expect(() => start(noToken)).toThrow("needs SWARMAIL_TOKEN_FILE");
});
