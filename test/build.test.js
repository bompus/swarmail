import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash } from "../scripts/build.ts";

test("editing a server source changes the hash the binary is checked against", () => {
  const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
  try {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cli.ts"), "export {};\n");
    const before = sourceHash(root, "1.0.0");
    writeFileSync(join(src, "cli.ts"), "export const changed = 1;\n");
    expect(sourceHash(root, "1.0.0")).not.toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
