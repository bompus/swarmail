// `swarmail guard <pre-commit|pre-push>`: refuses a commit or push that touches a path another agent holds
// an exclusive Swarmail reservation on. Installed into a repository's hook chain by install-swarmail-guard.ts.
// SWARMAIL_GUARD=warn reports without blocking, SWARMAIL_GUARD=off skips the check; `--no-verify` skips every hook.
import { databasePath } from "./paths.ts";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { nowUs } from "./db.ts";
import { primaryCheckout } from "./checkout.ts";
import { overlaps } from "./glob.ts";
import { selfNames } from "./registry.ts";

interface Reservation {
  path_pattern: string;
  agent: string;
}

const ZERO = /^0+$/;

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : null;
};

/** Paths the commit or push changes, relative to the repository root. */
function changedPaths(hook: string, stdin: string, cwd: string): string[] {
  const split = (out: string | null) => (out ?? "").split("\0").filter(Boolean);
  if (hook === "pre-commit") {
    return split(git(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"]));
  }
  const paths = new Set<string>();
  for (const line of stdin.split("\n")) {
    const sha = line.trim().split(/\s+/)[1];
    if (!sha || ZERO.test(sha)) {
      continue;
    }
    // Commits no remote branch has yet: what this push publishes.
    for (const p of split(
      git(cwd, [
        "log",
        "--no-renames",
        "--name-only",
        "--format=",
        "-z",
        sha,
        "--not",
        "--remotes",
      ]),
    )) {
      paths.add(p);
    }
  }
  return [...paths];
}

export function guard(
  hook: string | undefined,
  stdin = "",
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): number {
  if (hook !== "pre-commit" && hook !== "pre-push") {
    console.error("usage: swarmail guard <pre-commit|pre-push>");
    return 64;
  }
  const mode = env.SWARMAIL_GUARD || "block";
  if (mode === "off") {
    return 0;
  }
  const dbPath = databasePath(env);
  // Sessions register under the primary checkout, whichever worktree they commit from.
  const project = primaryCheckout(cwd);
  if (!project || !existsSync(dbPath)) {
    return 0;
  }

  const db = new Database(dbPath, { readonly: true });
  let held: Reservation[];
  try {
    db.run("PRAGMA busy_timeout = 2000");
    held = db
      .query<Reservation, [string, number]>(
        `SELECT f.path_pattern, a.name AS agent FROM file_reservations f
         JOIN agents a ON a.id = f.agent_id JOIN projects p ON p.id = f.project_id
         WHERE p.human_key = ? AND f.exclusive = 1 AND f.released_ts IS NULL AND f.expires_ts > ?`,
      )
      .all(project, nowUs());
  } finally {
    db.close();
  }
  if (held.length === 0) {
    return 0;
  }
  const self = new Set([...selfNames(env)].map((n) => n.toLowerCase()));
  const foreign = held.filter((r) => !self.has(r.agent.toLowerCase()));
  if (foreign.length === 0) {
    return 0;
  }

  const conflicts: string[] = [];
  for (const path of changedPaths(hook, stdin, cwd)) {
    for (const r of foreign) {
      if (overlaps(r.path_pattern, path)) {
        conflicts.push(`  ${path}  (${r.path_pattern}, held by ${r.agent})`);
      }
    }
  }
  if (conflicts.length === 0) {
    return 0;
  }
  const warn = mode === "warn";
  console.error(
    `swarmail guard: ${hook} touches paths other agents reserved:\n${conflicts.join("\n")}`,
  );
  console.error(
    warn
      ? "SWARMAIL_GUARD=warn: continuing."
      : "Coordinate with the holder, or set SWARMAIL_AGENT=<your name> if the reservation is yours;\n" +
          "SWARMAIL_GUARD=warn reports without blocking, and --no-verify skips every hook.",
  );
  return warn ? 0 : 1;
}
