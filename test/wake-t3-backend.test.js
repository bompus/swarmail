import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import * as credentialModule from "../src/wake-credentials.ts";
import { credentialService, T3SessionTransportUnavailable } from "../src/wake-credentials.ts";
import { followT3Backend } from "../src/wake-t3-backend.ts";
import { verifyT3Backend } from "../src/wake-backend.ts";
import { BridgeError } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
const cleanup = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});

function fixture() {
  const root = join(scratch, crypto.randomUUID());
  const baseDir = join(root, "backend");
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  const database = new Database(join(baseDir, "userdata/state.sqlite"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  cleanup.push(
    () => database.close(),
    () => server.stop(true),
  );
  const url = `http://127.0.0.1:${server.port}`;
  const headerPath = join(root, "auth/header");
  const rotation = headerPath + ".rotation";
  mkdirSync(rotation, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "auth"), 0o700);
  const header = "Bearer synthetic-transport-fixture";
  writeFileSync(headerPath, header, { mode: 0o600 });
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const state = {
    binding: JSON.stringify({
      baseDir: resolve(baseDir),
      type: "t3-v2-queue",
      id: "fixture",
      headerPath,
    }),
    current: {
      sessionId: "fixture",
      expiresAt,
      digest: createHash("sha256").update(header).digest("hex"),
    },
    retired: [],
  };
  const statePath = join(rotation, "state.json");
  const save = (value = state) => writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 });
  save();
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      target: { type: "t3-v2-queue", id: "fixture", url, authorizationFile: headerPath },
      rotation: { baseDir, verifyBackend: true },
    }),
  );
  const runtimePath = join(baseDir, "userdata/server-runtime.json");
  const publish = (pid = process.pid) =>
    writeFileSync(runtimePath, JSON.stringify({ version: 1, pid, port: server.port }));
  publish();
  const journal = join(root, "protected-journal.json");
  writeFileSync(
    journal,
    JSON.stringify({ quarantine: { reason: "retained" }, pending: { commandId: "retained" } }),
  );
  const paths = [headerPath, statePath, journal];
  const snapshot = () => paths.map((p) => readFileSync(p, "utf8"));
  const response = () =>
    Response.json({
      authenticated: true,
      sessionMethod: "bearer-access-token",
      expiresAt,
      scopes: ["orchestration:operate"],
    });
  const spawn = Bun.spawn;
  const cli = [];
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command, options) => {
    if (Array.isArray(command) && command[0] !== "ss") {
      cli.push(command);
    }
    return spawn(command, options);
  });
  cleanup.push(() => spawnSpy.mockRestore());
  return {
    path,
    baseDir,
    url,
    state,
    save,
    publish,
    response,
    snapshot,
    cli,
    headerPath,
    rotation,
    server,
  };
}

function fetchMock(implementation) {
  const mock = spyOn(globalThis, "fetch").mockImplementation(implementation);
  cleanup.push(() => mock.mockRestore());
  return mock;
}
const transport = (code) =>
  Object.assign(new TypeError("synthetic error must not be logged"), { code });
const linuxTest = test.skipIf(process.platform !== "linux");

linuxTest(
  "cold-start transport failure retries the clean credential without renewal, then recovers",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
    const poll = followT3Backend(f.path, f);
    expect(await poll()).toBeUndefined();
    fetch.mockImplementation(f.response);
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(f.cli).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  },
);

linuxTest("only measured transport errors from eligible current checks are retryable", async () => {
  const f = fixture();
  const service = credentialService(f.path);
  const backend = await service.backend();
  const fetch = fetchMock(() => Promise.reject(transport("ECONNRESET")));
  await expect(service.current(backend)).rejects.toBeInstanceOf(T3SessionTransportUnavailable);
  for (const response of [
    () => Promise.reject(transport("UnexpectedRedirect")),
    () => Promise.reject(new TypeError("unrecognized")),
    () => new Response("broken JSON"),
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ authenticated: true, sessionMethod: "unknown" }),
  ]) {
    fetch.mockImplementation(response);
    await expect(service.current(backend)).rejects.toBeInstanceOf(BridgeError);
  }
  for (const change of [
    { disabled: true },
    { pending: { subject: "unfinished" } },
    { abandoned: ["unfinished"] },
    { retired: [f.state.current] },
  ]) {
    f.save({ ...f.state, ...change });
    fetch.mockClear();
    expect(await service.current(backend)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  }
  expect(f.cli).toEqual([]);
});

linuxTest(
  "identity is reverified before each outage retry and mismatches receive no token",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
    const poll = followT3Backend(f.path, f);
    expect(await poll()).toBeUndefined();
    // A published pid that does not own the socket is listener absence, never permission to send.
    f.publish(process.pid + 1000000);
    expect(await poll()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    // A different database path is a fatal identity mismatch.
    f.publish();
    const dbPath = join(f.baseDir, "userdata/statev2.sqlite");
    const other = new Database(dbPath);
    other.close();
    await expect(poll()).rejects.toBeInstanceOf(BridgeError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.snapshot()).toEqual(before);
    expect(f.cli).toEqual([]);
  },
);

