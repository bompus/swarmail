import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homeDir, tildePath, t3Home } from "./paths.ts";
import { t3StatePath, t3Threads } from "./t3-state.ts";
import { nativeTitles, type NativeSession } from "./native-titles.ts";

export interface Location {
  repo: string;
  worktree: string;
  branch: string | null;
  title: string | null;
}

/** HEAD is a ref on a branch and a commit when detached; a removed checkout has no current branch. */
function branch(worktree: string): string | null {
  try {
    const dotgit = join(worktree, ".git");
    let gitdir = dotgit;
    try {
      const file = readFileSync(dotgit, "utf8").trim();
      if (!file.startsWith("gitdir: ")) {
        return null;
      }
      gitdir = resolve(worktree, file.slice(8));
    } catch {
      // The primary checkout has a .git directory.
    }
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : null;
  } catch {
    return null;
  }
}

/** A display location for a registered edit checkout; unknown historical locations stay unknown. */
export function location(
  project: string,
  worktree: string | null | undefined,
  title: string | null = null,
): Location | null {
  return worktree
    ? {
        repo: basename(project),
        worktree: tildePath(homeDir(), worktree),
        branch: branch(worktree),
        title,
      }
    : null;
}

/** Read display titles for a roster or sender snapshot, with T3 titles first. */
export function locations(
  project: string,
  agents: ({ worktree: string | null; t3_thread: string | null } & NativeSession)[],
): (Location | null)[] {
  const threads = agents.some((a) => a.t3_thread) ? t3Threads(t3StatePath(t3Home())) : new Map();
  const t3Titles = agents.map((a) =>
    a.t3_thread ? (threads.get(a.t3_thread)?.title ?? null) : null,
  );
  const native = nativeTitles(agents.map((a, i) => (a.worktree && t3Titles[i] === null ? a : {})));
  return agents.map((a, i) => location(project, a.worktree, t3Titles[i] ?? native[i] ?? null));
}

export function locationLabel(value: Location): string {
  return `${value.repo} · ${value.worktree} · ${value.branch ?? "detached or unavailable"}`;
}
