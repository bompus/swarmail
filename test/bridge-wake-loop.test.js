import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { deliveryLoop, pause } from "../src/wake-loop.ts";
import { openWakeState, wakeStatePath } from "../src/wake-state.ts";
import { BridgeError } from "../src/wake-target.ts";
import { testScratch } from "./fixtures/test-scratch.js";

const scratch = testScratch();
const URL = "http://127.0.0.1:1";
const states = [];
const savedHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  for (const { state, dir } of states.splice(0)) {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.XDG_STATE_HOME = savedHome;
});

function journal() {
  const dir = mkdtempSync(join(scratch, "case-"));
  process.env.XDG_STATE_HOME = dir;
  const state = openWakeState(URL, "session-1", "{}");
  states.push({ state, dir });
  const saved = () => {
    const db = new Database(wakeStatePath(URL, "session-1"), { readonly: true });
    try {
      return db.query("SELECT acknowledged, pending FROM state").get();
    } finally {
      db.close();
    }
  };
  return { state, saved };
}

/** Mail source that yields `steps` in order, then stops the loop. */
function adapter(steps, stop, overrides = {}) {
  const delivered = [];
  return {
    delivered,
    wait: async () => {
      const step = steps.shift();
      if (!step) {
        stop.abort();
        return null;
      }
      if (step instanceof Error) {
        throw step;
      }
      return step;
    },
    prepare: (offer) => ({ text: offer.hint, phase: "prepared" }),
    deliver: async (pending) => {
      delivered.push(pending.eventId);
    },
    accepted: () => {},
    ...overrides,
  };
}

const offer = (eventId) => ({ eventId, hint: `Swarmail: ${eventId}` });

test("a retryable mail-source error backs off, then delivery continues", async () => {
  const { state } = journal();
  const stop = new AbortController();
  const a = adapter([new BridgeError("Swarmail connection unavailable", true), offer(3)], stop);
  const started = Date.now();
  await deliveryLoop(state, a, { signal: stop.signal, label: "test" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(a.delivered).toEqual([3]);
  expect(state.acknowledged).toBe(3);
});

for (const cancelled of [false, true]) {
  test(`a permanent delivery error rejects and keeps the pending command (cancelled=${cancelled})`, async () => {
    const { state, saved } = journal();
    const stop = new AbortController();
    const a = adapter([offer(4)], stop, {
      deliver: async () => {
        if (cancelled) {
          stop.abort();
        }
        throw new BridgeError("destination refused");
      },
    });
    await expect(deliveryLoop(state, a, { signal: stop.signal, label: "test" })).rejects.toThrow(
      "destination refused",
    );
    expect(state.pending.eventId).toBe(4);
    expect(JSON.parse(saved().pending).eventId).toBe(4);
    expect(saved().acknowledged).toBe(0);
  });
}

test("the command is saved before delivery, and marking it attempted saves the same object", async () => {
  const { state, saved } = journal();
  const stop = new AbortController();
  const seen = [];
  const a = adapter([offer(5)], stop, {
    deliver: async (pending, attempted) => {
      seen.push(JSON.parse(saved().pending).command.phase);
      attempted();
      seen.push(JSON.parse(saved().pending).command.phase, pending.command.phase);
    },
  });
  await deliveryLoop(state, a, { signal: stop.signal, label: "test" });
  expect(seen).toEqual(["prepared", "attempted", "attempted"]);
});

test("accepting updates memory and disk together, and a failed after-step does not stop the loop", async () => {
  const { state, saved } = journal();
  const stop = new AbortController();
  const a = adapter([offer(6), offer(7)], stop, {
    accepted: async (eventId) => {
      if (eventId === 6) {
        throw new BridgeError("Swarmail connection unavailable", true);
      }
    },
  });
  await deliveryLoop(state, a, { signal: stop.signal, label: "test" });
  expect(a.delivered).toEqual([6, 7]);
  expect([state.acknowledged, state.pending]).toEqual([7, null]);
  expect(saved()).toEqual({ acknowledged: 7, pending: null });
});

test("a journaled command is delivered first after a restart", async () => {
  const { state } = journal();
  state.savePending({ eventId: 8, command: { text: "Swarmail: 8", phase: "attempted" } });
  const stop = new AbortController();
  const a = adapter([], stop);
  await deliveryLoop(state, a, { signal: stop.signal, label: "test" });
  expect(a.delivered).toEqual([8]);
  expect(state.acknowledged).toBe(8);
});

test("shutdown during delivery retains the durable offer for restart", async () => {
  const { state, saved } = journal();
  const stop = new AbortController();
  const a = adapter([offer(9)], stop, {
    deliver: async () => stop.abort(),
  });
  await deliveryLoop(state, a, { signal: stop.signal, label: "test" });
  expect(saved().acknowledged).toBe(0);
  expect(JSON.parse(saved().pending).eventId).toBe(9);
});

test("a pause ends when its signal aborts", async () => {
  const stop = new AbortController();
  const started = performance.now();
  const waiting = pause(60_000, stop.signal);
  setTimeout(() => stop.abort(), 10);
  await waiting;
  expect(performance.now() - started).toBeLessThan(1000);
  await pause(60_000, stop.signal); // Already aborted: returns without waiting.
  expect(performance.now() - started).toBeLessThan(1000);
});