linuxTest("shutdown wins a simultaneous own-timeout race without retry or mutation", async () => {
  const f = fixture();
  const before = f.snapshot();
  const service = credentialService(f.path);
  const backend = await service.backend();
  const caller = new AbortController();
  const timer = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
  cleanup.push(() => timeout.mockRestore());
  fetchMock(() => {
    timer.abort();
    caller.abort("private reason must not escape");
    return Promise.reject(new DOMException("synthetic", "TimeoutError"));
  });
  await expect(service.current(backend, { signal: caller.signal })).rejects.toThrow("cancelled");
  expect(f.snapshot()).toEqual(before);
  expect(f.cli).toEqual([]);
});

linuxTest("requests respect remaining grace and own timeout classification", async () => {
  const f = fixture();
  const service = credentialService(f.path);
  const backend = await service.backend();
  fetchMock(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  // No body/protocol failure is reclassified. Only expiry of this request's own signal is transient.
  const timer = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    expect(ms).toBeLessThanOrEqual(1000);
    queueMicrotask(() => timer.abort(new DOMException("synthetic", "TimeoutError")));
    return timer.signal;
  });
  cleanup.push(() => timeout.mockRestore());
  await expect(
    service.current(backend, { deadline: performance.now() + 1000 }),
  ).rejects.toBeInstanceOf(T3SessionTransportUnavailable);
  await expect(service.current(backend, { deadline: performance.now() })).rejects.toThrow(
    "grace exhausted",
  );
});

linuxTest(
  "all three-event orderings retain one outage deadline and never mutate ownership",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    let now = 0;
    let outcome = "ready";
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    const fetch = fetchMock(() =>
      outcome === "ready" ? f.response() : Promise.reject(transport(outcome)),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    cleanup.push(() => warn.mockRestore());
    const events = ["refused", "reset", "ready", "deadline", "cancel", "renewal", "disabled"];
    const violations = [];
    const sequences = events.flatMap((a) => events.flatMap((b) => events.map((c) => [a, b, c])));
    for (const sequence of sequences) {
      now = 0;
      outcome = "ready";
      f.save();
      fetch.mockClear();
      const shutdown = new AbortController();
      const poll = followT3Backend(f.path, f, shutdown.signal);
      let outageDeadline;
      for (const event of sequence) {
        if (event === "deadline") {
          now = outageDeadline ?? now + 300000;
        } else if (event === "cancel") {
          shutdown.abort();
        } else if (event === "renewal") {
          f.save({
            ...f.state,
            current: { ...f.state.current, expiresAt: new Date(Date.now() + 1000).toISOString() },
          });
        } else if (event === "disabled") {
          f.save({ ...f.state, disabled: true });
        } else {
          outcome =
            event === "refused" ? "ConnectionRefused" : event === "reset" ? "ECONNRESET" : "ready";
        }
        // State changes outside an outage belong to the legacy renewal path.
        if (outageDeadline === undefined && (event === "renewal" || event === "disabled")) {
          break;
        }
        if (event !== "deadline") {
          now += 1000;
        }
        const calls = fetch.mock.calls.length;
        try {
          const ready = await poll();
          if (shutdown.signal.aborted || (outageDeadline !== undefined && now >= outageDeadline)) {
            violations.push(`${sequence}: resumed after stop/deadline`);
          }
          if (ready) {
            outageDeadline = undefined;
          } else if (outageDeadline === undefined) {
            outageDeadline = now + 300000;
          }
        } catch (error) {
          if (!(error instanceof BridgeError)) {
            violations.push(`${sequence}: unsafe failure`);
          }
          break; // The consumer stops after a fatal failure.
        }
        if (shutdown.signal.aborted && fetch.mock.calls.length !== calls) {
          violations.push(`${sequence}: request after cancellation`);
        }
        if (f.cli.length) {
          violations.push(`${sequence}: CLI entered during outage`);
        }
      }
    }
    f.save();
    expect(f.snapshot()).toEqual(before);
    expect(violations).toEqual([]);
    expect(f.cli).toEqual([]);
  },
  20000,
);

linuxTest("rejection during an outage stops without entering credential recovery", async () => {
  const f = fixture();
  const before = f.snapshot();
  const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
  const poll = followT3Backend(f.path, f);
  expect(await poll()).toBeUndefined();
  fetch.mockImplementation(() => new Response(null, { status: 401 }));
  await expect(poll()).rejects.toThrow("no longer eligible");
  expect(f.snapshot()).toEqual(before);
  expect(f.cli).toEqual([]);
});

linuxTest("ownership changed during an in-flight session check cannot become ready", async () => {
  const f = fixture();
  const service = credentialService(f.path);
  const backend = await service.backend();
  fetchMock(() => {
    f.save({ ...f.state, disabled: true });
    return f.response();
  });
  expect(await service.current(backend)).toBeUndefined();
  expect(f.cli).toEqual([]);
});

