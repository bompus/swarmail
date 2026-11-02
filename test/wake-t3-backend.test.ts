import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
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
import {
  credentialService,
  T3SessionRetry,
  T3SessionTransportUnavailable,
} from "../src/wake-credentials.ts";
import { followT3Backend, T3_RESTART_WAIT_MS } from "../src/wake-t3-backend.ts";
import { verifyT3Backend } from "../src/wake-backend.ts";
import { BridgeError } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.ts";

const scratch = testScratch();
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

function fixture() {
  const root = join(scratch, crypto.randomUUID());
  const baseDir = join(root, "backend");
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  const database = new Database(join(baseDir, "userdata/statev2.sqlite"));
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
  const save = (value: object = state) =>
    writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 });
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
  const cli: string[][] = [];
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((command: any, options: any) => {
    if (Array.isArray(command) && command[0] !== "ss") {
      cli.push(command);
    }
    return spawn(command, options);
  }) as typeof Bun.spawn);
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
    database,
    databasePath: join(baseDir, "userdata/statev2.sqlite"),
  };
}

type FetchImpl = (...args: any[]) => Response | Promise<Response>;
function fetchMock(implementation: FetchImpl) {
  const mock = spyOn(globalThis, "fetch") as unknown as Mock<FetchImpl>;
  mock.mockImplementation(implementation);
  cleanup.push(() => mock.mockRestore());
  return mock;
}
const transport = (code: string) =>
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

linuxTest("session scopes must be an array before a current credential is accepted", async () => {
  const f = fixture();
  const before = f.snapshot();
  const service = credentialService(f.path);
  const backend = await service.backend();
  const fetch = fetchMock(async () => {
    const response = (await f.response().json()) as object;
    return Response.json({ ...response, scopes: "orchestration:operate" });
  });
  expect(service.current(backend)).rejects.toThrow("unexpected T3 session contract");
  fetch.mockImplementation(f.response);
  expect(await service.current(backend)).toBeDefined();
  expect(f.cli).toEqual([]);
  expect(f.snapshot()).toEqual(before);
});

linuxTest("only measured transport errors from eligible current checks are retryable", async () => {
  const f = fixture();
  const service = credentialService(f.path);
  const backend = await service.backend();
  const fetch = fetchMock(() => Promise.reject(transport("ECONNRESET")));
  expect(service.current(backend)).rejects.toBeInstanceOf(T3SessionTransportUnavailable);
  for (const response of [
    () => Promise.reject(transport("UnexpectedRedirect")),
    () => Promise.reject(new TypeError("unrecognized")),
    () => new Response("broken JSON"),
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ authenticated: true, sessionMethod: "unknown" }),
  ]) {
    fetch.mockImplementation(response);
    expect(service.current(backend)).rejects.toBeInstanceOf(BridgeError);
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
    // A database file the listener does not hold is a fatal identity mismatch.
    f.publish();
    const dbPath = join(f.baseDir, "userdata/statev2.sqlite");
    renameSync(dbPath, dbPath + ".old");
    new Database(dbPath).close();
    expect(poll()).rejects.toBeInstanceOf(BridgeError);
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
  expect(service.current(backend, { signal: caller.signal })).rejects.toThrow("cancelled");
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
  expect(service.current(backend, { deadline: performance.now() + 1000 })).rejects.toBeInstanceOf(
    T3SessionTransportUnavailable,
  );
  expect(service.current(backend, { deadline: performance.now() })).rejects.toThrow(
    "grace exhausted",
  );
});

