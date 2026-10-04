import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";

const RELAY = join(import.meta.dir, "..", "packages", "mcp-relay", "index.mjs");
let dir, server, db;

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-relay-")));
  ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
});
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Runs the relay under Node, as `npx` would, and returns its stdout lines parsed.
async function relay(url, messages) {
  const proc = Bun.spawn(["node", RELAY], {
    env: { ...process.env, SWARMAIL_URL: url },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(messages.map((m) => JSON.stringify(m) + "\n").join(""));
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("relays requests in order and drops notifications", async () => {
  const out = await relay(`http://127.0.0.1:${server.port}/mcp/`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "health_check", arguments: {} },
    },
  ]);
  expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
  expect(out[0].result.serverInfo.name).toBe("swarmail");
  expect(out[1].result.tools.some((t) => t.name === "send_message")).toBe(true);
  expect(out[2].result.isError).toBeUndefined();
});

test("keeps relaying after an answer breaks off mid-body", async () => {
  let calls = 0;
  const flaky = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (++calls === 1) {
        const body = new ReadableStream({
          // The headers and first chunk go out before the stream fails.
          start(c) {
            c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
            setTimeout(() => c.error(new Error("dropped")), 50);
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      return Response.json({ jsonrpc: "2.0", id: 2, result: {} });
    },
  });
  try {
    const out = await relay(`http://127.0.0.1:${flaky.port}/mcp/`, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[0].error.message).toContain("did not finish");
    expect(out[1].result).toEqual({});
  } finally {
    flaky.stop(true);
  }
});

test("answers each request with an error when the server is down", async () => {
  const down = createServer(join(dir, "down.sqlite3"), 0);
  const url = `http://127.0.0.1:${down.server.port}/mcp/`;
  down.server.stop(true);
  down.db.close();
  const out = await relay(url, [
    { jsonrpc: "2.0", id: 7, method: "tools/list" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe(7);
  expect(out[0].error.message).toContain("not reachable");
  expect(out[0].error.message).toContain("#install");
});
