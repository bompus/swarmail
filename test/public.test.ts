import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publicProblems, readable } from "../scripts/check-public.ts";
import { IMAGES, STALE_SCOPE, TAGLINE, assetText } from "../scripts/lib/brand.ts";

const roots: string[] = [];
const npmBanner = `<picture><source srcset="https://raw.githubusercontent.com/bompus/swarmail/main/docs/assets/banner-dark.png"><img src="https://raw.githubusercontent.com/bompus/swarmail/main/docs/assets/banner-light.png" alt="swarmail: ${TAGLINE}"></picture>`;
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

/** A tree whose banner alt text, rendered-asset record and images are all current. */
function tree(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "swarmail-public-"));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const images = Object.fromEntries(
    IMAGES.map((image) => {
      write(`docs/assets/${image}`, `pixels of ${image}`);
      return [image, createHash("sha256").update(`pixels of ${image}`).digest("hex")];
    }),
  );
  write("docs/assets/source.json", JSON.stringify({ ...assetText(), images }));
  write("README.md", `<img alt="swarmail: ${TAGLINE}">`);
  write("packages/mcp-relay/README.md", npmBanner);
  for (const [path, text] of Object.entries(files)) {
    write(path, text);
  }
  return root;
}

test("a current tree has no problems", () => {
  expect(publicProblems(tree())).toEqual([]);
});

test.each([
  "Local mail between coding-agent sessions on one machine",
  "Swarmail is local-only.",
  "It runs on a single machine.",
  "Swarmail is a trusted local service.",
  "Swarmail must be running on this machine.",
  "Swarmail runs on one computer.",
  "Nothing leaves your machine.",
  "Local\nmail between sessions",
  "on one machine,\nand no other",
  String.raw`"Local\nmail between coding-agent sessions on one\ncomputer"`,
  '"Swarmail provides local " + "mail between sessions."',
])("rejects %j", (text) => {
  expect(STALE_SCOPE.test(readable(text))).toBe(true);
  expect(publicProblems(tree({ "docs/usage.md": text }), ["docs/usage.md"])[0]).toContain(
    "docs/usage.md",
  );
});

test.each([
  "It runs on one machine by default.",
  "It runs on one machine, by default.",
  "It runs on a single machine by default.",
  "Mail on a single machine or across machines.",
  "Mail on one machine or across machines.",
  "Connects Codex to a Swarmail server running on this machine or another.",
  "Connects to a server running on this machine, or on another.",
  "Mail on one machine\nor across machines.",
  "The database holds mail on your computer, where the server runs.",
])("accepts %j", (text) => {
  expect(publicProblems(tree({ "docs/usage.md": text }), ["docs/usage.md"])).toEqual([]);
});

test("a folder counts every text file under it", () => {
  const root = tree({ "packages/plugin/skills/SKILL.md": "Swarmail is local mail." });
  expect(publicProblems(root, ["packages"])[0]).toContain(
    join("packages", "plugin", "skills", "SKILL.md"),
  );
});

test("names a README banner whose alt text differs from the tagline", () => {
  const root = tree({ "README.md": '<img alt="swarmail: Local mail">' });
  expect(publicProblems(root, [])).toEqual([
    `README.md: banner alt text must read "swarmail: ${TAGLINE}"`,
  ]);
});

test.each([
  "# swarmail-mcp",
  `<img alt="swarmail: ${TAGLINE}">`,
  `<picture><source srcset="../../docs/assets/banner-dark.png"><img src="../../docs/assets/banner-light.png" alt="swarmail: ${TAGLINE}"></picture>`,
  npmBanner.replace("banner-light.png", "missing.png"),
  npmBanner.replace("banner-dark.png", "missing.png"),
  npmBanner.replace(TAGLINE, "Outdated description"),
  npmBanner.replace(/<\/?picture>/g, ""),
  `<!-- ${npmBanner} -->`,
  `<picture><!-- ${npmBanner} --></picture>`,
])("rejects an npm README without a hosted banner: %s", (readme) => {
  const root = tree({ "packages/mcp-relay/README.md": readme });
  expect(
    publicProblems(root, []).some((problem) => problem.includes("packages/mcp-relay/README.md")),
  ).toBe(true);
});

test("names a missing npm README", () => {
  const root = tree();
  rmSync(join(root, "packages/mcp-relay/README.md"));
  expect(
    publicProblems(root, []).some((problem) => problem.includes("packages/mcp-relay/README.md")),
  ).toBe(true);
});

test("names rendered-asset text that differs from the tagline", () => {
  const root = tree({
    "docs/assets/source.json": JSON.stringify({ ...assetText(), tagline: "old", images: {} }),
  });
  expect(publicProblems(root, []).some((problem) => problem.includes("tagline differs"))).toBe(
    true,
  );
});

test("an image changed after rendering, or missing, is named", () => {
  const root = tree({ "docs/assets/banner-dark.png": "an older drawing" });
  rmSync(join(root, "docs/assets/social-preview.png"));
  const problems = publicProblems(root, []);
  expect(problems.some((problem) => problem.includes("banner-dark.png"))).toBe(true);
  expect(problems.some((problem) => problem.includes("social-preview.png"))).toBe(true);
  expect(problems).toHaveLength(2);
});

test("a tree without the rendered-asset record is named", () => {
  const root = tree();
  rmSync(join(root, "docs/assets/source.json"));
  expect(publicProblems(root, [])[0]).toContain("source.json is missing");
});
