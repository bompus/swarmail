#!/usr/bin/env bun
// Compiles the swarmail command (src/cli.ts, or main.ts beside it when a build adds its own
// commands there, with bytecode laid out by scripts/swarmail.order and an embedded source map) into
// ~/.local/bin/swarmail, which the service, the host hooks and the git guard run. The binary hashes server sources,
// the dependency manifest and lockfile, the bytecode-order profile, and Bun.
// `--if-stale` rebuilds when one of those inputs changes.
// A running server keeps its old build until the service restarts.
// Usage: bun scripts/build.ts [--if-stale] [--out path]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { binaryPath, homeDir } from "../src/paths.ts";

const REPO_ROOT = join(import.meta.dir, "..");
export const defaultBinary = (home = homeDir()) => binaryPath(home);

/** The bytecode-order profile; scripts/train-bytecode-order.ts records it. Bun before 1.4.3 ignores the flag. */
export const orderProfile = (root = REPO_ROOT) => join(root, "scripts", "swarmail.order");

/** Hash the server sources, dependency manifest and lockfile, the bytecode-order profile, and the Bun version. */
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
  // Compiled runtime dependencies change when the manifest or resolved versions change; the profile changes the layout.
  for (const name of ["package.json", "bun.lock", "scripts/swarmail.order"]) {
    const path = join(root, name);
    if (existsSync(path)) {
      hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
    }
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

/** The file the binary is built from: src/main.ts, an entry that passes cli.ts extra commands, when it exists. */
export function buildEntry(root = REPO_ROOT): string {
  const src = join(root, "src");
  return existsSync(join(src, "main.ts")) ? join(src, "main.ts") : join(src, "cli.ts");
}

/**
 * Moves the new build over `out`. Windows refuses to rename over a running program but lets it be moved aside, so
 * a busy one gets a dated name; each build deletes the earlier ones that nothing runs any more.
 */
function replaceBinary(next: string, out: string): void {
  if (process.platform !== "win32") {
    renameSync(next, out);
    return;
  }
  const dir = dirname(out);
  const stem = basename(out).replace(/\.exe$/i, "");
  for (const name of readdirSync(dir).filter((name) => name.startsWith(`${stem}.old-`))) {
    try {
      rmSync(join(dir, name));
    } catch {
      // Still running; a later build removes it.
    }
  }
  try {
    renameSync(next, out);
  } catch (error) {
    // Windows refuses to replace a running program; any other failure leaves the installed binary alone.
    if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    const old = join(dir, `${stem}.old-${Date.now()}.exe`);
    renameSync(out, old);
    try {
      renameSync(next, out);
    } catch (failed) {
      renameSync(old, out);
      throw failed;
    }
  }
}

/** `order` is the profile to lay the bytecode out from, or null for a build that records one. */
export function buildSwarmail(
  root = REPO_ROOT,
  out = defaultBinary(),
  {
    entry = buildEntry(root),
    order = existsSync(orderProfile(root)) ? orderProfile(root) : null,
  } = {},
): string {
  const source = sourceHash(root);
  // Bun adds .exe to a Windows outfile without one, so the suffix stays last.
  const next = out.replace(/(\.exe)?$/i, ".new$1");
  const build = spawnSync(
    process.execPath,
    [
      "build",
      // No --smol: measured 2026-09-28, it saved 7 MB under load but doubled p99 latency.
      "--compile",
      "--bytecode",
      // Measured on Bun 1.4.3: 6% to 18% less memory in hook commands and 5% in the idle server, same speed.
      ...(order ? [`--bytecode-order=${order}`] : []),
      // Stack traces name the source file, line and function; --minify saved 40 KB of 84 MB and no startup time.
      "--sourcemap",
      "--define",
      `SWARMAIL_SOURCE=${JSON.stringify(source)}`,
      entry,
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
  replaceBinary(next, out);
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