linuxTest(
  "all three-event orderings keep retrying across long outages without mutating ownership",
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
    const events = ["refused", "reset", "ready", "long outage", "cancel", "renewal", "disabled"];
    const violations = [];
    const sequences = events.flatMap((a) => events.flatMap((b) => events.map((c) => [a, b, c])));
    for (const sequence of sequences) {
      now = 0;
      outcome = "ready";
      f.save();
      fetch.mockClear();
      const shutdown = new AbortController();
      const poll = followT3Backend(f.path, f, shutdown.signal);
      let inOutage = false;
      for (const event of sequence) {
        if (event === "long outage") {
          now += 3 * 60 * 60_000;
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
        if (!inOutage && (event === "renewal" || event === "disabled")) {
          break;
        }
        if (event !== "long outage") {
          now += 1000;
        }
        const calls = fetch.mock.calls.length;
        try {
          const ready = await poll();
          if (shutdown.signal.aborted) {
            violations.push(`${sequence}: resumed after stop`);
          }
          if (ready) {
            inOutage = false;
          } else if (!inOutage) {
            inOutage = true;
          }
        } catch (error) {
          if (!(error instanceof BridgeError)) {
            violations.push(`${sequence}: unsafe failure`);
          } else if (!shutdown.signal.aborted && event !== "renewal" && event !== "disabled") {
            violations.push(`${sequence}: unexpected fatal failure: ${error.message}`);
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
  expect(poll()).rejects.toThrow("no longer eligible");
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
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const probe = spyOn(Bun, "spawn").mockImplementation(((_command: unknown, options: any) => {
    child = spawn([process.execPath, "-e", "await new Promise(() => {})"], options);
    queueMicrotask(() => shutdown.abort("private reason"));
    return child;
  }) as typeof Bun.spawn);
  cleanup.push(() => probe.mockRestore());
  expect(
    verifyT3Backend(
      { url: "http://127.0.0.1:12345", baseDir: scratch },
      { signal: shutdown.signal },
    ),
  ).rejects.toThrow("cancelled");
  expect(await child!.exited).not.toBe(0);
  expect(() => process.kill(child!.pid, 0)).toThrow();
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
    expect(poll()).rejects.toBeInstanceOf(BridgeError);
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
  expect(service.current(backend)).rejects.toBeInstanceOf(T3SessionTransportUnavailable);
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
    expect(renew.mock.calls[0]![2]!.deadline).toBe(301000);
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
    expect(poll()).rejects.toThrow("no longer eligible");
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
    expect(renew.mock.calls[0]![2]!.deadline).toBe(361000);
    expect(f.cli).toEqual([]);
  },
);

const failure = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
function quietWarnings() {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  return warn;
}
const retrying = (what: string) =>
  new RegExp(`^T3 session check got ${what}; retrying \\(\\d+ s of \\d+ s\\)$`);

linuxTest("the session check is retried for two minutes", () => {
  expect(T3_RESTART_WAIT_MS).toBe(120_000);
});

linuxTest(
  "a T3 restart that answers 503 for less than the window is waited out, one logged poll at a time",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const warn = quietWarnings();
    let calls = 0;
    const fetch = fetchMock(() =>
      ++calls <= 4 ? new Response("starting", { status: 503 }) : f.response(),
    );
    const poll = followT3Backend(f.path, f, undefined, 60_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await poll()).toBeUndefined();
    }
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    const retries = warn.mock.calls.map((call) => String(call[0]));
    expect(retries).toHaveLength(4);
    for (const line of retries) {
      expect(line).toMatch(retrying("HTTP 503"));
    }
    expect(f.cli).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  },
);

linuxTest("a T3 that answers 503 past the window fails with the original error", async () => {
  const f = fixture();
  const before = f.snapshot();
  quietWarnings();
  const fetch = fetchMock(() => new Response("down", { status: 503 }));
  // A controlled clock: the first failing poll starts the 150 ms window, the second is inside it, the third is past it.
  let now = performance.now();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const poll = followT3Backend(f.path, f, undefined, 150);
  expect(await poll()).toBeUndefined();
  now += 100;
  expect(await poll()).toBeUndefined();
  now += 100;
  const error = await failure(poll());
  expect(error).toBeInstanceOf(BridgeError);
  expect(error!.message).toBe("T3 session check failed; no credential issued");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(f.cli).toEqual([]);
  expect(f.snapshot()).toEqual(before);
});

linuxTest("the listener is verified again before each retry sends the token", async () => {
  const f = fixture();
  quietWarnings();
  const fetch = fetchMock(() => new Response("starting", { status: 503 }));
  const poll = followT3Backend(f.path, f, undefined, 60_000);
  expect(await poll()).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  // A published pid that does not own the socket is listener absence: no request, no token.
  f.publish(process.pid + 1000000);
  expect(await poll()).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

linuxTest("a rejected credential (401) is not retried", async () => {
  const f = fixture();
  const warn = quietWarnings();
  const service = credentialService(f.path);
  const backend = await service.backend();
  const fetch = fetchMock(() => new Response("no", { status: 401 }));
  expect(await service.current(backend, { retry: true })).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

linuxTest(
  "renewal's pre-issue session check asks to be retried only when the caller opts in",
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const service = credentialService(f.path);
    const backend = await service.backend();
    const fetch = fetchMock(() => Promise.reject(transport("ConnectionRefused")));
    const retry = await failure(service.renew(backend, false, { retry: true }));
    expect(retry).toBeInstanceOf(T3SessionRetry);
    expect(retry!.message).toBe("T3 session check got a refused connection; retrying");
    fetch.mockImplementation(() => new Response("starting", { status: 503 }));
    expect(await failure(service.renew(backend, false, { retry: true }))).toBeInstanceOf(
      T3SessionRetry,
    );
    // Without the opt-in, as `wake-credentials` runs it, both fail at once with a BridgeError.
    for (const answer of [
      () => Promise.reject(transport("ConnectionRefused")),
      () => new Response("starting", { status: 503 }),
    ]) {
      fetch.mockImplementation(answer);
      const error = await failure(service.renew(backend));
      expect(error).toBeInstanceOf(BridgeError);
      expect(error).not.toBeInstanceOf(T3SessionRetry);
    }
    fetch.mockImplementation(f.response);
    expect((await service.renew(backend, false, { retry: true })).status).toBe("current");
    expect(f.cli).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  },
);

linuxTest(
  "a response body that stalls past the request timeout is retried in renewal",
  async () => {
    const f = fixture();
    const service = credentialService(f.path);
    const backend = await service.backend();
    let timer = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => {
      timer = new AbortController();
      return timer.signal;
    });
    cleanup.push(() => timeout.mockRestore());
    fetchMock(() =>
      Object.assign(new Response("{}"), {
        json: () => {
          timer.abort(new DOMException("synthetic", "TimeoutError"));
          return Promise.reject(new DOMException("synthetic", "TimeoutError"));
        },
      }),
    );
    const retry = await failure(service.renew(backend, false, { retry: true }));
    expect(retry).toBeInstanceOf(T3SessionRetry);
    expect(retry!.message).toBe("T3 session check got no answer in time; retrying");
    expect(await failure(service.renew(backend))).toBeInstanceOf(BridgeError);
  },
);

linuxTest(
  "the caller is told before a listener that is new or was unavailable is verified, and when it stays unavailable",
  async () => {
    const f = fixture();
    quietWarnings();
    let calls = 0;
    const fetch = fetchMock(() =>
      ++calls <= 2 ? new Response("starting", { status: 503 }) : f.response(),
    );
    const verifying: string[] = [];
    const poll = followT3Backend(f.path, f, undefined, 60_000, () => verifying.push("verify"));
    // A listener not seen before: told when verification starts, and again when it fails.
    expect(await poll()).toBeUndefined();
    expect(verifying).toHaveLength(2);
    expect(await poll()).toBeUndefined(); // Still unavailable: the same two.
    expect(verifying).toHaveLength(4);
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(verifying).toHaveLength(5); // Recovering from unavailable is told when verification starts.
    expect(await poll()).toEqual({ url: f.url, moved: false, restarted: false });
    expect(verifying).toHaveLength(5); // The cached result needs no verification.
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

linuxTest(
  "the caller is told before a poll resolves unavailable, for example on an unreadable runtime file",
  async () => {
    const f = fixture();
    quietWarnings();
    fetchMock(f.response);
    const events: string[] = [];
    const poll = followT3Backend(f.path, f, undefined, 60_000, () => events.push("held"));
    expect(await poll()).toBeDefined();
    events.length = 0;
    // T3 rewriting its runtime file during a restart: unreadable, so unavailable, though the result was cached.
    writeFileSync(join(f.baseDir, "userdata/server-runtime.json"), "{");
    const result = poll().then((value) => {
      events.push("resolved");
      return value;
    });
    expect(await result).toBeUndefined();
    expect(events).toEqual(["held", "resolved"]);
  },
);

/** T3 as it is while it updates: the listener is up, but it has not opened its database yet. */
function mimicUpdate(f: ReturnType<typeof fixture>) {
  f.database.close();
  return () => {
    const reopened = new Database(f.databasePath);
    cleanup.push(() => reopened.close());
    return reopened;
  };
}

linuxTest(
  "a T3 mid-update whose identity cannot be verified yet is waited out with the gate closed, then resumes",
  async () => {
    const f = fixture();
    const warn = quietWarnings();
    fetchMock(f.response);
    const before = f.snapshot();
    const finishUpdate = mimicUpdate(f);
    const told: string[] = [];
    const poll = followT3Backend(f.path, f, undefined, 60_000, () => told.push("held"));
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await poll()).toBeUndefined();
    }
    expect(told.length).toBeGreaterThanOrEqual(3); // Told before every poll that could not verify.
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("identity"))).toHaveLength(1); // One line when the wait starts.
    finishUpdate();
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(f.cli).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  },
);

linuxTest(
  "an identity that stays unverifiable past the window exits as it did before",
  async () => {
    const f = fixture();
    quietWarnings();
    fetchMock(f.response);
    mimicUpdate(f);
    let now = performance.now();
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    const poll = followT3Backend(f.path, f, undefined, 150);
    expect(await poll()).toBeUndefined(); // The first failure starts the window.
    now += 100;
    expect(await poll()).toBeUndefined();
    now += 100;
    const error = await failure(poll());
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).retryable).toBe(false);
    expect(error!.message).toContain(
      "T3 backend identity unavailable or differs from configuration",
    );
    expect(error!.message).toContain("stop the timer and reconcile");
  },
);

