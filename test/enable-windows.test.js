import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopServer } from "../scripts/enable-windows.ts";
import { processIdentity } from "../src/proc.ts";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops the server its record names, and nothing once that process is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-enable-"));
  dirs.push(dir);
  const record = join(dir, "swarmail-server.json");
  expect(await stopServer(record)).toBe(false); // no record
  writeFileSync(record, "{broken");
  expect(await stopServer(record)).toBe(false);

  const server = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
  try {
    // An earlier process that had this PID: its start time differs.
    writeFileSync(record, JSON.stringify({ ...processIdentity(server.pid), start: "1" }));
    expect(await stopServer(record)).toBe(false);
    expect(server.exitCode).toBeNull();
    writeFileSync(record, JSON.stringify(processIdentity(server.pid)));
    expect(await stopServer(record)).toBe(true);
    // stopServer waits for the exit, so the process has already ended.
    expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    expect(await stopServer(record)).toBe(false);
  } finally {
    server.kill();
  }
});
