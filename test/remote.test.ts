import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, bearerToken, homeDir } from "../src/paths.ts";
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
  expect((await list(url, `bearer ${TOKEN}`)).status).toBe(200);
  expect((await list(url, `BEARER ${TOKEN}`)).status).toBe(200);
  expect((await list(url, `Bearer ${TOKEN.toUpperCase()}`)).status).toBe(401);
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

// callTool blocks on curl, which would block this process's own server, so the client code runs in a child.
async function client(script: string, tokenPath: string, url: string) {
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SWARMAIL_TOKEN_FILE: tokenPath, SWARMAIL_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

test("the register hook's client sends the token and keeps it out of errors", async () => {
  const url = `http://${REMOTE}:${server.port}/mcp/`;
  const script = `
    import { callTool } from "./src/client.ts";
    console.log(JSON.stringify(callTool("ensure_project", { human_key: "/remote/client's \\"project\\"" })));
  `;
  const ok = await client(script, tokenFile, url);
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.out).slug).toBe("remote-client-s-project");
  // A hub that refuses the token makes curl exit nonzero; the error must not echo the token.
  const wrong = join(dir, "wrong");
  writeFileSync(wrong, `${"w".repeat(40)}\n`);
  const refused = await client(script, wrong, url);
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("curl");
  expect(refused.out).not.toContain("w".repeat(40));
});

test("registering with a remote server leaves out the local checkout path", async () => {
  const script = `
    import { serverRegister } from "./src/registry.ts";
    const session = { host: "claude", program: "claude", model: "m", sessionId: "s", cwd: null };
    const register = serverRegister(session, "[claude:s]", undefined, "/checkout/only/on/this/machine");
    console.log(JSON.stringify({ name: register("/remote/project", null), refusal: register.refusal }));
  `;
  const result = await client(script, tokenFile, `http://${REMOTE}:${server.port}/mcp/`);
  const { name, refusal } = JSON.parse(result.out);
  expect(refusal).toBeUndefined();
  expect(name).toBeString();
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

test("a hub with a remote listener keeps a project whose checkout it cannot find", async () => {
  const gone = join(homeDir(), `swarmail-remote-test-${process.pid}`);
  const fresh = (name: string) => {
    const path = join(dir, name);
    // retireIdleDays 0 skips the sweep while the project is set up and aged.
    const setup = createServer(path, 0, { retireIdleDays: 0 });
    return { setup, path };
  };
  const survives = async (name: string, remoteOption?: { hostname: string; token: string }) => {
    const { setup, path } = fresh(name);
    const tools = (...a: [string, object]) =>
      fetch(`http://127.0.0.1:${setup.server.port}/mcp/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: a[0], arguments: a[1] },
        }),
      });
    await tools("register_agent", {
      project_key: gone,
      program: "claude",
      model: "m",
      name: "GoneOwl",
    });
    setup.db.run("UPDATE agents SET last_active_ts = last_active_ts - ?", [2 * 86_400_000_000]);
    await setup.server.stop(true);
    setup.db.close();
    const second = createServer(path, 0, { retireIdleDays: 7, remote: remoteOption });
    try {
      return (
        second.db.query<{ n: number }, []>("SELECT count(*) AS n FROM projects").get()!.n === 1
      );
    } finally {
      await second.server.stop(true);
      await second.remote?.stop(true);
      second.db.close();
    }
  };
  expect(await survives("local.sqlite3")).toBe(false);
  expect(await survives("hub.sqlite3", { hostname: REMOTE, token: TOKEN })).toBe(true);
});
