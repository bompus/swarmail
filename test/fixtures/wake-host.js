// Stands in for a host that runs a hook, on any platform. It runs the argv in HOST_HOOK (JSON) with HOST_INPUT on
// stdin and CLAUDE_PID naming this process, and sends the hook's stdout to the file HOST_OUT when set. With
// HOST_NEST it runs itself again first, as Cursor runs a hook under a shell of its own; detached, because on
// Windows a killed Bun process takes the processes it started with it. The arguments after this script stand in
// for the host's flags, such as Claude's `-p`.
import { spawn } from "node:child_process";

const { HOST_HOOK, HOST_INPUT = "", HOST_OUT, HOST_NEST, ...env } = process.env;
if (HOST_NEST) {
  const child = spawn(process.execPath, [import.meta.path, ...process.argv.slice(2)], {
    env: { ...env, HOST_HOOK, HOST_INPUT, ...(HOST_OUT && { HOST_OUT }) },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    windowsHide: true,
  });
  process.exit(await new Promise((done) => child.on("exit", (code) => done(code ?? 1))));
}
const child = Bun.spawn(JSON.parse(HOST_HOOK), {
  env: { ...env, CLAUDE_PID: String(process.pid) },
  stdin: new Blob([HOST_INPUT]),
  stdout: HOST_OUT ? Bun.file(HOST_OUT) : "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
