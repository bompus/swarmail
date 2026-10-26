// What the banners, the social preview and every public description say Swarmail is. One definition, so the renderer
// and `bun run check` (scripts/check-release.ts) cannot disagree about it.
export const NAME = "swarmail";
export const TAGLINE = "Mail between coding-agent sessions, on one machine or across your own";
export const CHIPS = [
  "MCP server",
  "Threaded inbox and search",
  "File reservations",
  "Wake on mail",
];
export const FACTS = "One Bun binary · SQLite · localhost by default · MIT";

/**
 * Wording from when Swarmail served one machine only. `bun run check` rejects it in the public files below, and
 * `bun run check:published` in the repository's GitHub description. "On one machine by default" and "on one machine
 * or across your own" are true and pass.
 */
export const STALE_SCOPE =
  /\blocal mail\b|running on this machine|\bon one machine\b(?! (?:or|by default))/i;

/** Files whose text a reader takes as a statement of what Swarmail is or where it runs. */
export const PUBLIC_FILES = [
  "README.md",
  "package.json",
  "server.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "packages/claude-plugin/.claude-plugin/plugin.json",
  "packages/claude-plugin/README.md",
  "packages/codex-plugin/plugin.json",
  "packages/codex-plugin/README.md",
  "packages/cursor-plugin/.cursor-plugin/plugin.json",
  "packages/cursor-plugin/README.md",
  "packages/mcp-relay/package.json",
  "packages/mcp-relay/README.md",
  "src/guidance.ts",
  "evals/docs-check/cases/evaluate.md",
];

/** Written beside the rendered images by scripts/render-assets.ts, so a change to the text above without a re-render is caught. */
export const ASSET_SOURCE = "docs/assets/source.json";
export const assetSource = () => ({ name: NAME, tagline: TAGLINE, chips: CHIPS, facts: FACTS });
