#!/usr/bin/env bun
// Fills cases/<case>.md from a Swarmail tree into <out>/<case>-<arm>.md for behavior-check.ts.
//   bun build-prompts.ts --tree <public tree> --arm <name> --out <dir> [--cases inbox,notify]
//     [--tools <tools/list JSON>] [--rules <file>]
// {{DOC}} gets the tree file its <document> title names (README.md or docs/usage.md). {{TOOLS}} gets one
// line per tool from a tools/list response; without --tools it asks the server on 127.0.0.1:18765.
// --rules replaces docs/usage.md with that file (front matter dropped), to test other rule wording.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Tool = {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
};

export function toolLines(tools: Tool[]): string {
  return tools
    .map(({ name, description, inputSchema: { properties, required = [] } }) => {
      const args = Object.keys(properties).map((p) => (required.includes(p) ? p : `${p}?`));
      return `- ${name}(${args.join(", ")}): ${description}`;
    })
    .join("\n");
}

export function fill(
  template: string,
  tree: string,
  tools: string,
  rules?: { title: string; text: string },
): string {
  const filled = template.replace(
    /<document title="([^"]*)">\n\{\{DOC\}\}\n<\/document>/g,
    (_, title: string) => {
      const path = title.split(" ")[0]!;
      // The recorded prompts end each document with a blank line.
      const block = (name: string, text: string) =>
        `<document title="${name}">\n${text.trim()}\n\n</document>`;
      return rules && path === "docs/usage.md"
        ? block(rules.title, rules.text)
        : block(title, readFileSync(join(tree, path), "utf8"));
    },
  );
  if (filled.includes("{{DOC}}")) {
    throw new Error("a {{DOC}} placeholder is outside a <document> block");
  }
  return filled.replace("{{TOOLS}}", tools);
}

async function listTools(file?: string): Promise<Tool[]> {
  const body = file
    ? readFileSync(file, "utf8")
    : await (
        await fetch("http://127.0.0.1:18765/mcp/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).text();
  return JSON.parse(body).result.tools;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      tree: { type: "string" },
      arm: { type: "string" },
      out: { type: "string" },
      cases: { type: "string" },
      tools: { type: "string" },
      rules: { type: "string" },
    },
  });
  if (!values.tree || !values.arm || !values.out) {
    console.error(
      "usage: bun build-prompts.ts --tree <dir> --arm <name> --out <dir> [--cases a,b] [--tools <file>] [--rules <file>]",
    );
    process.exit(2);
  }
  const dir = join(import.meta.dir, "cases");
  const cases = values.cases?.split(",") ?? readdirSync(dir).map((f) => f.replace(/\.md$/, ""));
  const tools = toolLines(await listTools(values.tools));
  const rules = values.rules
    ? {
        title: "Swarmail rules",
        text: readFileSync(values.rules, "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""),
      }
    : undefined;
  mkdirSync(values.out, { recursive: true });
  for (const name of cases) {
    const text = fill(readFileSync(join(dir, `${name}.md`), "utf8"), values.tree, tools, rules);
    writeFileSync(join(values.out, `${name}-${values.arm}.md`), text);
    console.log(join(values.out, `${name}-${values.arm}.md`));
  }
}
