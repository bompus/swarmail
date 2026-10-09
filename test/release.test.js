import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarmail-release-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/mcp-relay"), { recursive: true });
  mkdirSync(join(root, "packages/claude-plugin"), { recursive: true });
  for (const file of [
    "scripts/check-release.ts",
    "package.json",
    "packages/mcp-relay/package.json",
    "packages/mcp-relay/index.mjs",
    "packages/claude-plugin/relay.mjs",
    "server.json",
  ]) {
    cpSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  return root;
}

function check(root) {
  return Bun.spawnSync([process.execPath, "scripts/check-release.ts"], { cwd: root });
}

test("release check accepts aligned repository metadata", () => {
  expect(check(fixture()).exitCode).toBe(0);
});

test.each([
  ["package.json", (manifest) => (manifest.version = "0.0.0")],
  ["packages/mcp-relay/package.json", (manifest) => (manifest.version = "0.0.0")],
  ["server.json", (manifest) => (manifest.version = "0.0.0")],
  ["server.json", (manifest) => (manifest.packages[0].version = "0.0.0")],
])("release check rejects version drift in %s", (file, change) => {
  const root = fixture();
  const path = join(root, file);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Release versions must match");
});

test("release check rejects a Claude Code plugin relay that differs from the published relay", () => {
  const root = fixture();
  const path = join(root, "packages/claude-plugin/relay.mjs");
  writeFileSync(path, readFileSync(path, "utf8") + "// changed\n");
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("must match packages/mcp-relay/index.mjs");
});
