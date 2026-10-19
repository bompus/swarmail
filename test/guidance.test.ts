import { expect, test } from "bun:test";
import { AGENT_GUIDANCE } from "../src/guidance.ts";

// Claude Code cuts a server's connection instructions at 4096 characters. The last paragraph
// (the pointer to `swarmail updates --help`) was the part lost when this text ran to 4110.
test("connection instructions fit the 4096 characters a host shows", () => {
  expect(AGENT_GUIDANCE.length).toBeLessThanOrEqual(4096);
  expect(AGENT_GUIDANCE).toEndWith("read swarmail updates --help.");
});
