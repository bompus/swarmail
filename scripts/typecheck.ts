// Type check with Bun's built-in `bun check` (Bun 1.4.3 or later). A `check` script in
// package.json shadows the built-in in any directory that script belongs to, so the built-in runs
// from the temporary directory with an absolute project path.
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const proc = Bun.spawnSync(
  [process.execPath, "check", "-p", resolve(import.meta.dir, "..", "tsconfig.json")],
  {
    cwd: tmpdir(),
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(proc.exitCode);