linuxTest("shutdown aborts and reaps the owned identity subprocess", async () => {
  const shutdown = new AbortController();
  const spawn = Bun.spawn;
  let child;
  const probe = spyOn(Bun, "spawn").mockImplementation((_command, options) => {
    child = spawn([process.execPath, "-e", "await new Promise(() => {})"], options);
    queueMicrotask(() => shutdown.abort("private reason"));
    return child;
  });
  cleanup.push(() => probe.mockRestore());
  await expect(
    verifyT3Backend(
      { url: "http://127.0.0.1:12345", baseDir: scratch },
      { signal: shutdown.signal },
    ),
  ).rejects.toThrow("cancelled");
  expect(await child.exited).not.toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrow();
});

linuxTest("cold start refuses unsafe credential directories before any token request", async () => {
  for (const unsafe of [
    "parent permissions",
    "rotation permissions",
    "rotation symlink",
    "noncanonical ancestor",
  ]) {
    const f = fixture();
    const before = f.snapshot();
    const fetch = fetchMock(f.response);
    if (unsafe === "parent permissions") {
      chmodSync(join(f.headerPath, ".."), 0o777);
    }
    if (unsafe === "rotation permissions") {
      chmodSync(f.rotation, 0o777);
    }
    if (unsafe === "rotation symlink") {
      renameSync(f.rotation, f.rotation + ".saved");
      symlinkSync(f.rotation + ".saved", f.rotation);
    }
    if (unsafe === "noncanonical ancestor") {
      const root = join(f.baseDir, "..");
      symlinkSync(root, root + ".alias");
      const config = JSON.parse(readFileSync(f.path, "utf8"));
      config.target.authorizationFile = join(root + ".alias", "auth/header");
      writeFileSync(f.path, JSON.stringify(config));
    }
    const poll = followT3Backend(f.path, f);
    await expect(poll()).rejects.toBeInstanceOf(BridgeError);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.cli).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  }
});

linuxTest("the owned request timeout is transient even after response headers arrive", async () => {
  const f = fixture();
  const before = f.snapshot();
  f.server.reload({
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"authenticated":true,'));
          },
        }),
      ),
  });
  const service = credentialService(f.path);
  const backend = await service.backend();
  const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => actualTimeout(20));
  cleanup.push(() => timeout.mockRestore());
  await expect(service.current(backend)).rejects.toBeInstanceOf(T3SessionTransportUnavailable);
  expect(f.snapshot()).toEqual(before);
  expect(f.cli).toEqual([]);
});

linuxTest(
  "listener absence preserves the existing renewal path when no transport retry occurred",
  async () => {
    const f = fixture();
    const service = credentialService(f.path);
    const factory = spyOn(credentialModule, "credentialService").mockReturnValue(service);
    const renew = spyOn(service, "renew").mockResolvedValue({ status: "current", url: f.url });
    cleanup.push(
      () => factory.mockRestore(),
      () => renew.mockRestore(),
    );
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    f.publish(process.pid + 1000000);
    const poll = followT3Backend(f.path, f);
    expect(await poll()).toBeUndefined();
    now = 1000;
    f.publish();
    f.save({
      ...f.state,
      current: { ...f.state.current, expiresAt: new Date(Date.now() + 1000).toISOString() },
    });
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew.mock.calls[0][2].deadline).toBe(300000);
    expect(f.cli).toEqual([]);
  },
);

linuxTest(
  "a later eligible transport failure still forbids recovery within a listener outage",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
    const poll = followT3Backend(f.path, f);
    f.publish(process.pid + 1000000);
    expect(await poll()).toBeUndefined();
    f.publish();
    expect(await poll()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    f.save({ ...f.state, disabled: true });
    await expect(poll()).rejects.toThrow("no longer eligible");
    expect(f.cli).toEqual([]);
    f.save();
    expect(f.snapshot()).toEqual(before);
  },
);

linuxTest(
  "verified readiness clears the transport restriction for the next listener outage",
  async () => {
    const f = fixture();
    const service = credentialService(f.path);
    const factory = spyOn(credentialModule, "credentialService").mockReturnValue(service);
    const renew = spyOn(service, "renew").mockResolvedValue({ status: "current", url: f.url });
    cleanup.push(
      () => factory.mockRestore(),
      () => renew.mockRestore(),
    );
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
    const poll = followT3Backend(f.path, f);
    expect(await poll()).toBeUndefined();
    fetch.mockImplementation(f.response);
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    now = 61000;
    f.publish(process.pid + 1000000);
    expect(await poll()).toBeUndefined();
    f.publish();
    f.save({ ...f.state, pending: { subject: "unfinished" } });
    expect(await poll()).toEqual({ url: f.url, moved: false, restarted: false });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew.mock.calls[0][2].deadline).toBe(361000);
    expect(f.cli).toEqual([]);
  },
);
