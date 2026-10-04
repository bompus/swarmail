// Process identity from /proc, or kernel32 on Windows (proc-win32.ts): a PID plus its start time, so a reused PID
// never matches an old process.
import { readFileSync } from "node:fs";
import { readWindowsProcess } from "./proc-win32.ts";

/** The agent host process: its command name, PID and start time. */
export interface HostProcess {
  name: string;
  pid: number;
  start: string | undefined;
}

interface ProcStat {
  comm: string;
  ppid: number;
  start: string | undefined;
}

const HOST_COMM = /^(claude|codex|opencode|devin|cursor-agent|grok|agy|antigravity)/i;

/** `/proc/<pid>/stat`: the command name, parent and start time (clock ticks since boot). */
function readProcStat(pid: number): ProcStat | null {
  if (process.platform === "win32") {
    return readWindowsProcess(pid);
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 2).split(" ");
    return {
      comm: raw.slice(raw.indexOf("(") + 1, close),
      ppid: Number(fields[1]),
      start: fields[19],
    };
  } catch {
    return null;
  }
}

/**
 * The agent host process above this hook, found by walking parents to a known host binary.
 * Its PID and start time let a process started by the same session (a room boot, say) find
 * this session's state by its own ancestry, on hosts that put no session id in the shell
 * (OpenCode, Devin). The start time keeps a reused PID from matching an old session.
 */
export function hostProcess(pid = process.ppid, read = readProcStat): HostProcess | null {
  for (let hop = 0; pid > 1 && hop < 16; hop++) {
    const stat = read(pid);
    if (!stat) {
      return null;
    }
    if (HOST_COMM.test(stat.comm)) {
      return { name: stat.comm, pid, start: stat.start };
    }
    pid = stat.ppid;
  }
  return null;
}

/** Identity of one exact process, including Bun/Swarmail children rather than only agent hosts. */
export function processIdentity(pid: number): HostProcess | null {
  const stat = readProcStat(pid);
  return stat ? { name: stat.comm, pid, start: stat.start } : null;
}

/** Whether a recorded host process is still the same running process. */
export function hostAlive(host: HostProcess | null | undefined, read = readProcStat): boolean {
  // A start time that could not be read cannot tell this process from a later one with its PID.
  if (!host?.pid || host.start === undefined) {
    return false;
  }
  return read(host.pid)?.start === host.start;
}

export const sameHost = (a?: HostProcess | null, b?: HostProcess | null) =>
  (a?.pid ?? null) === (b?.pid ?? null) && (a?.start ?? null) === (b?.start ?? null);
