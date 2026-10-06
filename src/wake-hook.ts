// The wake hook, `swarmail hook wake <claude|cursor> [seconds]`: long-polls the server's /wait for mail to the agents
// registered under this session (wake.ts), then wakes the session with a one-line hint naming recipients and senders.
//   claude: Stop hook with "asyncRewake": true; exit 2 with the hint on stderr starts a turn. The same hook on
//     PostToolUse re-arms the wait mid-turn after a hint used it up; exit 2 there queues the hint into the running turn.
//     While it waits, $XDG_STATE_HOME/swarmail-wake/<session> holds its PID and, on the next line, its start time,
//     so the PostToolUse command can skip starting a second waiter.
//     A session that runs the Swarmail mod (claude-wake-mod.js) has SWARMAIL_WAKE_MOD=1, and the hook exits at once.
//   cursor: stop hook in hooks.json; a {"followup_message": ...} reply starts a turn, {} otherwise.
// `swarmail hook rearm` is the PostToolUse re-arm for hosts with no POSIX shell (Windows): the checks the Linux
// installer writes as shell, then the Claude wait.
import { ensureWakeEligible } from "./wake-lifecycle.ts";
import { openHookDelivery } from "./hook-delivery.ts";
import { updateHint } from "./updates.ts";
import { SESSION_RE } from "./wake.ts";
import { stateHome, wakeUrl } from "./paths.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostAlive, processIdentity, type HostProcess } from "./proc.ts";
import { readWindowsProcess } from "./proc-win32.ts";
import { openRegistry, registryDir } from "./registry.ts";

interface Proc {
  ppid: number;
  args: string[];
}

/**
 * Parent and argv of a process: /proc on Linux; kernel32 for the parent on Windows, with the command line asked of
 * PowerShell (about 440 ms) only when read; one `ps` snapshot of the process table elsewhere.
 */
export function processReader(platform = process.platform): (pid: number) => Proc | null {
  if (platform === "win32") {
    return (pid) => {
      const entry = readWindowsProcess(pid);
      if (!entry) {
        return null;
      }
      return {
        ppid: entry.ppid,
        get args() {
          const out = spawnSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
          ).stdout as string | null;
          return (out ?? "").trim().split(/\s+/);
        },
      };
    };
  }
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
      const cmd = ["ps", "-A", "-o", "pid=,ppid=,args="];
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

/**
 * Whether the host is still running: the same process by start time where it can be read, else its PID. PID 1 or
 * below means the hook was orphaned (reparented to init), so the host has gone.
 */
function liveCheck(pid: number): () => boolean {
  if (pid <= 1) {
    return () => false;
  }
  const host: HostProcess | null = processIdentity(pid);
  if (host?.start !== undefined) {
    return () => hostAlive(host);
  }
  return () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
}

/** The PID of the Claude session to wait for, or null when this hook should not wait. */
const stateDir = stateHome;

