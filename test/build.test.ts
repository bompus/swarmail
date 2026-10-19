import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildEntry, buildSwarmail, orderProfile, sourceHash } from "../scripts/build.ts";
import { train } from "../scripts/train-bytecode-order.ts";

const ROOT = join(import.meta.dir, "..");
// Bun before 1.4.3 does not write the profile.
const hasProfiles = Bun.semver.order(Bun.version, "1.4.3") >= 0;

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
    const withLock = sourceHash(root, "1.0.0");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(orderProfile(root), "v2\nF 0000000000000000\n");
    expect(sourceHash(root, "1.0.0")).not.toBe(withLock);
    const withProfile = sourceHash(root, "1.0.0");
    writeFileSync(join(root, "scripts", "build.ts"), "// flags\n");
    expect(sourceHash(root, "1.0.0")).not.toBe(withProfile);
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

test("the committed profile builds a binary that runs", () => {
  const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
  try {
    const bin = join(root, process.platform === "win32" ? "swarmail.exe" : "swarmail");
    const source = buildSwarmail(ROOT, bin);
    const run = spawnSync(bin, ["version"], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe(source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the binary ignores a .env and a bunfig.toml in the directory it runs in", () => {
  const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
  try {
    const entry = join(root, "probe.ts");
    writeFileSync(
      entry,
      'console.log(process.env.SWARMAIL_DOTENV_PROBE ?? "unset", Reflect.get(globalThis, "swarmailPreloadProbe") ?? "unset");\n',
    );
    const bin = join(root, process.platform === "win32" ? "probe.exe" : "probe");
    buildSwarmail(ROOT, bin, { entry, order: null });
    const cwd = join(root, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, ".env"), "SWARMAIL_DOTENV_PROBE=from-project\n");
    writeFileSync(join(cwd, "preload.ts"), 'Reflect.set(globalThis, "swarmailPreloadProbe", "ran");\n');
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    const env = { ...process.env };
    delete env.SWARMAIL_DOTENV_PROBE;
    const run = spawnSync(bin, [], { cwd, encoding: "utf8", env });
    expect(run.stdout.trim()).toBe("unset unset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!hasProfiles || process.platform === "win32")(
  "training records a profile from a server run",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "build-swarmail-"));
    try {
      const target = join(root, "server.order");
      await train(ROOT, target);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toMatch(/^v2\nF [0-9a-f]{16}\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
