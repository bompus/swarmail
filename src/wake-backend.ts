// Linux-local preflight. This observes identity; it does not lock T3 against an upgrade.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { t3StatePath } from "./t3-state.ts";
import { BridgeError } from "./wake-target.ts";

export interface Backend {
  url: string;
  /** Without one, the listener's own binary is trusted: same user, holding T3's database open. */
  executable?: string;
  baseDir: string;
  /** Listener pid T3 published; a different owner means the runtime file is stale. */
  pid?: number;
}

/** Nothing owns the T3 port yet, as while T3 restarts. Retrying can succeed. */
export class T3Unavailable extends Error {
  constructor() {
    super("T3 backend unavailable; retrying");
  }
}

/** A caller's shutdown signal and absolute monotonic retry deadline. */
export interface BackendCheck {
  signal?: AbortSignal;
  deadline?: number;
}

/** Never include a caller-supplied abort reason in a diagnostic. */
export function checkBackendOperation(check: BackendCheck = {}): void {
  if (check.signal?.aborted) {
    throw new BridgeError("T3 backend check cancelled");
  }
  if (check.deadline !== undefined && performance.now() >= check.deadline) {
    throw new BridgeError("T3 backend unavailable grace exhausted");
  }
}

export function backendTimeout(maximum: number, check: BackendCheck = {}): number {
  checkBackendOperation(check);
  return Math.max(
    1,
    Math.ceil(Math.min(maximum, (check.deadline ?? Infinity) - performance.now())),
  );
}

const refuse = (): never => {
  throw new BridgeError(
    "T3 backend identity unavailable or differs from configuration; stop the timer and reconcile the upgrade",
  );
};

/**
 * Check the actual listener and its open database before invoking a data-writing CLI. Returns the
 * listener's executable, the `t3` whose CLI matches the running server across upgrades.
 */
export async function verifyT3Backend(config: Backend, check: BackendCheck = {}): Promise<string> {
  checkBackendOperation(check);
  try {
    if (process.platform !== "linux") {
      refuse();
    }
    const url = new URL(config.url);
    const ipv6 = url.hostname === "[::1]";
    const port = url.port || "80";
    const addresses = new Set(ipv6 ? ["[::1]", "[::]", "*"] : ["127.0.0.1", "0.0.0.0", "*"]);
    const child = Bun.spawn(["ss", ipv6 ? "-6" : "-4", "-H", "-ltnp", `sport = :${port}`], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: backendTimeout(5000, check),
      signal: check.signal,
      killSignal: "SIGKILL",
    });
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    checkBackendOperation(check);
    const lines = output.trim().split("\n");
    const pids = new Set<string>();
    for (const line of lines) {
      const local = line.trim().split(/\s+/)[3] ?? "";
      if (!addresses.has(local.slice(0, local.lastIndexOf(":")))) {
        continue;
      }
      const owners = [...line.matchAll(/pid=(\d+),/g)];
      if (!owners.length) {
        refuse();
      }
      for (const owner of owners) {
        pids.add(owner[1]!);
      }
    }
    if (exit !== 0 || pids.size > 1) {
      refuse();
    }
    if (pids.size === 0 || (config.pid !== undefined && !pids.has(String(config.pid)))) {
      throw new T3Unavailable();
    }
    const proc = `/proc/${[...pids][0]}`;
    const started = () => {
      const stat = readFileSync(join(proc, "stat"), "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    };
    const before = started();
    const sameFile = (a: string, b: string) => {
      const first = statSync(a, { bigint: true });
      const second = statSync(b, { bigint: true });
      return first.dev === second.dev && first.ino === second.ino;
    };
    const checkExecutable = () => {
      if (
        statSync(proc).uid !== process.getuid!() ||
        (config.executable !== undefined && !sameFile(join(proc, "exe"), config.executable))
      ) {
        refuse();
      }
    };
    checkExecutable();
    const database = t3StatePath(config.baseDir);
    const openDatabase = readdirSync(join(proc, "fd")).some((fd) => {
      try {
        return sameFile(join(proc, "fd", fd), database);
      } catch {
        return false; // Descriptors may close during the snapshot.
      }
    });
    checkExecutable();
    const executable = realpathSync(join(proc, "exe"));
    if (!before || before !== started() || !openDatabase) {
      refuse();
    }
    return executable;
  } catch (error) {
    checkBackendOperation(check);
    if (error instanceof T3Unavailable) {
      throw error;
    }
    // Never log process arguments, descriptor targets or subprocess output.
    return refuse();
  }
}

/**
 * The listener T3 publishes in `<baseDir>/userdata/server-runtime.json`. Its port can change on
 * every T3 restart. Returns undefined when T3 has not written the file.
 */
export function readT3Runtime(baseDir: string): { url: string; pid: number } | undefined {
  let runtime: { version?: unknown; pid?: unknown; port?: unknown };
  try {
    runtime = JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new T3Unavailable(); // T3 may be rewriting it.
  }
  const { version, pid, port } = runtime;
  if (version !== 1) {
    refuse(); // An unknown format belongs with an upgrade, not a restart.
  }
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  ) {
    throw new T3Unavailable();
  }
  return { url: `http://127.0.0.1:${port}`, pid: pid as number };
}

/**
 * Verify the published T3 listener, or the configured URL when T3 publishes none. Returns its URL
 * and the executable `verifyT3Backend` found.
 */
export async function discoverT3Backend(
  config: Omit<Backend, "url" | "pid"> & { url?: string },
  check: BackendCheck = {},
): Promise<{ url: string; executable: string }> {
  checkBackendOperation(check);
  const runtime = readT3Runtime(config.baseDir);
  const url = runtime?.url ?? config.url;
  if (url === undefined) {
    throw new T3Unavailable();
  }
  return { url, executable: await verifyT3Backend({ ...config, url, pid: runtime?.pid }, check) };
}
