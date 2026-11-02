// Linux-local preflight. This observes identity; it does not lock T3 against an upgrade.
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * The listener's identity cannot be verified yet, as while T3 updates itself: its process is not visible, two
 * processes share the port, it has not opened its database, or it exited during the check. A caller may wait and
 * check again; `giveUp()` raises the refusal to fail with once it has waited long enough. Nothing is sent to the
 * listener meanwhile. A verified different identity is never pending.
 */
export class T3IdentityPending extends T3Unavailable {
  readonly giveUp: () => never;
  constructor(why: string) {
    super();
    this.message = `T3 backend identity not yet verifiable (${why}); retrying`;
    this.giveUp = refuse;
  }
}

/** A caller's shutdown signal and absolute monotonic retry deadline. */
export interface BackendCheck {
  signal?: AbortSignal;
  deadline?: number;
  /**
   * Opt in to waiting out a restarting T3: a session check that gets an HTTP error, or in the locked renewal path a
   * measured connection failure, throws `T3SessionRetry` instead of failing. The caller polls again and decides when
   * to give up.
   */
  retry?: boolean;
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
    if (exit !== 0) {
      refuse(); // A failing `ss` proves nothing about the listener, whatever it printed.
    }
    const lines = output.trim().split("\n");
    const pids = new Set<string>();
    for (const line of lines) {
      const local = line.trim().split(/\s+/)[3] ?? "";
      if (!addresses.has(local.slice(0, local.lastIndexOf(":")))) {
        continue;
      }
      const owners = [...line.matchAll(/pid=(\d+),/g)];
      if (!owners.length) {
        throw new T3IdentityPending("listening process not visible");
      }
      for (const owner of owners) {
        pids.add(owner[1]!);
      }
    }
    if (pids.size > 1) {
      throw new T3IdentityPending("more than one process is listening");
    }
    if (pids.size === 0 || (config.pid !== undefined && !pids.has(String(config.pid)))) {
      throw new T3Unavailable();
    }
    const proc = `/proc/${[...pids][0]}`;
    // The listener may exit while it is read, as when T3 restarts: a vanished entry is pending, not a mismatch.
    const live = <T>(read: () => T): T => {
      try {
        return read();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") {
          throw new T3IdentityPending("the listening process exited");
        }
        throw error;
      }
    };
    const started = () => {
      const stat = live(() => readFileSync(join(proc, "stat"), "utf8"));
      return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    };
    const before = started();
    const sameFile = (a: string, b: string) => {
      const first = statSync(a, { bigint: true });
      const second = statSync(b, { bigint: true });
      return first.dev === second.dev && first.ino === second.ino;
    };
    const checkExecutable = () => {
      if (live(() => statSync(proc).uid) !== process.getuid!()) {
        refuse();
      }
      if (config.executable !== undefined) {
        const running = live(() => statSync(join(proc, "exe"), { bigint: true }));
        const wanted = statSync(config.executable, { bigint: true }); // Missing: a mismatch.
        if (running.dev !== wanted.dev || running.ino !== wanted.ino) {
          refuse();
        }
      }
    };
    checkExecutable();
    const database = t3StatePath(config.baseDir);
    // A listener that holds another database file named like T3's in T3's data directory is a different store; one
    // that holds none is not up yet.
    const others: string[] = [];
    const openDatabase = live(() => readdirSync(join(proc, "fd"))).some((fd) => {
      try {
        const link = join(proc, "fd", fd);
        if (sameFile(link, database)) {
          return true;
        }
        const target = readlinkSync(link);
        if (
          basename(target).startsWith(basename(database)) &&
          dirname(target) === realpathSync(dirname(database))
        ) {
          others.push(target);
        }
      } catch {
        // Descriptors may close during the snapshot, and the database file may not exist.
      }
      return false;
    });
    checkExecutable();
    const executable = live(() => realpathSync(join(proc, "exe")));
    if (!before || before !== started()) {
      throw new T3IdentityPending("the listening process changed");
    }
    if (!openDatabase) {
      let databaseExists = true;
      try {
        statSync(database);
      } catch {
        databaseExists = false;
      }
      if (others.length > 0 || !databaseExists) {
        refuse();
      }
      throw new T3IdentityPending("its database is not open yet");
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
