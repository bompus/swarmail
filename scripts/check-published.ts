// Run after publishing (the release workflow's last step, or by hand after a manual publish; never in the regular CI):
// asks GitHub, npm and the MCP registry which version each shows as latest and exits 1 unless all three show the version
// in package.json. A release that exists only on GitHub is incomplete, so this is what CONTRIBUTING.md "Releasing"
// step 4 requires before a release is called done.
//   bun scripts/check-published.ts [--version X.Y.Z] [--github URL] [--npm BASE_URL] [--registry URL] [--repository URL]
import { readFileSync } from "node:fs";
import { STALE_SCOPE } from "./lib/brand.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const flags = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  flags.set(args[i] as string, args[i + 1] as string);
}

const core = read("package.json");
const relay = read("packages/mcp-relay/package.json");
const server = read("server.json");
const version: string = flags.get("--version") ?? core.version;
const repo = new URL(server.repository.url).pathname.replace(/^\/|\.git$/g, "");
const githubUrl = flags.get("--github") ?? `https://api.github.com/repos/${repo}/releases/latest`;
const repositoryUrl = flags.get("--repository") ?? `https://api.github.com/repos/${repo}`;
const npmUrl = `${flags.get("--npm") ?? "https://registry.npmjs.org"}/${relay.name}/latest`;
const registryUrl =
  flags.get("--registry") ??
  `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/latest`;

async function get(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "swarmail-check-published" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

// What each channel shows as latest. The MCP registry holds the server version and the npm package version separately.
const channels: [string, string, (body: any) => string[]][] = [
  ["GitHub release", githubUrl, (body) => [String(body.tag_name).replace(/^v/, "")]],
  [`npm ${relay.name}`, npmUrl, (body) => [body.version]],
  [
    `MCP registry ${server.name}`,
    registryUrl,
    (body) => {
      const pkg = (body.server.packages ?? []).find(
        (entry: { registryType: string; identifier: string }) =>
          entry.registryType === "npm" && entry.identifier === relay.name,
      );
      if (!pkg) {
        throw new Error(`it lists no npm package ${relay.name}`);
      }
      return [body.server.version, pkg.version];
    },
  ],
];

const problems: string[] = [];
for (const [name, url, shown] of channels) {
  try {
    const seen = shown(await get(url));
    const wrong = seen.filter((v) => v !== version);
    if (wrong.length > 0) {
      problems.push(`${name}: shows ${[...new Set(wrong)].join(", ")}, not ${version}`);
    }
  } catch (error) {
    problems.push(`${name}: could not be read (${(error as Error).message}) from ${url}`);
  }
}

// The repository description is set by hand on GitHub, so nothing in the tree keeps it current.
try {
  const { description } = await get(repositoryUrl);
  if (typeof description === "string" && STALE_SCOPE.test(description)) {
    problems.push(`GitHub repository description still reads "${description}"`);
  }
} catch (error) {
  problems.push(`GitHub repository description could not be read (${(error as Error).message})`);
}

if (problems.length > 0) {
  console.error(`Release ${version} is incomplete:`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error("Publish the missing channels (CONTRIBUTING.md, Releasing), then run this again.");
  process.exit(1);
}

console.log(`Release ${version} is published as ${version} on GitHub, npm and the MCP registry.`);
console.log(
  "Not checked by this script, so check them by hand: Glama's admin Releases page and the other listings",
);
console.log("(CONTRIBUTING.md, Releasing steps 5 and 6).");