linuxTest("a verified different identity exits at once, with no wait", async () => {
  const f = fixture();
  const warn = quietWarnings();
  fetchMock(f.response);
  // The listener holds a database named like T3's, but not the configured file: a real mismatch.
  renameSync(f.databasePath, f.databasePath + ".old");
  new Database(f.databasePath).close();
  const poll = followT3Backend(f.path, f, undefined, 60_000);
  const error = await failure(poll());
  expect(error).toBeInstanceOf(BridgeError);
  expect(error!.message).toContain("stop the timer and reconcile");
  expect(
    warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("identity")),
  ).toEqual([]);
});

linuxTest(
  "recovering from an identity wait reports a restart, so the held T3 database is reopened",
  async () => {
    const f = fixture();
    quietWarnings();
    fetchMock(f.response);
    let now = performance.now();
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    const poll = followT3Backend(f.path, f, undefined, 60_000);
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    expect(await poll()).toEqual({ url: f.url, moved: false, restarted: false }); // Cached, nothing happened.
    // T3 replaces its database while its identity cannot be verified, on the same URL and with no runtime file change.
    const finishUpdate = mimicUpdate(f);
    now += 70_000;
    expect(await poll()).toBeUndefined();
    finishUpdate();
    now += 1000;
    expect(await poll()).toEqual({ url: f.url, moved: false, restarted: true });
  },
);

