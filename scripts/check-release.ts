import { readdirSync, readFileSync } from "node:fs";

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
for (const plugin of ["claude-plugin", "codex-plugin"]) {
  if (readFileSync(new URL(`packages/${plugin}/relay.mjs`, root), "utf8") !== relaySource) {
    console.error(`packages/${plugin}/relay.mjs must match packages/mcp-relay/index.mjs`);
    process.exit(1);
  }
}

// Every package is published somewhere, and CONTRIBUTING.md records where, so a release or a change to
// its description reaches every listing.
const contributing = readFileSync(new URL("CONTRIBUTING.md", root), "utf8");
const listings = contributing.slice(contributing.indexOf("\n## Listings")).split(/\n## /)[1] ?? "";
for (const entry of readdirSync(new URL("packages/", root), { withFileTypes: true })) {
  if (entry.isDirectory() && !listings.includes(`packages/${entry.name}/`)) {
    console.error(`CONTRIBUTING.md must name packages/${entry.name}/ in its Listings section`);
    process.exit(1);
  }
}

console.log(`Release versions match ${core.version}`);