function claudeAgent(
  sid: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  read: ReturnType<typeof processReader>,
): number | null {
  // Wait only in a registered Claude session that is not `-p`, has no Swarmail mod waiting, and is this hook's
  // ancestor, since Devin, Grok and Cursor also run Claude's hooks and can inherit CLAUDE_PID.
  const claude = Number(env.CLAUDE_PID);
  if (
    env.SWARMAIL_WAKE_MOD === "1" ||
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

/** The waiter a PID file names: its PID, and its start time when recorded. */
function readWaiter(path: string): { pid: number; start: string | undefined } {
  try {
    const [pid, start] = readFileSync(path, "utf8").split("\n");
    return { pid: Number(pid) || 0, start: start || undefined };
  } catch {
    return { pid: 0, start: undefined };
  }
}

/**
 * How long each host's hook waits after a turn. Claude cancels an asyncRewake hook at its settings timeout, which the
 * installer sets 100 s above this; about 23 days keeps that timeout under the 2^31 ms a JavaScript timer holds.
 */
export const WAKE_SECONDS = { claude: 1_999_900, cursor: 28_800 };
// The server ends each /wait after at most a day (server.ts), so a longer hook waits again.
const MAX_WAIT = 86_400;

function quietWake(host: string | undefined): number {
  if (host === "cursor") {
    console.log("{}");
  }
  return 0;
}

async function receiveHint(
  response: Response,
  base: string,
  sid: string,
  signal: AbortSignal,
  delivery?: ReturnType<typeof openHookDelivery>,
): Promise<string> {
  const guard = () => ensureWakeEligible(base, sid, signal);
  if (delivery) {
    return delivery.receive(response, guard);
  }
  const hint = (await response.text()).trim();
  await guard();
  return hint;
}

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
  const quiet = () => quietWake(host);
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
    writeFileSync(pidFile, `${process.pid}\n${processIdentity(process.pid)?.start ?? ""}\n`);
  } else {
    if (!sid) {
      return quiet();
    }
    // Cursor runs the hook under a shell of its own and, on quit, leaves it running.
    agent = read(process.ppid)?.ppid || process.ppid;
  }

  const base = wakeUrl(env);
  const end =
    Date.now() + (seconds ?? WAKE_SECONDS[host === "claude" ? "claude" : "cursor"]) * 1000;
  let request = new AbortController();
  // Checking the host in-process costs nothing, so one wait covers the whole timeout instead of chunks.
  const alive = liveCheck(agent);
  const watch = setInterval(
    () => alive() || request.abort(),
    Number(env.SWARMAIL_WAKE_CHUNK || 5) * 1000,
  );
  let hint = "";
  let retry = "";
  let delivery: ReturnType<typeof openHookDelivery> | undefined;
  try {
    if (host === "cursor") {
      delivery = openHookDelivery(sid, env);
    }
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
        const res = await fetch(
          `${base}/wait?session=${sid}&timeout=${left}${delivery?.query() ?? retry}`,
          {
            signal: AbortSignal.any([request.signal, AbortSignal.timeout((left + 5) * 1000)]),
          },
        );
        retry = "";
        // 200 carries the hint, and an HTTP error (409: a newer wait replaced this one) ends the hook too.
        // 204 ends one wait; the loop waits again until the hook's own time is up.
        if (res.status === 200) {
          hint = await receiveHint(res, base, sid, request.signal, delivery);
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
    delivery?.close();
    // A newer waiter that replaced this one owns the file now.
    if (pidFile && readWaiter(pidFile).pid === process.pid) {
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

/**
 * Whether the recorded waiter still runs: the same process by start time. A file with no start time counts by its
 * PID alone, except on Windows, which soon gives a PID to another process.
 */
function waiterAlive({ pid, start }: { pid: number; start: string | undefined }): boolean {
  if (!pid) {
    return false;
  }
  if (start !== undefined) {
    return hostAlive({ name: "", pid, start });
  }
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The PostToolUse re-arm without a shell: waits only in a registered Claude session with no Swarmail mod and no
 * live waiter, the same checks the Linux installer writes as shell around `hook wake claude`.
 */
export async function rearmHook(input = "", env = process.env): Promise<number> {
  const sid = env.CLAUDE_CODE_SESSION_ID ?? "";
  const state = stateDir(env);
  if (
    env.SWARMAIL_WAKE_MOD === "1" ||
    !/^[\w-]+$/.test(sid) ||
    !existsSync(join(state, "swarmail-register", `${sid}.json`))
  ) {
    return 0;
  }
  if (waiterAlive(readWaiter(join(state, "swarmail-wake", sid)))) {
    return 0;
  }
  return wakeHook("claude", undefined, input, env);
}

async function nativeContextHint(sid: string, env: NodeJS.ProcessEnv): Promise<string> {
  const delivery = openHookDelivery(sid, env);
  try {
    const url = new URL("/wait", wakeUrl(env));
    url.search = new URLSearchParams({ session: sid, timeout: "0" }).toString() + delivery.query();
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return response.status === 200
      ? await delivery.receive(response, () => ensureWakeEligible(wakeUrl(env), sid))
      : "";
  } finally {
    delivery.close();
  }
}

/** Deliver mail at a native host's next safe context point; never cancel its active task. */
export async function contextHook(
  host: string | undefined,
  stop = false,
  input = "",
  env = process.env,
): Promise<number> {
  const key =
    host === "cursor"
      ? "conversation_id"
      : host === "devin"
        ? "session_id"
        : host === "agy"
          ? "conversationId"
          : null;
  let hint = "";
  try {
    const payload = JSON.parse(input);
    const sid = key ? payload[key] : undefined;
    if (
      typeof sid === "string" &&
      SESSION_RE.test(sid) &&
      !openRegistry(registryDir(env)).read(sid)?.ended
    ) {
      if (!stop && host !== "agy") {
        hint = updateHint(sid, false, env, host);
      }
      hint = [await nativeContextHint(sid, env), hint].filter(Boolean).join("\n");
    }
  } catch {
    // Mail delivery must never block a tool or grant permissions when the server is unavailable.
  }
  const output = !hint
    ? {}
    : host === "cursor"
      ? { additional_context: hint }
      : host === "devin"
        ? stop
          ? { decision: "block", reason: hint }
          : {
              hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint },
            }
        : stop
          ? { decision: "continue", reason: hint }
          : { injectSteps: [{ userMessage: hint }] };
  console.log(JSON.stringify(output));
  return 0;
}