linuxTest(
  "the restart report survives another failure between an identity wait and recovery",
  async () => {
    const f = fixture();
    quietWarnings();
    let calls = 0;
    let down = false;
    fetchMock(() =>
      down && ++calls <= 2 ? new Response("starting", { status: 503 }) : f.response(),
    );
    let now = performance.now();
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    cleanup.push(() => clock.mockRestore());
    const poll = followT3Backend(f.path, f, undefined, 60_000);
    expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
    const finishUpdate = mimicUpdate(f);
    now += 70_000;
    expect(await poll()).toBeUndefined(); // Identity pending.
    finishUpdate();
    down = true; // Then the session check fails for two polls, which ends the identity streak.
    now += 1000;
    expect(await poll()).toBeUndefined();
    now += 1000;
    expect(await poll()).toBeUndefined();
    now += 1000;
    expect(await poll()).toEqual({ url: f.url, moved: false, restarted: true });
  },
);

linuxTest("each wait for an identity starts its own window", async () => {
  const f = fixture();
  quietWarnings();
  fetchMock(f.response);
  const finishUpdate = mimicUpdate(f);
  let now = performance.now();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const poll = followT3Backend(f.path, f, undefined, 150);
  expect(await poll()).toBeUndefined();
  const reopened = finishUpdate();
  expect(await poll()).toEqual({ url: f.url, moved: true, restarted: true });
  // A later update, long after the first wait began, is not charged for it.
  reopened.close();
  now += 70_000; // Past the follower's one-minute reuse of a verified listener.
  expect(await poll()).toBeUndefined();
});
