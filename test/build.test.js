import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEntry, sourceHash } from "../scripts/build.ts";

test("editing a server source changes the hash the binary is checked against", () => {
  const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
  try {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cli.ts"), "export {};\n");
    const before = sourceHash(root, "1.0.0");
    writeFileSync(join(src, "cli.ts"), "export const changed = 1;\n");
    expect(sourceHash(root, "1.0.0")).not.toBe(before);
    const beforeManifest = sourceHash(root, "1.0.0");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"validator":"1"}}');
    expect(sourceHash(root, "1.0.0")).not.toBe(beforeManifest);
    const withDependency = sourceHash(root, "1.0.0");
    writeFileSync(join(root, "bun.lock"), "resolved validator 1");
    expect(sourceHash(root, "1.0.0")).not.toBe(withDependency);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds src/main.ts when a build adds one, else src/cli.ts", () => {
  const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
  try {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cli.ts"), "export {};\n");
    expect(buildEntry(root)).toBe(join(src, "cli.ts"));
    writeFileSync(join(src, "main.ts"), "export {};\n");
    expect(buildEntry(root)).toBe(join(src, "main.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
