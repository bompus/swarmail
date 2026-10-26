import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { isLoopbackUrl, swarmailUrl } from "./paths.ts";

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

/** Starts a project key that names a repository, not a checkout path. */
export const REPOSITORY_PREFIX = "git:";

// git sends a URL's path decoded, so ssh://host/my%20repo and host:my repo name one repository.
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The name a git remote URL gives its repository, the same from every clone and every protocol, in lower case: `git:host/owner/repo`
 * for https://host/owner/repo.git, ssh://git@host:22/owner/repo and git@host:owner/repo.git. Null for a URL with no
 * host, such as a path on this machine.
 */
export function repositoryName(remote: string): string | null {
  const url = remote.trim();
  let host: string;
  let path: string;
  // user@host:path, with an IPv6 host in brackets; a drive letter such as C:\repo is a path on this machine.
  const scp = /^[A-Za-z]:[\\/]/.test(url)
    ? null
    : /^(?:[^@/\\]+@)?(\[[^\]]+\]|[^@:/\\]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) {
    [, host, path] = scp as unknown as [string, string, string];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      // Git sends a literal ? or # in an ssh path on to the host as part of it.
      path = decodePath(parsed.pathname + parsed.search + parsed.hash);
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && path ? `${REPOSITORY_PREFIX}${host}/${path}`.toLowerCase() : null;
}

/** The URL git uses for the `origin` remote of the clone holding `dir`; null when git cannot read one. */
export function originUrl(dir: string, run: (args: string[]) => string = git): string | null {
  try {
    return run(["-C", dir, "remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

/** The repository name of the clone holding `dir`, from its `origin` remote; null without a usable one. */
export function repositoryKey(dir: string, run: (args: string[]) => string = git): string | null {
  const url = originUrl(dir, run);
  return url === null ? null : repositoryName(url);
}

/**
 * The project key mail is filed under: the primary checkout's path on this machine's server, and the repository
 * name on a remote one, where that path means nothing.
 */
export function projectFor(dir: string, url = swarmailUrl()): string | null {
  return isLoopbackUrl(url) ? primaryCheckout(dir) : repositoryKey(dir);
}
