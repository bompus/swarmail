import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverT3Backend,
  T3IdentityPending,
  T3Unavailable,
  verifyT3Backend,
} from "../src/wake-backend.ts";
import { BridgeError } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.ts";

const scratch = testScratch();

test.skipIf(process.platform !== "linux")(
  "backend verification binds the listening executable to its open database",
  async () => {
    const root = mkdtempSync(join(scratch, "case-"));
    mkdirSync(join(root, "userdata"));
    const path = join(root, "userdata/statev2.sqlite");
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
      expect(verifyT3Backend(config)).resolves.toBe(listener);
      const { executable, ...unpinned } = config;
      expect(verifyT3Backend(unpinned)).resolves.toBe(listener);
      const otherAddress = Bun.serve({
        hostname: "127.0.0.2",
        port: 0,
        fetch: () => new Response("other address"),
      });
      try {
        expect(
          verifyT3Backend({ ...config, url: `http://127.0.0.1:${otherAddress.port}` }),
        ).rejects.toThrow("unavailable; retrying");
      } finally {
        await otherAddress.stop(true);
      }
      for (const mismatch of [
        { executable: "/bin/false" },
        { executable: join(root, "removed-runtime") },
        { baseDir: join(root, "other-store") },
      ]) {
        expect(verifyT3Backend({ ...config, ...mismatch })).rejects.toThrow(
          "stop the timer and reconcile",
        );
      }
      // T3 publishes its listener; the published port wins over the configured fallback.
      const runtime = join(root, "userdata/server-runtime.json");
      const publish = (fields: { version?: number; pid?: number; port?: number }) =>
        writeFileSync(
          runtime,
          JSON.stringify({ version: 1, pid: process.pid, port: server.port, ...fields }),
        );
      const discover = async (url?: string) => {
        const backend = await discoverT3Backend({
          executable: process.execPath,
          baseDir: root,
          url,
        });
        expect(backend.executable).toBe(listener);
        return backend.url;
      };
      expect(discover()).rejects.toThrow("unavailable; retrying");
      expect(discover(config.url)).resolves.toBe(config.url);
      publish({});
      expect(discover("http://127.0.0.1:1")).resolves.toBe(config.url);
      for (const stale of [{ pid: process.pid + 1 }, { port: 0 }]) {
        publish(stale);
        expect(discover(config.url)).rejects.toThrow("unavailable; retrying");
      }
      publish({ version: 2 });
      expect(discover(config.url)).rejects.toThrow("backend identity");
      writeFileSync(runtime, "{");
      expect(discover(config.url)).rejects.toThrow("unavailable; retrying");
      publish({});
      expect(discoverT3Backend({ executable: "/bin/false", baseDir: root })).rejects.toThrow(
        "backend identity",
      );
      // Matching path text is insufficient after a data file is replaced.
      renameSync(path, path + ".old");
      writeFileSync(path, "replacement");
      expect(verifyT3Backend(config)).rejects.toThrow("backend identity");
      renameSync(path + ".old", path);
      expect(verifyT3Backend(config)).resolves.toBe(listener);
      await server.stop(true);
      expect(verifyT3Backend(config)).rejects.toThrow("unavailable; retrying");
      expect(discover()).rejects.toThrow("unavailable; retrying");
    } finally {
      await server.stop(true);
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const cleanups: (() => unknown)[] = [];
/** A pid that has just exited, so its /proc entry is gone. */
const exitedPid = Bun.spawnSync(["true"]).pid;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A T3 stand-in in this process: its database file exists, and `hold()` opens it as T3 does once it is up. */
function listener() {
  const root = mkdtempSync(join(scratch, "case-"));
  mkdirSync(join(root, "userdata"));
  const path = join(root, "userdata/statev2.sqlite");
  new Database(path, { create: true }).close(); // The file exists; no descriptor holds it.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  let database: Database | undefined;
  cleanups.push(
    () => server.stop(true),
    () => database?.close(),
    () => rmSync(root, { recursive: true, force: true }),
  );
  return {
    root,
    path,
    port: server.port!,
    config: { url: `http://127.0.0.1:${server.port}`, executable: process.execPath, baseDir: root },
    hold: () => {
      database = new Database(path);
    },
  };
}

/** Makes the `ss` call report `lines`, leaving every other subprocess alone. */
function fakeSockets(lines: (port: number) => string, exit = 0) {
  const spawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((command: any, options: any) => {
    if (Array.isArray(command) && command[0] === "ss") {
      const port = Number(String(command.at(-1)).replace(/\D/g, ""));
      return { stdout: new Response(lines(port)).body, exited: Promise.resolve(exit) };
    }
    return spawn(command, options);
  }) as typeof Bun.spawn);
  cleanups.push(() => spy.mockRestore());
}

const sockets = (port: number, ...pids: number[]) =>
  pids
    .map((pid) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("t3",pid=${pid},fd=20))`)
    .join("\n");

test.skipIf(process.platform !== "linux")(
  "a listener that has not opened T3's database yet is pending, not a mismatch",
  async () => {
    const t3 = listener();
    const pending = await verifyT3Backend(t3.config).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(T3IdentityPending);
    expect(pending).toBeInstanceOf(T3Unavailable); // Callers that only wait keep working.
    expect((pending as T3IdentityPending).message).toContain("not yet");
    // The same refusal is raised, unchanged, for a caller that has waited long enough.
    let refusal: unknown;
    try {
      (pending as T3IdentityPending).giveUp();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BridgeError);
    expect((refusal as BridgeError).message).toContain("stop the timer and reconcile");
    t3.hold();
    expect(await verifyT3Backend(t3.config)).toBe(realpathSync(process.execPath));
  },
);

test.skipIf(process.platform !== "linux")(
  "a descriptor that closes during the scan is pending; any other inspection error is a refusal",
  async () => {
    const t3 = listener();
    const readlink = fs.readlinkSync;
    const failWith = (code: string) => {
      const spy = spyOn(fs, "readlinkSync").mockImplementation(((path: string, ...rest: any[]) => {
        if (String(path).startsWith(`/proc/${process.pid}/fd/`)) {
          throw Object.assign(new Error(code), { code });
        }
        return (readlink as any)(path, ...rest);
      }) as typeof fs.readlinkSync);
      cleanups.push(() => spy.mockRestore());
      return spy;
    };
    // Every descriptor vanishing mid-scan reads as a listener that has not opened its database yet.
    failWith("ENOENT");
    expect(await verifyT3Backend(t3.config).catch((e: unknown) => e)).toBeInstanceOf(
      T3IdentityPending,
    );
    // An error that is not a vanished descriptor must not read as "not open yet".
    for (const code of ["EIO", "EACCES", "EMFILE"]) {
      cleanups.pop()!();
      failWith(code);
      const error = await verifyT3Backend(t3.config).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BridgeError);
      expect(error).not.toBeInstanceOf(T3IdentityPending);
      expect((error as BridgeError).message).not.toContain(code);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a listener that holds a different T3 database, or no database file exists, is a mismatch at once",
  async () => {
    const t3 = listener();
    // The process holds a database named like T3's, but not the configured file.
    const other = new Database(t3.path + ".old", { create: true });
    cleanups.push(() => other.close());
    expect(verifyT3Backend(t3.config)).rejects.toThrow("stop the timer and reconcile");
    expect(await verifyT3Backend(t3.config).catch((e: unknown) => e)).not.toBeInstanceOf(
      T3IdentityPending,
    );
    // No database at the configured place at all.
    const empty = mkdtempSync(join(scratch, "case-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const missing = await verifyT3Backend({ ...t3.config, baseDir: empty }).catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(BridgeError);
    expect(missing).not.toBeInstanceOf(T3IdentityPending);
    // A verified different executable is a mismatch too.
    t3.hold();
    const wrong = await verifyT3Backend({ ...t3.config, executable: "/bin/false" }).catch(
      (error: unknown) => error,
    );
    expect(wrong).toBeInstanceOf(BridgeError);
    expect(wrong).not.toBeInstanceOf(T3IdentityPending);
  },
);

test.skipIf(process.platform !== "linux")(
  "two listeners on the port, a listener whose pid is not shown, and a process that exits mid-check are pending",
  async () => {
    const t3 = listener();
    t3.hold();
    fakeSockets((port) => sockets(port, process.pid, process.pid + 1));
    expect(await verifyT3Backend(t3.config).catch((e: unknown) => e)).toBeInstanceOf(
      T3IdentityPending,
    );
    fakeSockets((port) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`);
    expect(await verifyT3Backend(t3.config).catch((e: unknown) => e)).toBeInstanceOf(
      T3IdentityPending,
    );
    // The configured database is missing: a known configuration failure, refused even for owners that look pending.
    const empty = mkdtempSync(join(scratch, "case-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    for (const lines of [
      (port: number) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`,
      (port: number) => sockets(port, process.pid, process.pid + 1),
    ]) {
      fakeSockets(lines);
      const missing = await verifyT3Backend({ ...t3.config, baseDir: empty }).catch(
        (e: unknown) => e,
      );
      expect(missing).toBeInstanceOf(BridgeError);
      expect(missing).not.toBeInstanceOf(T3IdentityPending);
    }
    // The same for a listener that has vanished, and for a pinned executable that does not exist.
    fakeSockets((port) => sockets(port, exitedPid));
    const gone = await verifyT3Backend({ ...t3.config, baseDir: empty }).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(BridgeError);
    expect(gone).not.toBeInstanceOf(T3IdentityPending);
    fakeSockets((port) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`);
    const unpinned = await verifyT3Backend({
      ...t3.config,
      executable: join(t3.root, "removed-runtime"),
    }).catch((e: unknown) => e);
    expect(unpinned).toBeInstanceOf(BridgeError);
    expect(unpinned).not.toBeInstanceOf(T3IdentityPending);
    // A failing `ss` is a refusal even when its partial output would otherwise read as pending.
    fakeSockets((port) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`, 1);
    const failed = await verifyT3Backend(t3.config).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(BridgeError);
    expect(failed).not.toBeInstanceOf(T3IdentityPending);
    // A pid that is gone by the time its /proc entry is read.
    fakeSockets((port) => sockets(port, exitedPid));
    expect(await verifyT3Backend(t3.config).catch((e: unknown) => e)).toBeInstanceOf(
      T3IdentityPending,
    );
  },
);
