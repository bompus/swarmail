import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAlive, hostProcess, processIdentity } from "../src/proc.ts";
import { shortPath, windowsComm } from "../src/proc-win32.ts";

const windows = process.platform === "win32";

test.if(windows)("reads this process, its parent and its start from kernel32", () => {
  const self = processIdentity(process.pid);
  expect(self?.name).toBe("bun");
  expect(self?.start).toMatch(/^\d+$/);
  expect(hostAlive(self)).toBe(true);
  expect(hostAlive({ ...self, start: "1" })).toBe(false);
  expect(processIdentity(process.ppid)?.pid).toBe(process.ppid);
});

test.if(windows)("walks parents to a host and stops at a process that is not one", () => {
  const read = (pid) =>
    ({
      10: { comm: "bun", ppid: 20, start: "3" },
      20: { comm: "claude", ppid: 30, start: "2" },
    })[pid] ?? null;
  expect(hostProcess(10, read)).toEqual({ name: "claude", pid: 20, start: "2" });
});

test.if(windows)("a gone process is not alive", async () => {
  const child = spawn(process.execPath, ["-e", "0"]);
  const id = await new Promise((resolve) =>
    child.on("spawn", () => resolve(processIdentity(child.pid))),
  );
  await new Promise((resolve) => child.on("exit", resolve));
  expect(hostAlive(id)).toBe(false);
});

test.if(windows)("shortens a path with a space to a name a hook shell takes as one word", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-short-"));
  try {
    const spaced = join(dir, "Jane Doe");
    mkdirSync(spaced);
    const short = shortPath(spaced);
    expect(short).not.toContain(" ");
    expect(existsSync(short)).toBe(true);
    expect(shortPath(join(dir, "missing"))).toBe(join(dir, "missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host recorded without a start time never reads as alive", () => {
  const gone = () => null;
  expect(hostAlive({ name: "claude", pid: 4242, start: undefined }, gone)).toBe(false);
  expect(hostAlive({ name: "claude", pid: 4242, start: "7" }, gone)).toBe(false);
  expect(hostAlive({ name: "claude", pid: 4242, start: "7" }, () => ({ start: "7" }))).toBe(true);
});

test("the Cursor CLI's node.exe on Windows reads as cursor-agent, and other Node programs keep their name", () => {
  const cursor = String.raw`C:\Users\Jo\AppData\Local\cursor-agent\versions\2026.10.01-e373342\node.exe`;
  expect(windowsComm("node", () => cursor)).toBe("cursor-agent");
  expect(windowsComm("node", () => String.raw`C:\Program Files\nodejs\node.exe`)).toBe("node");
  expect(windowsComm("node", () => undefined)).toBe("node");
  expect(windowsComm("claude", () => cursor)).toBe("claude");
});
