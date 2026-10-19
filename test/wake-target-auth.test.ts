import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, t3Projection, TargetAuthenticationError } from "../src/wake-target.ts";

async function rejection(rotateBeforeAnswer: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "wake-target-auth-"));
  const authorizationFile = join(dir, "header");
  writeFileSync(authorizationFile, "Bearer old-token", { mode: 0o600 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (rotateBeforeAnswer) {
        // Rotation writes the new header, then revokes the token this request carried.
        writeFileSync(authorizationFile, "Bearer new-token", { mode: 0o600 });
      }
      return new Response(null, { status: 401 });
    },
  });
  try {
    return await t3Projection({
      type: "t3-v2-queue",
      url: `http://127.0.0.1:${server.port}`,
      id: "thread-1",
      authorizationFile,
    }).then(
      () => null,
      (error: unknown) => error,
    );
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a 401 for the header the file still holds stops as an authentication failure", async () => {
  const error = await rejection(false);
  expect(error).toBeInstanceOf(TargetAuthenticationError);
  expect((error as BridgeError).message).toBe("target HTTP 401");
});

test("a 401 for a header that rotation already replaced is retried", async () => {
  const error = await rejection(true);
  expect(error).toBeInstanceOf(BridgeError);
  expect(error).not.toBeInstanceOf(TargetAuthenticationError);
  expect((error as BridgeError).retryable).toBe(true);
});
