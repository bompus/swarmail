import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portTaken, savedEnv, stopServer } from "../scripts/enable-windows.ts";
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
    // stopServer returns once the process is gone; Bun reports the exit on a later turn of the event loop.
    await server.exited;
    expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    expect(await stopServer(record)).toBe(false);
  } finally {
    server.kill();
  }
});

test.if(process.platform === "win32")(
  "reads a variable from the saved environment the task gets",
  () => {
    expect(savedEnv("SWARMAIL_TEST_NEVER_SET")).toBe("");
    // Windows keeps TEMP among the user's saved variables.
    expect(savedEnv("TEMP")).not.toBe("");
  },
);

test("sees a port as taken whatever answers on it, and free once nothing listens", async () => {
  // Not a Swarmail server: anything listening blocks the task's server from binding.
  const other = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = other;
  expect(await portTaken(port)).toBe(true);
  other.stop(true);
  expect(await portTaken(port)).toBe(false);
});
