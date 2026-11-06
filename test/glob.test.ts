import { expect, test } from "bun:test";
import { covers, overlaps } from "../src/glob.ts";

test("two glob reservations that can match one file overlap", () => {
  expect(overlaps("src/*.ts", "src/a*")).toBe(true);
  expect(overlaps("src/a*", "src/*.ts")).toBe(true);
  expect(overlaps("src/?.ts", "src/[a-c].*")).toBe(true);
  expect(overlaps("src/[!a]x", "src/[!b]x")).toBe(true);
  expect(overlaps("*.md", "*.ts")).toBe(false);
  expect(overlaps("src/a*.ts", "src/b*.ts")).toBe(false);
  expect(overlaps("src/?.ts", "src/ab.ts")).toBe(false);
  expect(overlaps("src/[a-c]x", "src/[d-f]x")).toBe(false);
  expect(overlaps("src/[!a-c]x", "src/[a-c]x")).toBe(false);
});

test("a glob still covers the paths and directories it names", () => {
  expect(overlaps("src/*.ts", "src/a/b.ts")).toBe(true);
  expect(overlaps("docs", "docs/guide.md")).toBe(true);
  expect(overlaps("docs/", "docs/guide.md")).toBe(true);
  expect(overlaps("docs", "docsite/index.md")).toBe(false);
  expect(overlaps("docs", "docs/*.md")).toBe(true);
  expect(overlaps("src/*", "src/db.ts")).toBe(true);
});

test("a directory covers what is under it, whatever characters its name holds", () => {
  expect(overlaps("app/[slug]", "app/[slug]/page.tsx")).toBe(true);
  expect(overlaps("app/[slug]/", "app/[slug]/page.tsx")).toBe(true);
  expect(overlaps("app/[slug]/page.tsx", "app/[slug]")).toBe(true);
  expect(overlaps("docs", "docs/*.md")).toBe(true);
});

test("a plain path does not conflict with a glob that only matches it as a directory's content", () => {
  expect(overlaps("src/a.ts", "*.md")).toBe(false);
  expect(overlaps("README.md", "**/*.ts")).toBe(false);
  expect(overlaps("src/ax.ts", "src/*/x.ts")).toBe(false);
});

test("a set that ends at the last code point does not break matching", () => {
  expect(overlaps("a[\u{10ffff}]", "a?")).toBe(true);
  expect(overlaps("a[!\u{10ffff}]", "a\u{10ffff}")).toBe(false);
});

test("an empty reservation overlaps nothing but itself", () => {
  expect(overlaps("", "/work/repo/src/a.ts")).toBe(false);
  expect(overlaps("/work/repo/src/a.ts", "")).toBe(false);
  expect(overlaps("", "src/*")).toBe(false);
});

test("a ** segment covers zero or more directories", () => {
  expect(overlaps("src/**/x.ts", "src/x.ts")).toBe(true);
  expect(overlaps("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
  expect(overlaps("src/**/*.ts", "src/a.ts")).toBe(true);
  expect(overlaps("**/x.ts", "x.ts")).toBe(true);
  expect(overlaps("src/**/x.ts", "lib/x.ts")).toBe(false);
  expect(overlaps("src/**/x.ts", "src/x.ts")).toBe(true);
  expect(overlaps("src/**/x.ts", "src/ax.ts")).toBe(false);
  expect(overlaps("src/**/x.ts", "src/x.md")).toBe(false);
});

test("a [ with no closing ] is a literal, and brackets and braces match themselves", () => {
  expect(overlaps("a[]b", "a[]b")).toBe(true);
  expect(overlaps("a[]b", "axb")).toBe(false);
  expect(overlaps("a[b", "a[b")).toBe(true);
  expect(overlaps("a[b", "ab")).toBe(false);
  expect(overlaps("a{b}", "a{b}")).toBe(true);
  expect(overlaps("a{b}", "ab")).toBe(false);
  expect(overlaps("[a-c]x", "bx")).toBe(true);
  expect(overlaps("src/a(1).ts", "src/a?1?.ts")).toBe(true);
});

test("a long pattern pair is decided", () => {
  const a = "*a".repeat(40) + "b";
  expect(overlaps(a, "a".repeat(80) + "c")).toBe(false);
  expect(overlaps(a, "a".repeat(80) + "b")).toBe(true);
});

test("a reservation also matches the one file whose name it spells, and the guard reads a changed file literally", () => {
  expect(overlaps("app/*slug*/page.tsx", "app/[slug]/page.tsx")).toBe(true);
  expect(overlaps("app/[slug]/page.tsx", "app/*slug*/page.tsx")).toBe(true);
  expect(covers("app/*slug*/page.tsx", "app/[slug]/page.tsx")).toBe(true);
  expect(covers("f????", "f[ab]")).toBe(true);
  expect(covers("f[[]ab[]]", "f[ab]")).toBe(true);
  expect(covers("f?", "f[ab]")).toBe(false);
  expect(covers("app/[slug]", "app/[slug]/page.tsx")).toBe(true);
  expect(covers("src/*.ts", "src/a/b.ts")).toBe(true);
  expect(covers("", "src/a.ts")).toBe(false);
});

test("a pattern of many unclosed [ is read in linear time", () => {
  const start = performance.now();
  expect(overlaps("[".repeat(40_000), "a")).toBe(false);
  expect(overlaps("[".repeat(40_000), "[".repeat(40_000))).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
});
