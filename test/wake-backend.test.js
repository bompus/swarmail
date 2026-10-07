import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverT3Backend, verifyT3Backend } from "../src/wake-backend.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch("swarmail-backend-tests", "local backend identity contract");

test.skipIf(process.platform !== "linux")(
  "backend verification binds the listening executable to its open database",
  async () => {
    const root = mkdtempSync(join(scratch, "case-"));
    mkdirSync(join(root, "userdata"));
    const path = join(root, "userdata/state.sqlite");
    const database = new Database(path, { create: true });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const config = {
      url: `http://127.0.0.1:${server.port}`,
      executable: process.execPath,
      baseDir: root,
    };
    // The verified listener's binary is the CLI to run, so an upgrade needs no configured path.
    const listener = realpathSync(process.execPath);
    try {
      await expect(verifyT3Backend(config)).resolves.toBe(listener);
      const { executable, ...unpinned } = config;
      await expect(verifyT3Backend(unpinned)).resolves.toBe(listener);
      const otherAddress = Bun.serve({
        hostname: "127.0.0.2",
        port: 0,
        fetch: () => new Response("other address"),
      });
      try {
        await expect(
          verifyT3Backend({ ...config, url: `http://127.0.0.1:${otherAddress.port}` }),
        ).rejects.toThrow("unavailable; retrying");
      } finally {
        otherAddress.stop(true);
      }
      for (const mismatch of [
        { executable: "/bin/false" },
        { executable: join(root, "removed-runtime") },
        { baseDir: join(root, "other-store") },
      ]) {
        await expect(verifyT3Backend({ ...config, ...mismatch })).rejects.toThrow(
          "stop the timer and reconcile",
        );
      }
      // T3 publishes its listener; the published port wins over the configured fallback.
      const runtime = join(root, "userdata/server-runtime.json");
      const publish = (fields) =>
        writeFileSync(
          runtime,
          JSON.stringify({ version: 1, pid: process.pid, port: server.port, ...fields }),
        );
      const discover = async (url) => {
        const backend = await discoverT3Backend({
          executable: process.execPath,
          baseDir: root,
          url,
        });
        expect(backend.executable).toBe(listener);
        return backend.url;
      };
      await expect(discover()).rejects.toThrow("unavailable; retrying");
      await expect(discover(config.url)).resolves.toBe(config.url);
      publish({});
      await expect(discover("http://127.0.0.1:1")).resolves.toBe(config.url);
      for (const stale of [{ pid: process.pid + 1 }, { port: 0 }]) {
        publish(stale);
        await expect(discover(config.url)).rejects.toThrow("unavailable; retrying");
      }
      publish({ version: 2 });
      await expect(discover(config.url)).rejects.toThrow("backend identity");
      writeFileSync(runtime, "{");
      await expect(discover(config.url)).rejects.toThrow("unavailable; retrying");
      publish({});
      await expect(discoverT3Backend({ executable: "/bin/false", baseDir: root })).rejects.toThrow(
        "backend identity",
      );
      // Matching path text is insufficient after a data file is replaced.
      renameSync(path, path + ".old");
      writeFileSync(path, "replacement");
      await expect(verifyT3Backend(config)).rejects.toThrow("backend identity");
      renameSync(path + ".old", path);
      await expect(verifyT3Backend(config)).resolves.toBe(listener);
      // Once V2 has created its database, the listener must hold that one, not V1's frozen file.
      const v2Path = join(root, "userdata/statev2.sqlite");
      new Database(v2Path, { create: true }).close();
      await expect(verifyT3Backend(config)).rejects.toThrow("backend identity");
      const v2 = new Database(v2Path);
      try {
        await expect(verifyT3Backend(config)).resolves.toBe(listener);
      } finally {
        v2.close();
      }
      server.stop(true);
      await expect(verifyT3Backend(config)).rejects.toThrow("unavailable; retrying");
      await expect(discover()).rejects.toThrow("unavailable; retrying");
    } finally {
      server.stop(true);
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
