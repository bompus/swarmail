// Format check (shfmt) and lint (shellcheck) for the tracked shell scripts: the *.sh and *.bash
// files plus extensionless files whose first line is a sh or bash shebang.
// shfmt gets its style as flags, so every script is formatted the same whatever its name: with
// flags given, shfmt ignores .editorconfig, whose sections match by file name and cannot select
// extensionless files. shellcheck reads .shellcheckrc.
import { readFileSync } from "node:fs";

const SHFMT_FLAGS = ["-i", "2", "-bn", "-ci"];
const SHEBANG = /^#!.*[/ ](ba)?sh( |$)/;

const run = (cmd: string[]) => {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  return proc.exitCode === 0;
};

const tracked = Bun.spawnSync(["git", "ls-files", "-z"])
  .stdout.toString()
  .split("\0")
  .filter(Boolean);
const scripts = tracked.filter((path) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(sh|bash)$/.test(name)) {
    return true;
  }
  if (name.includes(".")) {
    return false;
  }
  try {
    return SHEBANG.test(readFileSync(path, "utf8").split("\n", 1)[0] ?? "");
  } catch {
    return false;
  }
});

if (scripts.length === 0) {
  console.log("No shell scripts to check.");
  process.exit(0);
}
const formatted = run(["shfmt", ...SHFMT_FLAGS, "-d", ...scripts]);
const linted = run(["shellcheck", ...scripts]);
process.exit(formatted && linted ? 0 : 1);
