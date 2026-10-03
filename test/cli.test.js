import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const dir = mkdtempSync(join(tmpdir(), "swarmail-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `import { main } from ${JSON.stringify(CLI)};\n${body}\n`);
  return (...args) => spawnSync(process.execPath, [path, ...args], { encoding: "utf8" });
};

test("an entry adds commands through main(), after the built-ins and without replacing one", () => {
  const run = entry(
    "extra.ts",
    `void main(process.argv.slice(2), {
  hello: { usage: ["swarmail hello  says hello"], run: async () => console.log("hello ran") },
  who: { usage: ["swarmail who  replaced"], run: async () => console.log("who replaced") },
});`,
  );
  expect(run("hello").stdout).toBe("hello ran\n");
  const help = run("--help").stdout;
  expect(help).toContain("swarmail hello");
  expect(help).not.toContain("replaced");
  expect(help.indexOf("swarmail version")).toBeLessThan(help.indexOf("swarmail hello"));
});

test("importing cli.ts runs nothing until main() is called", () => {
  const run = entry("quiet.ts", "void main;");
  const out = run("--help");
  expect(out.status).toBe(0);
  expect(out.stdout + out.stderr).toBe("");
});
