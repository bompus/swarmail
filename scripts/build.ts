#!/usr/bin/env bun
// Compiles the swarmail command (src/cli.ts, with bytecode and an embedded source map) into
// ~/.local/bin/swarmail, which the service, the host hooks and the git guard run. The binary carries a hash of the
// server's sources and the Bun that built it, so `--if-stale` rebuilds only after a source change or a Bun upgrade.
// A running server keeps its old build until the service restarts.
// Usage: bun scripts/build.ts [--if-stale] [--out path]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
export const defaultBinary = (home = homedir()) => join(home, ".local", "bin", "swarmail");

/** A hash of what the binary is built from: the server sources, by path and content, and the Bun version. */
export function sourceHash(root = REPO_ROOT, bun = Bun.version): string {
  const dir = join(root, "src");
  const hash = createHash("sha256").update(`bun ${bun}\0`);
  for (const name of readdirSync(dir)
    .filter((name) => /\.(ts|js)$/.test(name))
    .sort()) {
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** The source hash `bin` was built from, or null when it is missing or fails. */
export function binarySource(bin = defaultBinary()): string | null {
  const run = spawnSync(bin, ["version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

export function buildSwarmail(root = REPO_ROOT, out = defaultBinary()): string {
  const source = sourceHash(root);
  const next = `${out}.new`;
  const build = spawnSync(
    process.execPath,
    [
      "build",
      // No --smol: measured 2026-09-28, it saved 7 MB under load but doubled p99 latency.
      "--compile",
      "--bytecode",
      // Stack traces name the source file, line and function; --minify saved 40 KB of 84 MB and no startup time.
      "--sourcemap",
      "--define",
      `SWARMAIL_SOURCE=${JSON.stringify(source)}`,
      join(root, "src", "cli.ts"),
      "--outfile",
      next,
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  // The map is embedded in the binary too; the copy written beside it is not needed.
  rmSync(`${next}.map`, { force: true });
  if (build.status !== 0) {
    rmSync(next, { force: true });
    throw new Error(`bun build failed:\n${build.stderr}`);
  }
  // A rename, so running hooks and the server keep the old file instead of failing to write a busy one.
  renameSync(next, out);
  return source;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1]! : defaultBinary();
  if (args.includes("--if-stale") && binarySource(out) === sourceHash()) {
    process.exit(0);
  }
  console.log(`built ${out} from ${buildSwarmail(REPO_ROOT, out)}`);
}
