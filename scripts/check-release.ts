import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const core = read("package.json");
const relay = read("packages/mcp-relay/package.json");
const registry = read("server.json");
const versions = [
  ["package.json", core.version],
  ["packages/mcp-relay/package.json", relay.version],
  ["server.json", registry.version],
  ...registry.packages.map((pkg: { version?: string }, index: number) => [
    `server.json packages[${index}]`,
    pkg.version,
  ]),
];

if (
  typeof core.version !== "string" ||
  core.version.length === 0 ||
  versions.some(([, version]) => version !== core.version)
) {
  console.error("Release versions must match:");
  for (const [path, version] of versions) {
    console.error(`  ${path}: ${version}`);
  }
  process.exit(1);
}

// The Claude Code plugin ships its own copy of the relay, since a plugin can only run files inside
// its folder.
const relaySource = readFileSync(new URL("packages/mcp-relay/index.mjs", root), "utf8");
if (readFileSync(new URL("packages/claude-plugin/relay.mjs", root), "utf8") !== relaySource) {
  console.error("packages/claude-plugin/relay.mjs must match packages/mcp-relay/index.mjs");
  process.exit(1);
}

console.log(`Release versions match ${core.version}`);
