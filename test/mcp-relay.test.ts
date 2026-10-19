import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
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
  expect(typeof out[0].result.instructions).toBe("string");
  expect(out[0].result.instructions.trim().length).toBeGreaterThan(0);
  expect(out[1].result.tools.some((t) => t.name === "send_message")).toBe(true);
  expect(out[2].result.isError).toBeUndefined();
});

test("keeps relaying after an answer breaks off mid-body", async () => {
  let calls = 0;
  // A raw socket, so the first answer's headers promise more body than it sends before closing.
  const flaky = createNetServer((socket) => {
    socket.once("data", () => {
      const body = ++calls === 1 ? "" : JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
      const length = body ? Buffer.byteLength(body) : 100;
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n" +
          `content-length: ${length}\r\n\r\n${body || '{"jsonrpc":"2.0",'}`,
      );
    });
  });
  await new Promise((resolve) => flaky.listen(0, "127.0.0.1", resolve));
  try {
    const out = await relay(`http://127.0.0.1:${flaky.address().port}/mcp/`, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[0].error.message).toContain("did not finish");
    expect(out[1].result).toEqual({});
  } finally {
    flaky.close();
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

const initialize = (id, protocolVersion) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion },
});
const toolCall = (id, name, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const toolValue = (answer) => JSON.parse(answer.result.content[0].text);

test("three independent Node clients preserve modern, legacy and absent-version delivery across reconnect", async () => {
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  const project_key = "/project/relay-contract";
  const other = "/project/relay-other";
  const register = (id, name, project = project_key) =>
    toolCall(id, "register_agent", {
      project_key: project,
      name,
      program: "fixture",
      model: "fixture",
    });
  const [sender, receiver, observer] = await Promise.all([
    relay(url, [
      initialize(1, "2025-06-18"),
      register(2, "RelaySender"),
      register(3, "RelaySender", other),
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ]),
    relay(url, [
      initialize(1, "2024-11-05"),
      register(2, "RelayReceiver"),
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]),
    relay(url, [register(1, "RelayObserver"), { jsonrpc: "2.0", id: 2, method: "tools/list" }]),
  ]);
  expect(
    sender.at(-1).result.tools.find((t) => t.name === "send_message").outputSchema,
  ).toBeDefined();
  for (const client of [receiver, observer]) {
    expect(client.at(-1).result.tools.every((t) => !t.outputSchema)).toBe(true);
  }
  const args = {
    project_key,
    sender_name: "RelaySender",
    to: ["RelayReceiver"],
    subject: "Handoff",
    body_md: "Persist through reconnect",
    ack_required: true,
    idempotency_key: "relay-reconnect",
  };
  const sent = (
    await relay(url, [initialize(1, "2025-11-25"), toolCall(2, "send_message", args)])
  )[1];
  const message_id = toolValue(sent).id;
  expect(sent.result.structuredContent).toEqual(toolValue(sent));
  const read = await relay(url, [
    initialize(1, "2024-11-05"),
    toolCall(2, "fetch_inbox", { project_key, agent_name: "RelayReceiver", include_bodies: true }),
  ]);
  expect(toolValue(read[1]).find((m) => m.id === message_id).body_md).toBe(
    "Persist through reconnect",
  );
  expect(read[1].result.structuredContent).toBeUndefined();
  const beforeAck = await relay(url, [
    toolCall(1, "get_message_delivery_receipt", { project_key, message_id }),
    toolCall(2, "get_message_delivery_receipt", { project_key: other, message_id }),
  ]);
  expect(toolValue(beforeAck[0]).recipients[0]).toMatchObject({
    acknowledged: false,
    acknowledged_at: null,
  });
  expect(toolValue(beforeAck[1]).error.type).toBe("NOT_FOUND");
  const ack = await relay(url, [
    initialize(1, "2024-11-05"),
    toolCall(2, "acknowledge_message", { project_key, agent_name: "RelayReceiver", message_id }),
  ]);
  expect(toolValue(ack[1]).acknowledged).toBe(true);
  const replay = await relay(url, [
    initialize(1, "2025-06-18"),
    toolCall(2, "send_message", args),
    toolCall(3, "get_message_delivery_receipt", { project_key, message_id }),
  ]);
  expect(replay[1].result.structuredContent).toMatchObject({
    id: message_id,
    idempotent_replay: true,
  });
  expect(replay[2].result.structuredContent.recipients[0]).toMatchObject({ acknowledged: true });
  expect(db.query("SELECT count(*) AS n FROM messages WHERE subject = 'Handoff'").get().n).toBe(1);
});

test("only a successful matching initialize changes the forwarded protocol", async () => {
  const headers = [];
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      headers.push(req.headers.get("MCP-Protocol-Version"));
      const msg = await req.json();
      if (msg.method !== "initialize") {
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      const requested = msg.params.protocolVersion;
      if (requested === "error") {
        return Response.json({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "rejected" },
        });
      }
      if (requested === "wrong-id") {
        return Response.json({ jsonrpc: "2.0", id: -1, result: { protocolVersion: "2024-11-05" } });
      }
      if (requested === "invalid") {
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 42 } });
      }
      if (requested === "http-error") {
        return Response.json(
          { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } },
          { status: 500 },
        );
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: requested } });
    },
  });
  try {
    const messages = [initialize(1, "2025-06-18")];
    let id = 1;
    for (const event of ["error", "wrong-id", "invalid", "http-error", "2024-11-05"]) {
      messages.push(initialize(++id, event), { jsonrpc: "2.0", id: ++id, method: "ping" });
    }
    await relay(`http://127.0.0.1:${fixture.port}/mcp/`, messages);
    expect(headers).toEqual([null, ...Array(9).fill("2025-06-18"), "2024-11-05"]);
  } finally {
    fixture.stop(true);
  }
});
