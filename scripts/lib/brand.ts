// What the banners, the social preview and every public description say Swarmail is. One definition, so the renderer
// and `bun run check` (scripts/check-public.ts) cannot disagree about it.
export const NAME = "swarmail";
export const TAGLINE = "Mail between coding-agent sessions, on one machine or across machines";
export const CHIPS = [
  "MCP server",
  "Threaded inbox and search",
  "File reservations",
  "Wake on mail",
];
export const FACTS = "One Bun binary · SQLite · localhost by default · MIT";

/** The rendered images, relative to docs/assets/. */
export const IMAGES = ["banner-dark.png", "banner-light.png", "social-preview.png"];

/**
 * Wording from when Swarmail served one machine only, matched across line breaks. `bun run check` rejects it in
 * PUBLIC_PATHS, and `bun run check:published` in the repository's GitHub description. "On one machine by default" and
 * "on one machine or across machines" are true and pass. A change to where Swarmail runs, who can reach it or what it
 * stores adds the phrases it makes stale here.
 */
export const STALE_SCOPE = new RegExp(
  [
    String.raw`\blocal[- ]mail\b`,
    String.raw`\blocal[- ]only\b`,
    String.raw`\blocalhost only\b`,
    String.raw`\bsingle[- ](?:machine|computer)\b(?!,? by default| or)`,
    String.raw`\btrusted local (?:service|server)\b`,
    String.raw`\brunning on this machine\b(?!,? by default|,? or)`,
    String.raw`\bon (?:one|a single) (?:machine|computer)\b(?!,? by default| or)`,
    String.raw`\bon your machine\b`,
    String.raw`\b(?:never|nothing) leaves your (?:machine|computer)\b`,
  ].join("|"),
  "i",
);

/**
 * Files and folders whose text a reader takes as a statement of what Swarmail is or where it runs. A folder counts
 * every text file under it. PRIVACY.md is left out on purpose: it says where the server's data lives, which is the
 * computer that runs it. CHANGELOG.md is history.
 */
export const PUBLIC_PATHS = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "package.json",
  "server.json",
  "docs/usage.md",
  "src/guidance.ts",
  "src/tools.ts",
  "scripts/enable.sh",
  "scripts/enable-windows.ts",
  "evals/docs-check/tools.json",
  "evals/docs-check/cases",
  "systemd",
  "packages",
  ".agents",
  ".claude-plugin",
  ".cursor-plugin",
];

/** What scripts/render-assets.ts writes beside the images: the text they show and a hash of each image. */
export const ASSET_SOURCE = "docs/assets/source.json";
export const assetText = () => ({ name: NAME, tagline: TAGLINE, chips: CHIPS, facts: FACTS });
