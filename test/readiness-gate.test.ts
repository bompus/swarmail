import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadinessGate } from "../src/readiness-gate.ts";
import { BridgeError, checkT3Target, type WakeTarget } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.ts";

const scratch = testScratch();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const failure = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

test("the gate starts closed, releases every waiter in call order when it opens, and passes at once while open", async () => {
  const gate = new ReadinessGate();
  expect(gate.isOpen).toBe(false);
  const order: number[] = [];
  const first = gate.ready().then(() => order.push(1));
  const second = gate.ready().then(() => order.push(2));
  await Bun.sleep(10);
  expect(order).toEqual([]);
  expect(gate.open()).toBeUndefined(); // Never closed by an outage: nothing was held.
  await Promise.all([first, second]);
  expect(order).toEqual([1, 2]);
  expect(gate.isOpen).toBe(true);
  await gate.ready(); // Open: resolves without a signal or a wait.
  expect(gate.open()).toBeUndefined(); // Already open.
});

test("closing an open gate holds the next request, and opening reports how long it held", async () => {
  const gate = new ReadinessGate();
  gate.open();
  expect(gate.close(1000)).toBe(true);
  expect(gate.close(1500)).toBe(false); // Already closed: the hold keeps its first start.
  let released = false;
  const waiting = gate.ready().then(() => {
    released = true;
  });
  await Bun.sleep(10);
  expect(released).toBe(false);
  expect(gate.open(3500)).toBe(2500);
  await waiting;
  expect(released).toBe(true);
  expect(gate.close(4000)).toBe(true); // A second outage starts a new hold.
  expect(gate.open(4100)).toBe(100);
});

test("an abort while the gate is closed rejects the wait as retryable and leaves later waiters alone", async () => {
  const gate = new ReadinessGate();
  const stop = new AbortController();
  const stopped = failure(gate.ready(stop.signal));
  let other = false;
  const waiting = gate.ready().then(() => {
    other = true;
  });
  stop.abort();
  const error = await stopped;
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).retryable).toBe(true);
  gate.open();
  await waiting;
  expect(other).toBe(true);
  // An already-aborted signal rejects at once while closed, and not once the gate is open.
  const closed = new ReadinessGate();
  expect(await failure(closed.ready(AbortSignal.abort()))).toBeInstanceOf(BridgeError);
  closed.open();
  await closed.ready(AbortSignal.abort());
});

test("a held request sends nothing, not even the authorization header, to the listener on the old address", async () => {
  const dir = mkdtempSync(join(scratch, "gate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const authorizationFile = join(dir, "authorization");
  writeFileSync(authorizationFile, "Bearer must-not-leave", { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const seen: { path: string; authorization: string | null }[] = [];
  // Whatever has bound the port T3 used to own.
  const squatter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      });
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => squatter.stop(true));
  const gate = new ReadinessGate();
  const stop = new AbortController();
  const target: WakeTarget = {
    type: "t3-v2-queue",
    id: "thread-1",
    url: `http://127.0.0.1:${squatter.port}`,
    authorizationFile,
    ready: () => gate.ready(stop.signal),
  };
  const check = failure(checkT3Target(target));
  await Bun.sleep(150);
  expect(seen).toEqual([]);
  stop.abort();
  const error = await check;
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).retryable).toBe(true);
  expect(seen).toEqual([]);
  // Once the gate is open the request is made (with the header), which is what the gate withholds until then.
  const open = new ReadinessGate();
  open.open();
  await failure(checkT3Target({ ...target, ready: () => open.ready() }));
  expect(seen[0]).toEqual({ path: "/api/auth/session", authorization: "Bearer must-not-leave" });
});

test("a request is sent only when the gate is checked open with nothing awaited before the send", async () => {
  const dir = mkdtempSync(join(scratch, "gate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const authorizationFile = join(dir, "authorization");
  writeFileSync(authorizationFile, "Bearer must-not-leave", { mode: 0o600 });
  chmodSync(authorizationFile, 0o600);
  const events: string[] = [];
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      events.push("request");
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => listener.stop(true));
  // `ready()` resolves, but the gate closes before the continuation runs, as when a backend move is detected.
  let checks = 0;
  const target: WakeTarget = {
    type: "t3-v2-queue",
    id: "thread-1",
    url: `http://127.0.0.1:${listener.port}`,
    authorizationFile,
    ready: async () => {
      events.push("ready");
    },
    isReady: () => {
      const open = ++checks > 2;
      events.push(open ? "open" : "closed");
      return open;
    },
  };
  await failure(checkT3Target(target));
  expect(events.slice(0, 7)).toEqual([
    "ready",
    "closed",
    "ready",
    "closed",
    "ready",
    "open",
    "request",
  ]);
});
