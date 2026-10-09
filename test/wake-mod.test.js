import { expect, test } from "bun:test";
import { register } from "../src/claude-wake-mod.js";

/** Loads the mod against a fake `$`. `tick` runs the next timer and returns the delay of the one it schedules. */
function session({ registered = true, entrypoint = "cli", home = { HOME: "/h" } } = {}) {
  const on = {};
  register((event, hook) => (on[event] = hook));
  const timers = [];
  const state = {
    sid: "s-1",
    registered,
    eligible: true,
    statusCalls: 0,
    statusRead: async () => {},
    /** @type {({ status: number, text: string, headers?: object } | Error | (() => object))[]} */
    responses: [],
    fetched: [],
    submitted: [],
    env: {},
  };
  const $ = {
    clock: { after: (ms, fn) => timers.push({ ms, fn }) },
    env: {
      get: async (name) => ({ ...home, CLAUDE_CODE_ENTRYPOINT: entrypoint })[name],
      set: async (name, value) => (state.env[name] = value),
    },
    fs: {
      read: async (path) => {
        if (!state.registered || path !== `/h/.local/state/swarmail-register/${state.sid}.json`) {
          throw new Error("ENOENT");
        }
        return "{}";
      },
    },
    session: { id: async () => state.sid },
    http: {
      fetch: async (url) => {
        if (url.includes("/wait/status?")) {
          state.statusCalls++;
          await state.statusRead();
          return { status: 200, text: JSON.stringify({ eligible: state.eligible }), headers: {} };
        }
        state.fetched.push(url);
        const queued = state.responses.shift() ?? { status: 204, text: "" };
        const next = typeof queued === "function" ? queued() : queued;
        if (next instanceof Error) {
          throw next;
        }
        return { headers: {}, ...next };
      },
    },
    prompt: { submit: async ({ text }) => void state.submitted.push(text) },
  };
  const pass = async (e) => e;
  return {
    state,
    start: (e = {}) => on["session.start"]($, e, pass),
    turnStart: () => on["turn.start"]($, {}, pass),
    turnComplete: (e = {}) => on["turn.complete"]($, e, pass),
    toolCall: (e, result) => on["tool.call"]($, e, async () => result),
    timers,
    async tick() {
      timers.shift().fn();
      while (!timers.length) {
        await Bun.sleep(0);
      }
      return timers[0].ms;
    },
  };
}

const hint = (eventId, text = "Swarmail: 1 new message") => ({
  status: 200,
  text: `${text}\n`,
  headers: { "x-swarmail-event-id": String(eventId) },
});

test("waits once the session is registered, and starts a turn with the hint when idle", async () => {
  const s = session({ registered: false });
  await s.start();
  expect(s.state.env.SWARMAIL_WAKE_MOD).toBe("1");
  expect(await s.tick()).toBe(5000);
  expect(s.state.fetched).toEqual([]);

  s.state.registered = true;
  s.state.responses.push(hint(7));
  expect(await s.tick()).toBe(0);
  expect(s.state.fetched[0]).toContain("/wait?session=s-1&timeout=25&after=0");
  expect(await s.tick()).toBe(0);
  expect(s.state.submitted).toEqual(["Swarmail: 1 new message"]);
  // The next wait acknowledges the delivered hint.
  await s.tick();
  expect(s.state.fetched[1]).toEndWith("&after=7");
  // After /clear or /resume the session id changes, and the new session's cursor starts over.
  s.state.sid = "s-2";
  await s.tick();
  expect(s.state.fetched[2]).toContain("session=s-2&timeout=25&after=0");
});

test("finds the registration under the user profile when HOME is unset, as on Windows", async () => {
  const s = session({ home: { USERPROFILE: "/h" } });
  await s.start();
  s.state.responses.push(hint(7));
  expect(await s.tick()).toBe(0);
  expect(s.state.fetched[0]).toContain("/wait?session=s-1");
});

test("a hint that arrives mid-turn goes with the next main-loop tool result, not a new turn", async () => {
  const s = session();
  await s.start();
  await s.turnStart();
  s.state.responses.push(hint(3));
  await s.tick();
  expect(await s.tick()).toBe(1000); // held while the turn runs

  const denied = { deny: "no" };
  expect(await s.toolCall({ tool: "Bash" }, denied)).toBe(denied);
  const sub = { result: "sub", ref: 1 };
  expect(await s.toolCall({ tool: "Bash", agentId: "a-1" }, sub)).toBe(sub);
  expect(await s.toolCall({ tool: "Bash" }, { result: "ok", ref: 2, context: ["x"] })).toEqual({
    result: "ok",
    ref: 2,
    context: ["x", "Swarmail: 1 new message"],
  });
  // Delivered once: the next call passes through and the next wait acknowledges it.
  const plain = { result: "ok", ref: 3 };
  expect(await s.toolCall({ tool: "Bash" }, plain)).toBe(plain);
  await s.tick();
  expect(s.state.fetched.at(-1)).toEndWith("&after=3");
  expect(s.state.submitted).toEqual([]);
});

