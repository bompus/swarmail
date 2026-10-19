import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-published.ts asks GitHub, npm and the MCP registry which version each shows as latest.
// The tests point it at a local server that answers like those three, with versions the test sets.
let root: string;
let server: ReturnType<typeof Bun.serve>;
// Loose JSON the stand-in server answers with; each test reshapes it.
let shown: Record<string, any>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "swarmail-published-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/mcp-relay"), { recursive: true });
  for (const file of [
    "scripts/check-published.ts",
    "package.json",
    "packages/mcp-relay/package.json",
    "server.json",
  ]) {
    cpSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const answer = shown[new URL(request.url).pathname];
      return answer === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(answer);
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const manifest = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const repoVersion = manifest("package.json").version;
const npmName = manifest("packages/mcp-relay/package.json").name;

const relayPackage = (version: string, identifier = npmName) => ({
  registryType: "npm",
  identifier,
  version,
});

function everythingPublished(version = repoVersion) {
  return {
    "/github/latest": { tag_name: `v${version}` },
    [`/npm/${npmName}/latest`]: { version },
    "/registry/latest": { server: { version, packages: [relayPackage(version)] } },
  };
}

async function check(args: string[] = []) {
  const base = `http://127.0.0.1:${server.port}`;
  // Not spawnSync: that would block this process, and the stand-in server lives in it.
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/check-published.ts",
      "--github",
      `${base}/github/latest`,
      "--npm",
      `${base}/npm`,
      "--registry",
      `${base}/registry/latest`,
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out, err };
}

test("passes when GitHub, npm and the MCP registry all show the repository version", async () => {
  shown = everythingPublished();
  const result = await check();
  expect(result.code).toBe(0);
  expect(result.out).toContain(`published as ${repoVersion}`);
});

test.each([
  ["GitHub release", "/github/latest", () => ({ tag_name: "v0.0.1" })],
  ["npm", `/npm/${npmName}/latest`, () => ({ version: "0.0.1" })],
  [
    "MCP registry",
    "/registry/latest",
    () => ({ server: { version: repoVersion, packages: [relayPackage("0.0.1")] } }),
  ],
  [
    "MCP registry",
    "/registry/latest",
    () => ({ server: { version: "0.0.1", packages: [relayPackage(repoVersion)] } }),
  ],
])("fails and names %s when it shows an older version", async (channel, path, stale) => {
  shown = everythingPublished();
  shown[path] = stale();
  const result = await check();
  expect(result.code).toBe(1);
  expect(result.err).toContain("incomplete");
  expect(result.err).toContain(channel);
});

test("a GitHub-only release is reported as incomplete, with each missing channel named", async () => {
  shown = everythingPublished();
  shown[`/npm/${npmName}/latest`] = { version: "0.0.1" };
  shown["/registry/latest"] = { server: { version: "0.0.1", packages: [relayPackage("0.0.1")] } };
  const result = await check();
  expect(result.code).toBe(1);
  expect(result.err).toContain(`npm ${npmName}: shows 0.0.1`);
  expect(result.err).toContain("MCP registry");
  expect(result.err).not.toContain("GitHub release");
});

test("a channel that cannot be read fails the check instead of passing it", async () => {
  shown = everythingPublished();
  delete shown[`/npm/${npmName}/latest`];
  const result = await check();
  expect(result.code).toBe(1);
  expect(result.err).toContain(`npm ${npmName}: could not be read`);
});

test.each([
  ["lists no packages", []],
  ["lists only a different package", [relayPackage(repoVersion, "some-other-package")]],
  [
    "lists the package under another registry",
    [{ ...relayPackage(repoVersion), registryType: "pypi" }],
  ],
])("fails when the MCP registry %s", async (_, packages) => {
  shown = everythingPublished();
  shown["/registry/latest"] = { server: { version: repoVersion, packages } };
  const result = await check();
  expect(result.code).toBe(1);
  expect(result.err).toContain(`MCP registry`);
  expect(result.err).toContain(`lists no npm package ${npmName}`);
});

test("lists the channels no script can read, so a pass is not read as everything done", async () => {
  shown = everythingPublished();
  const result = await check();
  expect(result.out).toContain("Glama");
  expect(result.out).toContain("by hand");
});

test("checks the version given with --version instead of the repository's", async () => {
  shown = everythingPublished("9.9.9");
  expect((await check(["--version", "9.9.9"])).code).toBe(0);
  expect((await check()).code).toBe(1);
});

test("asks npm about the package named in packages/mcp-relay/package.json", async () => {
  const path = join(root, "packages/mcp-relay/package.json");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), name: "renamed-relay" }));
  try {
    shown = everythingPublished();
    shown["/npm/renamed-relay/latest"] = { version: repoVersion };
    shown["/registry/latest"].server.packages = [relayPackage(repoVersion, "renamed-relay")];
    expect((await check()).code).toBe(0);
  } finally {
    writeFileSync(path, original);
  }
});
