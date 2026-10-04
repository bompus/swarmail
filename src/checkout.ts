import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** The main worktree of the repository holding `dir`, or null outside a non-bare repository. */
export function primaryCheckout(dir: string, run: (args: string[]) => string = git): string | null {
  try {
    const common = run(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    // Git prints C:/... on Windows; resolve gives the native form that cwd and realpath use.
    return basename(common) === ".git" ? resolve(dirname(common)) : null;
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

/** The actual worktree root, keeping linked worktrees separate from their primary checkout. */
export function worktreeRoot(dir: string): string | null {
  try {
    return resolve(git(["-C", dir, "rev-parse", "--show-toplevel"]));
  } catch {
    return null;
  }
}
