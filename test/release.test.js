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
  mkdirSync(join(root, "packages/codex-plugin"), { recursive: true });
  for (const file of [
    "scripts/check-release.ts",
    "package.json",
    "packages/mcp-relay/package.json",
    "packages/mcp-relay/index.mjs",
    "packages/claude-plugin/relay.mjs",
    "packages/codex-plugin/relay.mjs",
    "server.json",
    "CONTRIBUTING.md",
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

test.each(["claude-plugin", "codex-plugin"])(
  "release check rejects a %s relay that differs from the published relay",
  (plugin) => {
    const root = fixture();
    const path = join(root, `packages/${plugin}/relay.mjs`);
    writeFileSync(path, readFileSync(path, "utf8") + "// changed\n");
    const result = check(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("must match packages/mcp-relay/index.mjs");
  },
);

test("release check rejects a package with no row in the Listings section", () => {
  const root = fixture();
  mkdirSync(join(root, "packages/new-plugin"));
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("must name packages/new-plugin/");
});

test("release check rejects a package that is named only outside the Listings section", () => {
  const root = fixture();
  const path = join(root, "CONTRIBUTING.md");
  const text = readFileSync(path, "utf8");
  const listings = text.indexOf("\n## Listings");
  writeFileSync(
    path,
    `${text.slice(0, listings)}\n\npackages/codex-plugin/\n${text.slice(listings).replaceAll("packages/codex-plugin/", "")}`,
  );
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("must name packages/codex-plugin/");
});

test("release check rejects a package that is named only in the Listings introduction", () => {
  const root = fixture();
  const path = join(root, "CONTRIBUTING.md");
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("\n- ", text.indexOf("\n## Listings"));
  const rows = text.slice(start).replaceAll("packages/codex-plugin/", "");
  writeFileSync(path, `${text.slice(0, start)}\n\nSee packages/codex-plugin/.\n${rows}`);
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("must name packages/codex-plugin/");
});
