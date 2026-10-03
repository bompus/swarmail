// The wake hook, `swarmail hook wake <claude|cursor> [seconds]`: long-polls the server's /wait for mail to the agents
// registered under this session (wake.ts), then wakes the session with a one-line hint naming recipients and senders.
//   claude: Stop hook with "asyncRewake": true; exit 2 with the hint on stderr starts a turn. The same hook on
//     PostToolUse re-arms the wait mid-turn after a hint used it up; exit 2 there queues the hint into the running turn.
//     While it waits, $XDG_STATE_HOME/swarmail-wake/<session> holds its PID, so the PostToolUse command can skip
//     starting a second waiter from the shell.
//   cursor: stop hook in hooks.json; a {"followup_message": ...} reply starts a turn, {} otherwise.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openRegistry, registryDir } from "./registry.ts";

interface Proc {
  ppid: number;
  args: string[];
}

/** Parent and argv of a process: /proc on Linux, one `ps` or PowerShell snapshot of the process table elsewhere. */
export function processReader(platform = process.platform): (pid: number) => Proc | null {
  if (platform === "linux") {
    return (pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return {
          ppid,
          args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
        };
      } catch {
        return null;
      }
    };
  }
  let table: Map<number, Proc> | null = null;
  return (pid) => {
    if (!table) {
      const cmd =
        platform === "win32"
          ? [
              "powershell",
              "-NoProfile",
              "-Command",
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
            ]
          : ["ps", "-A", "-o", "pid=,ppid=,args="];
      const out =
        (spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .stdout as string | null) ?? "";
      table = new Map();
      for (const line of out.split(/\r?\n/)) {
        const [pid, ppid, ...args] = line.trim().split(/\s+/);
        if (pid && ppid) {
          table.set(Number(pid), { ppid: Number(ppid), args });
        }
      }
    }
    return table.get(pid) ?? null;
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The PID of the Claude session to wait for, or null when this hook should not wait. */
const stateDir = (env: NodeJS.ProcessEnv) =>
  env.XDG_STATE_HOME || join(homedir(), ".local", "state");

function claudeAgent(
  sid: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  read: ReturnType<typeof processReader>,
): number | null {
  // Wait only in a registered Claude session that is not `-p` and is this hook's
  // ancestor, since Devin, Grok and Cursor also run Claude's hooks and can inherit CLAUDE_PID.
  const claude = Number(env.CLAUDE_PID);
  if (
    !claude ||
    !sid ||
    !/[\\/]\.claude[\\/]projects[\\/]/.test(String(payload.transcript_path ?? ""))
  ) {
    return null;
  }
  for (let pid = process.pid; pid !== claude;) {
    pid = read(pid)?.ppid ?? 0;
    if (pid <= 1) {
      return null;
    }
  }
  if (read(claude)?.args.some((arg) => arg === "-p" || arg === "--print")) {
    return null;
  }
  const registration = openRegistry(registryDir(env)).read(sid);
  if (!registration || registration.ended) {
    return null;
  }
  return claude;
}

function readPid(path: string): number {
  try {
    return Number(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
}

/**
 * How long each host's hook waits after a turn. Claude cancels an asyncRewake hook at its settings timeout, which the
 * installer sets 100 s above this; about 23 days keeps that timeout under the 2^31 ms a JavaScript timer holds.
 */
export const WAKE_SECONDS = { claude: 1_999_900, cursor: 28_800 };
// The server ends each /wait after at most a day (server.ts), so a longer hook waits again.
const MAX_WAIT = 86_400;

export async function wakeHook(
  host: string | undefined,
  seconds?: number,
  input = "",
  env = process.env,
): Promise<number> {
  const key = host === "claude" ? "session_id" : host === "cursor" ? "conversation_id" : null;
  if (!key) {
    console.error("usage: swarmail hook wake <claude|cursor> [seconds]");
    return 0;
  }
  const quiet = () => {
    if (host === "cursor") {
      console.log("{}");
    }
    return 0;
  };
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(input);
  } catch {
    // No payload: no session.
  }
  const sid = typeof payload[key] === "string" && /^[\w-]+$/.test(payload[key]) ? payload[key] : "";
  const read = processReader();
  let agent: number;
  let pidFile = "";
  if (host === "claude") {
    const claude = claudeAgent(sid, payload, env, read);
    if (claude === null) {
      return 0;
    }
    agent = claude;
    pidFile = join(stateDir(env), "swarmail-wake", sid);
    mkdirSync(join(stateDir(env), "swarmail-wake"), { recursive: true });
    writeFileSync(pidFile, `${process.pid}\n`);
  } else {
    if (!sid) {
      return quiet();
    }
    // Cursor runs the hook under a shell of its own and, on quit, leaves it running.
    agent = read(process.ppid)?.ppid || process.ppid;
  }

  const base = env.SWARMAIL_WAKE_URL || "http://127.0.0.1:18765";
  const end =
    Date.now() + (seconds ?? WAKE_SECONDS[host === "claude" ? "claude" : "cursor"]) * 1000;
  let request = new AbortController();
  // Checking the host in-process costs nothing, so one wait covers the whole timeout instead of chunks.
  const watch = setInterval(
    () => {
      if (!alive(agent)) {
        request.abort();
      }
    },
    Number(env.SWARMAIL_WAKE_CHUNK || 5) * 1000,
  );
  let hint = "";
  let retry = "";
  try {
    // Only the watcher aborts `request`, so an aborted one means the host has gone.
    while (!request.signal.aborted && end - Date.now() >= 1000) {
      const left = Math.min(Math.floor((end - Date.now()) / 1000), MAX_WAIT);
      request = new AbortController();
      try {
        // The wait itself has no connect timeout, and a closed port can hang instead of refusing (WSL's mirrored
        // networking does), so a quick health check stands in for curl's --connect-timeout.
        const health = await fetch(`${base}/healthz`, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(2000)]),
        });
        if (!health.ok) {
          throw new Error(`healthz ${health.status}`);
        }
        const res = await fetch(`${base}/wait?session=${sid}&timeout=${left}${retry}`, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout((left + 5) * 1000)]),
        });
        retry = "";
        // 200 carries the hint, and an HTTP error (409: a newer wait replaced this one) ends the hook too.
        // 204 ends one wait; the loop waits again until the hook's own time is up.
        if (res.status === 200) {
          hint = (await res.text()).trim();
        }
        if (res.status !== 204) {
          break;
        }
      } catch {
        if (request.signal.aborted) {
          break;
        }
        // A server restart or dropped connection: wait again with `retry`, so a hint sent but lost comes again.
        retry = "&retry=1";
        await Bun.sleep(3000);
      }
    }
  } finally {
    clearInterval(watch);
    // A newer waiter that replaced this one owns the file now.
    if (pidFile && readPid(pidFile) === process.pid) {
      rmSync(pidFile, { force: true });
    }
  }
  if (!hint) {
    return quiet();
  }
  if (host === "claude") {
    console.error(hint);
    return 2;
  }
  console.log(JSON.stringify({ followup_message: hint }));
  return 0;
}