test("a hint still held when the main-loop turn ends starts the next turn", async () => {
  const s = session();
  await s.start();
  await s.turnStart();
  s.state.responses.push(hint(4));
  await s.tick();
  await s.turnComplete({ agentId: "a-1" }); // a subagent's turn
  expect(await s.tick()).toBe(1000);
  await s.turnComplete();
  await s.tick();
  expect(s.state.submitted).toEqual(["Swarmail: 1 new message"]);
});

test("pauses after an error or a replaced wait, and starts over when the server forgot its offer", async () => {
  const s = session();
  await s.start();
  s.state.responses.push(new Error("connection refused"));
  expect(await s.tick()).toBe(3000);
  s.state.responses.push({ status: 409, text: "replaced by a newer wait\n" });
  expect(await s.tick()).toBe(5000);

  s.state.responses.push(hint(9));
  await s.tick();
  await s.tick();
  s.state.responses.push({ status: 409, text: "acknowledgement exceeds offered mail" });
  await s.tick();
  expect(s.state.fetched.at(-1)).toEndWith("&after=9");
  await s.tick();
  expect(s.state.fetched.at(-1)).toEndWith("&after=0");
});

test("drops a hint without a usable event id, or one for a session /clear replaced mid-wait", async () => {
  const s = session();
  await s.start();
  s.state.responses.push({ status: 200, text: "Swarmail: 1 new message\n" });
  expect(await s.tick()).toBe(3000);
  s.state.responses.push(() => {
    s.state.sid = "s-2";
    return hint(5);
  });
  expect(await s.tick()).toBe(0);
  await s.tick();
  expect(s.state.submitted).toEqual([]);
  expect(s.state.fetched.at(-1)).toContain("session=s-2&timeout=25&after=0");
});

test("drops a held hint once /clear replaces its session", async () => {
  const s = session();
  await s.start();
  await s.turnStart();
  s.state.responses.push(hint(6));
  await s.tick();
  s.state.sid = "s-2";
  const plain = { result: "ok", ref: 1 };
  expect(await s.toolCall({ tool: "Bash" }, plain)).toBe(plain);
  await s.turnComplete();
  await s.tick();
  expect(s.state.submitted).toEqual([]);
  expect(s.state.fetched.at(-1)).toContain("session=s-2&timeout=25&after=0");
});

test("a session with nobody at the prompt polls for 3 s so a one-shot child exits promptly", async () => {
  const s = session();
  await s.start({ isInteractive: false });
  await s.tick();
  expect(s.state.fetched.at(-1)).toContain("session=s-1&timeout=3&after=0");

  const person = session();
  await person.start({ isInteractive: true });
  await person.tick();
  expect(person.state.fetched.at(-1)).toContain("timeout=25&after=0");
});

test("does nothing in `claude -p`, which exits after one prompt", async () => {
  const s = session({ entrypoint: "sdk-cli" });
  await s.start();
  expect(s.timers).toEqual([]);
  expect(s.state.env).toEqual({});
});

test("held hints survive inactive lifecycle and deliver after reopen without early acknowledgment", async () => {
  const s = session();
  await s.start();
  await s.turnStart();
  s.state.responses.push(hint(42));
  await s.tick();
  s.state.eligible = false;
  expect(await s.toolCall({}, { context: ["original"] })).toEqual({ context: ["original"] });
  await s.turnComplete();
  expect(await s.tick()).toBe(1000);
  expect(s.state.submitted).toEqual([]);
  s.state.eligible = true;
  expect(await s.tick()).toBe(0);
  expect(s.state.submitted).toEqual(["Swarmail: 1 new message"]);
  await s.tick();
  expect(s.state.fetched.at(-1)).toEndWith("after=42");
});

test("a session change during final lifecycle lookup cannot inject the old held hint", async () => {
  const s = session();
  await s.start();
  await s.turnStart();
  s.state.responses.push(hint(42));
  await s.tick();
  s.state.statusRead = async () => {
    s.state.sid = "new-session";
  };
  expect(await s.toolCall({}, { context: ["original"] })).toEqual({ context: ["original"] });
  expect(s.state.submitted).toEqual([]);
});
