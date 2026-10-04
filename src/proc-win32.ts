// The Windows process table through kernel32, in place of /proc: one Toolhelp snapshot gives every process's name
// and parent, and GetProcessTimes gives a process's start. The snapshot is cached briefly, because a parent walk
// reads several processes and a hook runs it on every tool call.
import { dlopen, FFIType } from "bun:ffi";

const SNAPPROCESS = 0x2;
const QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE = 0xffffffffffffffffn;
// sizeof(PROCESSENTRY32W) on 64-bit Windows, and the offsets of the fields read from it.
const ENTRY_SIZE = 568;
const PID_AT = 8;
const PARENT_AT = 32;
const NAME_AT = 44;
const SNAPSHOT_MS = 500;

const symbols = {
  CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
  Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
  GetProcessTimes: {
    args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
} as const;

let kernel32: ReturnType<typeof dlopen<typeof symbols>>["symbols"] | null = null;
const lib = () => (kernel32 ??= dlopen("kernel32.dll", symbols).symbols);

interface Entry {
  name: string;
  ppid: number;
}

let cached: { at: number; table: Map<number, Entry> } | null = null;

/** Every running process by PID: its executable name without `.exe`, and its parent's PID. */
function processTable(): Map<number, Entry> {
  if (cached && performance.now() - cached.at < SNAPSHOT_MS) {
    return cached.table;
  }
  const k = lib();
  const table = new Map<number, Entry>();
  const snap = k.CreateToolhelp32Snapshot(SNAPPROCESS, 0);
  if (snap !== INVALID_HANDLE) {
    const entry = new Uint8Array(ENTRY_SIZE);
    const view = new DataView(entry.buffer);
    view.setUint32(0, ENTRY_SIZE, true);
    try {
      for (let ok = k.Process32FirstW(snap, entry); ok; ok = k.Process32NextW(snap, entry)) {
        const name = new TextDecoder("utf-16le")
          .decode(entry.subarray(NAME_AT, ENTRY_SIZE))
          .split("\0")[0]!;
        table.set(view.getUint32(PID_AT, true), {
          name: name.replace(/\.exe$/i, ""),
          ppid: view.getUint32(PARENT_AT, true),
        });
      }
    } finally {
      k.CloseHandle(snap);
    }
  }
  cached = { at: performance.now(), table };
  return table;
}

/** A process's creation time in 100 ns units since 1601, or undefined when it is gone or not readable. */
function startTime(pid: number): string | undefined {
  const k = lib();
  const handle = k.OpenProcess(QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) {
    return undefined;
  }
  const times = new BigUint64Array(4);
  try {
    const ok = k.GetProcessTimes(
      handle,
      times.subarray(0, 1),
      times.subarray(1, 2),
      times.subarray(2, 3),
      times.subarray(3, 4),
    );
    return ok ? String(times[0]) : undefined;
  } finally {
    k.CloseHandle(handle);
  }
}

/**
 * One process's name, parent and start, in the shape proc.ts reads from /proc. Windows does not reparent orphans,
 * so a parent PID can name a newer process that reused it; a parent that started after its child reads as none.
 */
export function readWindowsProcess(
  pid: number,
): { comm: string; ppid: number; start: string | undefined } | null {
  const entry = processTable().get(pid);
  if (!entry) {
    return null;
  }
  const start = startTime(pid);
  const parentStart = entry.ppid ? startTime(entry.ppid) : undefined;
  const reused =
    start !== undefined && parentStart !== undefined && BigInt(parentStart) > BigInt(start);
  return { comm: entry.name, ppid: reused ? 0 : entry.ppid, start };
}

/**
 * The 8.3 form of an existing path, or the path unchanged when the volume keeps no short names. Every component
 * that is not already a valid short name is shortened, a leading-dot `.local` included.
 */
export function shortPath(path: string): string {
  const wide = (text: string) => new Uint8Array(Buffer.from(text + "\0", "utf16le"));
  const out = new Uint8Array(2 * 32_768);
  const length = lib().GetShortPathNameW(wide(path), out, out.length / 2);
  return length > 0 && length < out.length / 2
    ? Buffer.from(out.subarray(0, length * 2)).toString("utf16le")
    : path;
}
