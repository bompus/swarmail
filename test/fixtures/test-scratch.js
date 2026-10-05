import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A short, unique scratch root for socket paths; TMPDIR controls its location. */
export function testScratch() {
  const dir = mkdtempSync(join(tmpdir(), "swm-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
