import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "scripts", "glama.ts");
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-glama-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Glama wraps the entry with mcp-proxy, which reads stdout as the MCP stream: any other line breaks the listing.
test("answers on stdout with MCP only and exits when stdin closes", async () => {
  const proc = Bun.spawn([process.execPath, ENTRY], {
    env: { ...process.env, HOME: dir, SWARMAIL_DB: join(dir, "mail.sqlite3"), SWARMAIL_PORT: "0" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  proc.stdin.write(messages.map((m) => JSON.stringify(m) + "\n").join(""));
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const lines = out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines.map((m) => m.id)).toEqual([1, 2]);
  expect(lines[0].result.serverInfo.name).toBe("swarmail");
  expect(lines[1].result.tools.some((t) => t.name === "send_message")).toBe(true);
});
