import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** The main worktree of the repository holding `dir`, or null outside a non-bare repository. */
export function primaryCheckout(dir: string, run: (args: string[]) => string = git): string | null {
  try {
    const common = run(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
