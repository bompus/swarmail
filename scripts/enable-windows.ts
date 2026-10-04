#!/usr/bin/env bun
// The Windows counterpart of enable.sh: builds ~/.local/bin/swarmail.exe and runs its server at logon as the
// scheduled task "Swarmail" on 127.0.0.1:18765. The task starts the server under `conhost --headless`, so no console
// window opens, and registering a logon task for yourself needs no administrator. Rerun it after pulling: it stops
// the running server first. Settings are user environment variables (`setx SWARMAIL_PORT ...`), read at logon.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { binaryPath, DEFAULT_PORT, serverRecordPath } from "../src/paths.ts";
import { hostAlive, type HostProcess } from "../src/proc.ts";
import { buildSwarmail } from "./build.ts";

export const TASK = "Swarmail";

/** Stops the server `record` names, if that exact process still runs. Returns whether it stopped one. */
export async function stopServer(record = serverRecordPath()): Promise<boolean> {
  if (!existsSync(record)) {
    return false;
  }
  let server: HostProcess;
  try {
    server = JSON.parse(readFileSync(record, "utf8"));
  } catch {
    return false;
  }
  if (!hostAlive(server)) {
    return false;
  }
  process.kill(server.pid);
  for (let i = 0; i < 50 && hostAlive(server); i++) {
    await Bun.sleep(100);
  }
  return true;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function powershell(script: string, env: Record<string, string>): string {
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(`PowerShell failed (exit ${run.status}): ${script.split("\n")[0]}`);
  }
  return run.stdout.trim();
}

/**
 * A variable as the task's server sees it: the user's registry value, else the machine's. A `setx` in this terminal
 * changes the registry but not this process's environment.
 */
export function savedEnv(name: string): string {
  return powershell(
    "$v = [Environment]::GetEnvironmentVariable($env:SWARMAIL_VAR, 'User'); " +
      "if (!$v) { $v = [Environment]::GetEnvironmentVariable($env:SWARMAIL_VAR, 'Machine') }; $v",
    { SWARMAIL_VAR: name },
  );
}

// The binary path and task name travel as environment variables, so no path needs quoting inside the script.
const REGISTER = `
$action = New-ScheduledTaskAction -Execute "$env:windir\\System32\\conhost.exe" -Argument ('--headless "' + $env:SWARMAIL_BIN + '" serve')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $env:SWARMAIL_TASK -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $env:SWARMAIL_TASK`;

/** Registers (or replaces) the logon task that runs `bin serve`, and starts it now. */
export function registerTask(bin: string, task = TASK): void {
  powershell(REGISTER, { SWARMAIL_BIN: bin, SWARMAIL_TASK: task });
}

if (import.meta.main) {
  if (process.platform !== "win32") {
    throw new Error("Windows only; on Linux run scripts/enable.sh.");
  }
  const saved = savedEnv("SWARMAIL_PORT");
  if ((process.env.SWARMAIL_PORT ?? "") !== saved) {
    console.warn(
      `SWARMAIL_PORT is "${process.env.SWARMAIL_PORT ?? ""}" here but "${saved}" in your saved ` +
        "environment; the task uses the saved one.",
    );
  }
  const port = Number(saved || DEFAULT_PORT);
  const bin = binaryPath();
  buildSwarmail(undefined, bin);
  if (await stopServer()) {
    console.log("Stopped the running server.");
  }
  // On WSL with mirrored networking, a server running in WSL answers here too.
  if (await healthy(port)) {
    console.error(
      `Another server already answers on 127.0.0.1:${port} (one in WSL, or one started by hand). ` +
        "Stop it, or `setx SWARMAIL_PORT <port>` and rerun.",
    );
    process.exit(1);
  }
  registerTask(bin);
  for (let i = 0; i < 40 && !(await healthy(port)); i++) {
    await Bun.sleep(250);
  }
  if (!(await healthy(port))) {
    console.error(
      `The task started but /healthz is not answering; check: Get-ScheduledTask ${TASK}`,
    );
    process.exit(1);
  }
  console.log(`swarmail enabled on http://127.0.0.1:${port} (localhost only, no auth).`);
}
