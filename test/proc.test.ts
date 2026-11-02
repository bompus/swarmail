import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAlive, hostProcess, isPrintMode, processIdentity } from "../src/proc.ts";
import { shortPath, windowsComm } from "../src/proc-win32.ts";

const windows = process.platform === "win32";

test.if(windows)("reads this process, its parent and its start from kernel32", () => {
  const self = processIdentity(process.pid);
  expect(self?.name).toBe("bun");
  expect(self?.start).toMatch(/^\d+$/);
  expect(hostAlive(self)).toBe(true);
  if (!self) {
    throw new Error("no identity for this process");
  }
  expect(hostAlive({ ...self, start: "1" })).toBe(false);
  expect(processIdentity(process.ppid)?.pid).toBe(process.ppid);
});

test.if(windows)("walks parents to a host and stops at a process that is not one", () => {
  const table: Record<number, { comm: string; ppid: number; start: string }> = {
    10: { comm: "bun", ppid: 20, start: "3" },
    20: { comm: "claude", ppid: 30, start: "2" },
  };
  const read = (pid: number) => table[pid] ?? null;
  expect(hostProcess(10, read)).toEqual({ name: "claude", pid: 20, start: "2" });
});

test.if(windows)("a gone process is not alive while its parent still holds it", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  // Past the process-table cache, so the child is in the table read below and still in it after it exits.
  await Bun.sleep(600);
  const id = processIdentity(child.pid!);
  expect(hostAlive(id)).toBe(true);
  child.kill();
  await once(child, "exit");
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
  expect(
    hostAlive({ name: "claude", pid: 4242, start: "7" }, () => ({
      comm: "claude",
      ppid: 1,
      start: "7",
    })),
  ).toBe(true);
});

test("the Cursor CLI's node.exe on Windows reads as cursor-agent, and other Node programs keep their name", () => {
  const cursor = String.raw`C:\Users\Jo\AppData\Local\cursor-agent\versions\2026.10.01-e373342\node.exe`;
  expect(windowsComm("node", () => cursor)).toBe("cursor-agent");
  expect(windowsComm("node", () => String.raw`C:\Program Files\nodejs\node.exe`)).toBe("node");
  expect(windowsComm("node", () => undefined)).toBe("node");
  expect(windowsComm("claude", () => cursor)).toBe("claude");
});

const claude = { name: "claude", pid: 20, start: "2" };
const argv =
  (...args: string[]) =>
  () => ["/home/u/.local/bin/claude", ...args];

test("a Claude host run with a print-mode flag is a one-shot run", () => {
  for (const flag of ["-p", "--print", "--no-session-persistence"]) {
    expect(isPrintMode(claude, argv("--model", "haiku", flag, "say ok"))).toBe(true);
  }
});

test("an interactive host is not a print-mode run, whatever its values look like", () => {
  const interactive = argv(
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--resume=-p",
    "--allowedTools",
    "mcp__t3-code__*",
  );
  expect(isPrintMode(claude, interactive)).toBe(false);
  // A flag must be a whole argument, not part of another one.
  expect(isPrintMode(claude, argv("--print-timing", "-pc", "x-p"))).toBe(false);
  // Text after `--` or after a text option is data.
  expect(isPrintMode(claude, argv("--", "--print"))).toBe(false);
  expect(isPrintMode(claude, argv("--system-prompt", "--print"))).toBe(false);
  expect(isPrintMode(claude, argv("--append-system-prompt", "-p", "--verbose"))).toBe(false);
  // A flag before either still counts.
  expect(isPrintMode(claude, argv("-p", "--system-prompt", "x"))).toBe(true);
  expect(isPrintMode(claude, argv("--system-prompt", "x", "--print"))).toBe(true);
});

test("an unreadable command line, or no host, is not reported as a print-mode run", () => {
  expect(isPrintMode(claude, () => null)).toBe(false);
  expect(isPrintMode(claude, () => [])).toBe(false);
  expect(isPrintMode(null, argv("-p"))).toBe(false);
});

test.skipIf(windows)("reads this process's own command line from /proc", () => {
  expect(isPrintMode({ name: "bun", pid: process.pid, start: undefined })).toBe(
    process.argv.includes("-p") || process.argv.includes("--print"),
  );
});
