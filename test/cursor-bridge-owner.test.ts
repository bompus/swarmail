import { expect, test } from "bun:test";
import { join } from "node:path";

test("Cursor hooks leave a settled automatic T3 registration to its bridge and keep the native hook for every other registration", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { testScratch } = await import("./fixtures/test-scratch.ts");
  const scratch = testScratch();
  const dir = mkdtempSync(join(scratch, "case-"));
  const registry = join(dir, "swarmail-register");
  mkdirSync(registry, { recursive: true });
  let requests = 0;
  let eventId = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/wait/status") {
        return Response.json({ eligible: true });
      }
      requests++;
      return new URL(req.url).pathname === "/healthz"
        ? Response.json({ ok: true })
        : new Response("Swarmail: fixture mail", {
            headers: { "x-swarmail-event-id": String(++eventId) },
          });
    },
  });
  const valid = {
    name: "BlueLake",
    projects: ["repo"],
    tags: { repo: "[t3:thread-a cursor:native-cursor cwd:repo]" },
    wakeThread: "thread-a",
  };
  const cases = [
    ["enrolled", valid, true],
    ["native", { ...valid, wakeThread: undefined }, false],
    ["ended", { ...valid, ended: "ended" }, false],
    ["unnamed", { ...valid, name: null }, false],
    ["pending", { ...valid, pending: { project: "repo", tag: valid.tags.repo } }, false],
    ["mismatched thread", { ...valid, wakeThread: "other-thread" }, false],
    [
      "mismatched session",
      { ...valid, tags: { repo: "[t3:thread-a cursor:other-session cwd:repo]" } },
      false,
    ],
    [
      "other host",
      { ...valid, tags: { repo: "[t3:thread-a claude:native-cursor cwd:repo]" } },
      false,
    ],
    [
      "reordered tag",
      { ...valid, tags: { repo: "[cursor:native-cursor t3:thread-a cwd:repo]" } },
      false,
    ],
    ["incomplete tag", { ...valid, tags: { repo: "[t3:thread-a cursor:native-cursor]" } }, false],
    ["malformed", "{", false],
  ];
  try {
    for (const mode of ["wake", "context"]) {
      for (const [label, state, owned] of cases) {
        writeFileSync(
          join(registry, "native-cursor.json"),
          typeof state === "string" ? state : JSON.stringify(state),
        );
        requests = 0;
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../src/cli.ts"),
            "hook",
            mode,
            "cursor",
            ...(mode === "wake" ? ["2"] : []),
          ],
          {
            env: {
              ...process.env,
              XDG_STATE_HOME: dir,
              SWARMAIL_UPDATE_TARGETS: "",
              SWARMAIL_WAKE_URL: `http://127.0.0.1:${server.port}`,
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        child.stdin.write(JSON.stringify({ conversation_id: "native-cursor" }));
        child.stdin.end();
        const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        expect({ label, code, output: JSON.parse(output), requests }).toEqual({
          label,
          code: 0,
          output: owned
            ? {}
            : mode === "wake"
              ? { followup_message: "Swarmail: fixture mail" }
              : state.ended
                ? {}
                : { additional_context: "Swarmail: fixture mail" },
          requests: owned || (mode === "context" && state.ended) ? 0 : mode === "wake" ? 2 : 1,
        });
      }
    }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
