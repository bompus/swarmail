// Mock the external auth CLI; optional clock/scan barriers make supervisor orderings deterministic.
import { existsSync, readFileSync } from "node:fs";
if (process.env.AUTO_TEST_NOW_FILE) {
  Date.now = () => Number(readFileSync(process.env.AUTO_TEST_NOW_FILE, "utf8"));
}
const spawn = Bun.spawn.bind(Bun);
const sleep = Bun.sleep.bind(Bun);
if (process.env.AUTO_TEST_SCAN_URL) {
  // The supervisor's 2-second idle pause is the scan barrier. A delivery retry backoff of
  // 2 seconds would pass through it too. The pause clears this handle when aborted.
  const timeout = setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) =>
    ms === 2000
      ? timeout(() => fetch(process.env.AUTO_TEST_SCAN_URL).then(() => fn(...args)), 0)
      : timeout(fn, ms, ...args);
  Bun.sleep = (ms) => {
    if (
      ms === 5000 &&
      process.env.AUTO_TEST_STOP_GATE &&
      existsSync(process.env.AUTO_TEST_STOP_GATE)
    ) {
      return Promise.resolve(); // Expose a premature mailbox unlock without waiting five seconds.
    }
    return sleep(ms);
  };
}
const originalAbort = Object.getOwnPropertyDescriptor(AbortController.prototype, "abort").value;
const abort = (controller, ...args) => Reflect.apply(originalAbort, controller, args);
AbortController.prototype.abort = function (...args) {
  if (process.env.AUTO_TEST_STOP_GATE && existsSync(process.env.AUTO_TEST_STOP_GATE)) {
    void fetch(process.env.AUTO_TEST_STOP_URL);
  }
  return abort(this, ...args);
};
Bun.spawn = (command, options) => {
  if (Array.isArray(command) && command[0] === process.execPath) {
    if (command[1] === "--version") {
      return spawn(
        [process.execPath, "-e", 'console.log("0.0.45-nightly.20260930.2481")'],
        options,
      );
    }
    if (command[1] === "auth" && command[2] === "session" && command[3] === "issue") {
      return spawn(
        [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({sessionId:"fixture-owner",token:"fixture-token",expiresAt:process.env.AUTO_TEST_EXPIRES}))',
        ],
        options,
      );
    }
  }
  return spawn(command, options);
};
