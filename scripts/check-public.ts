// `bun run check` step: the public text must still describe what Swarmail does. It fails on wording from when Swarmail
// served one machine only, on a README banner alt text that differs from the tagline, and on banners or a social
// preview that were not drawn from the current tagline (scripts/render-assets.ts records what it drew).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ASSET_SOURCE,
  IMAGES,
  PUBLIC_PATHS,
  STALE_SCOPE,
  TAGLINE,
  assetText,
} from "./lib/brand.ts";

const TEXT = /\.(?:md|json|ts|sh|mjs|js|service)$/;

function textFiles(root: string, path: string): string[] {
  const full = join(root, path);
  if (!existsSync(full)) {
    return [];
  }
  if (!statSync(full).isDirectory()) {
    return [path];
  }
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "node_modules"
      ? []
      : entry.isDirectory()
        ? textFiles(root, join(path, entry.name))
        : TEXT.test(entry.name)
          ? [join(path, entry.name)]
          : [],
  );
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * The text as a reader sees it: string literals joined by `+`, escaped line breaks and tabs turned into
 * spaces, and whitespace collapsed, so a phrase split over lines, escapes or concatenated pieces still matches.
 */
export const readable = (source: string): string =>
  source
    .replace(/(["'`])\s*\+\s*\1/g, "")
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ");

/** What is wrong with the public text under `root`; empty when it is current. */
export function publicProblems(root: string, paths = PUBLIC_PATHS): string[] {
  const problems: string[] = [];
  for (const file of paths.flatMap((path) => textFiles(root, path))) {
    const text = readable(readFileSync(join(root, file), "utf8"));
    const hit = STALE_SCOPE.exec(text);
    if (hit) {
      problems.push(`${file}: still describes Swarmail as local to one machine: "${hit[0]}"`);
    }
  }
  const readme = join(root, "README.md");
  if (existsSync(readme) && !readFileSync(readme, "utf8").includes(`alt="swarmail: ${TAGLINE}"`)) {
    problems.push(`README.md: banner alt text must read "swarmail: ${TAGLINE}"`);
  }
  const rendered = join(root, ASSET_SOURCE);
  if (existsSync(rendered)) {
    const source = JSON.parse(readFileSync(rendered, "utf8"));
    // Compared as data, so key order and layout do not matter.
    const wanted = assetText();
    for (const key of Object.keys(wanted) as (keyof typeof wanted)[]) {
      if (JSON.stringify(source[key]) !== JSON.stringify(wanted[key])) {
        problems.push(
          `${ASSET_SOURCE}: ${key} differs from scripts/lib/brand.ts; rerun scripts/render-assets.ts and commit the images`,
        );
      }
    }
    for (const image of IMAGES) {
      const file = join(root, "docs/assets", image);
      if (!existsSync(file) || sha256(file) !== source.images?.[image]) {
        problems.push(
          `docs/assets/${image}: not the image scripts/render-assets.ts last wrote; rerun it and commit the images`,
        );
      }
    }
  } else {
    problems.push(`${ASSET_SOURCE} is missing; run scripts/render-assets.ts`);
  }
  return problems;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const problems = publicProblems(root);
  if (problems.length > 0) {
    console.error(problems.map((problem) => `  ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log("Public text and images describe Swarmail as it is now");
}
