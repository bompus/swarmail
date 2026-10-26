import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publicProblems } from "../scripts/check-public.ts";
import { IMAGES, STALE_SCOPE, TAGLINE, assetText } from "../scripts/lib/brand.ts";

const roots: string[] = [];
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
])("rejects %j", (text) => {
  expect(STALE_SCOPE.test(text.replace(/\s+/g, " "))).toBe(true);
  expect(publicProblems(tree({ "docs/usage.md": text }), ["docs/usage.md"])[0]).toContain(
    "docs/usage.md",
  );
});

test.each([
  "It runs on one machine by default.",
  "It runs on one machine, by default.",
  "Mail on one machine or across machines.",
  "Mail on one machine\nor across machines.",
  "The database holds mail on your computer, where the server runs.",
])("accepts %j", (text) => {
  expect(publicProblems(tree({ "docs/usage.md": text }), ["docs/usage.md"])).toEqual([]);
});

test("a folder counts every text file under it", () => {
  const root = tree({ "packages/plugin/skills/SKILL.md": "Swarmail is local mail." });
  expect(publicProblems(root, ["packages"])[0]).toContain("packages/plugin/skills/SKILL.md");
});

test("names a README banner whose alt text differs from the tagline", () => {
  const root = tree({ "README.md": '<img alt="swarmail: Local mail">' });
  expect(publicProblems(root, [])).toEqual([
    `README.md: banner alt text must read "swarmail: ${TAGLINE}"`,
  ]);
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
