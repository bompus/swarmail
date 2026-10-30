import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// T3 Code's server sends `GET /` to new loopback listeners on a developer host. A stand-in server that parses every
// request as JSON throws on it, and the throw fails whichever test owns the server. Each handler that calls `req.json()`
// (or `request.json()`) must answer a stray request first, through `strayRequest` or a check of its own on `req.method`.
// This is a source scan, not a proof: it does not see other parameter names or other body readers, and a handler that
// reads a body in another way needs the same guard by hand.
test("every stand-in handler that calls json() answers a stray request first", () => {
  const dir = import.meta.dir;
  const parse = "." + "json()";
  const unguarded: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".test.ts"))) {
    if (file === "stray-request.test.ts") {
      continue;
    }
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/\b(req|request)\./.test(line) || !line.includes(parse)) {
        return;
      }
      let start = index;
      while (start >= 0 && !/\bfetch\((req|request)\b/.test(lines[start]!)) {
        start--;
      }
      const handler = start < 0 ? "" : lines.slice(start, index).join("\n");
      if (!/strayRequest\((req|request)\)|\b(req|request)\.method\b/.test(handler)) {
        unguarded.push(`${file}:${index + 1}`);
      }
    });
  }
  expect(unguarded).toEqual([]);
});
