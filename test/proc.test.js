import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { hostAlive, hostProcess, processIdentity } from "../src/proc.ts";

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
