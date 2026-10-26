// Swarmail's wake for Claude Code, as a mod (a Claude Code plugin's hooks module). It long-polls the server's /wait
// for mail to the agents registered under this session and hands Claude the one-line hint, with no hook process
// waiting beside the session. The hooks installer copies it into a plugin directory listed in
// env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json. It sets SWARMAIL_WAKE_MOD=1 for the session, and the
// settings wake hooks (`swarmail hook wake claude`) stand down when they see it. It does nothing when
// SWARMAIL_WAKE_URL names another machine, which asks for a token the mod cannot send; the hooks wait there.
//   idle: $.prompt.submit starts a turn with the hint.
//   mid-turn: the hint goes with the next main-loop tool result, as the PostToolUse hook's did; when the turn ends
//     first, it starts the next turn instead.
// Each wait passes `after`, the last hint delivered, so a hint the server offered but this mod never delivered (a
// dropped connection, a reload) is offered again.
// Claude Code checks the module statically: `$` is only ever a parameter named `$`, never stored.

// The parts of the mod API this module uses.
/**
 * @typedef {object} ModApi
 * @property {{ after(ms: number, fn: () => void): void }} clock
 * @property {{ get(name: string): Promise<string | undefined>, set(name: string, value: string): Promise<void> }} env
 * @property {{ read(path: string): Promise<string> }} fs
 * @property {{ fetch(url: string): Promise<{ status: number, text: string, headers: Record<string, string> }> }} http
 * @property {{ id(): Promise<string> }} session
 * @property {{ submit(prompt: { text: string }): Promise<void> }} prompt
 * @typedef {{ isInteractive?: boolean, agentId?: string }} ModEvent
 * @typedef {{ deny?: unknown, context?: string[] }} ToolResult
 * @typedef {($: ModApi, e: ModEvent, next: (e: ModEvent) => Promise<any>) => Promise<any>} Handler
 * @typedef {{ hint: string, eventId: number, sid: string, submitting?: boolean }} HeldHint
 */

// $.http.fetch gives up after 30 s.
const WAIT_SECONDS = 25;
// A session with nobody at the prompt (`claude -p` and SDK hosts alike) polls for a shorter time. A
// `claude -p` run that inherited an SDK host's CLAUDE_CODE_ENTRYPOINT cannot be told from the host's own
// session, and its process stays open until the wait in flight ends; the poll still returns the moment mail
// arrives, so only the renewal interval shortens.
const UNATTENDED_WAIT_SECONDS = 3;
// How often an unregistered session checks its registration, and the pause after an error or a replaced wait.
const IDLE_MS = 5000;
const ERROR_MS = 3000;
// How often a held hint checks whether the turn has ended.
const HELD_MS = 1000;

// One module runs per session, so its state is the session's. `busy`: a main-loop turn is running. `held`: the hint
// the server offered and this mod has not delivered yet, { hint, eventId, sid, submitting }; no wait runs while one is held.
let busy = false;
/** @type {HeldHint | null} */
let held = null;
let acked = 0;
// The session `acked` belongs to; /clear and /resume change it, and the new session starts over.
let waitedFor = "";
// Bumped by session.start, so a timer from an older chain does nothing.
let generation = 0;
let waitSeconds = WAIT_SECONDS;

/**
 * @param {ModApi} $
 * @param {number} ms
 */
function schedule($, ms) {
  const mine = generation;
  $.clock.after(ms, () => {
    if (mine === generation) {
      void round($);
    }
  });
}

/**
 * @param {ModApi} $
 * @param {string} sid
 */
async function registered($, sid) {
  // The register hook's directory (stateHome in paths.ts): HOME, or the user profile on Windows, where HOME is
  // usually unset.
  const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE"));
  const state = (await $.env.get("XDG_STATE_HOME")) || `${home}/.local/state`;
  try {
    return !JSON.parse(await $.fs.read(`${state}/swarmail-register/${sid}.json`)).ended;
  } catch {
    return false;
  }
}

function delivered() {
  // A session.start during the delivery already cleared the hint and the cursor.
  if (!held) {
    return;
  }
  acked = held.eventId;
  held = null;
}

/** Whether `url` names the local listener, as `isLoopbackUrl` in paths.ts decides (the mod loads no other module).
 * @param {string} url
 */
function isLoopback(url) {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {ModApi} $
 * @param {string} sid
 */
async function eligible($, sid) {
  const base = (await $.env.get("SWARMAIL_WAKE_URL")) || "http://127.0.0.1:18765";
  try {
    const res = await $.http.fetch(`${base}/wait/status?session=${encodeURIComponent(sid)}`);
    return res.status === 200 && JSON.parse(res.text).eligible === true;
  } catch {
    return false;
  }
}

/**
 * Offers the held hint as a new prompt. Returns whether it was delivered.
 * @param {ModApi} $
 */
async function submit($) {
  const pending = held;
  if (!pending) {
    return false;
  }
  const allowed = await eligible($, pending.sid);
  const sid = await $.session.id();
  const live = await registered($, pending.sid);
  if (!allowed || !live || sid !== pending.sid || held !== pending || pending.submitting) {
    return false;
  }
  pending.submitting = true;
  try {
    // Resolves once the turn starts, or once the prompt is queued behind a turn that started meanwhile.
    await $.prompt.submit({ text: pending.hint });
  } catch (error) {
    pending.submitting = false;
    throw error;
  }
  delivered();
  return true;
}

// One wait for mail to the session's agents, once it is registered: the pause before the next step.
/** @param {ModApi} $ */
async function wait($) {
  // The id changes after /clear, which raises no new session.start.
  const sid = await $.session.id();
  if (sid !== waitedFor) {
    waitedFor = sid;
    acked = 0;
  }
  if (!(await registered($, sid))) {
    return IDLE_MS;
  }
  const base = (await $.env.get("SWARMAIL_WAKE_URL")) || "http://127.0.0.1:18765";
  const res = await $.http.fetch(
    `${base}/wait?session=${encodeURIComponent(sid)}&timeout=${waitSeconds}&after=${acked}`,
  );
  if ((await $.session.id()) !== sid) {
    // /clear ran during the wait: the mail is for the old session.
    return 0;
  }
  if (res.status === 200) {
    const eventId = Number(res.headers["x-swarmail-event-id"]);
    if (!Number.isSafeInteger(eventId) || eventId < 0) {
      // Without a cursor the next wait can't acknowledge this hint.
      return ERROR_MS;
    }
    held = { hint: res.text.trim(), eventId, sid };
  }
  if (res.status === 200 || res.status === 204) {
    return 0;
  }
  if (res.status === 409 && res.text.startsWith("acknowledgement")) {
    // The server has no record of what it offered (a new database): start over.
    acked = 0;
  }
  // 409: another waiter for this session.
  return IDLE_MS;
}

// One step of the session's only chain of timers, so every API call goes through the `$` session.start gave it.
/** @param {ModApi} $ */
async function round($) {
  const mine = generation;
  let delay;
  try {
    if (held && (await $.session.id()) !== held.sid) {
      // /clear replaced the session the hint is for.
      held = null;
    }
    if (!held) {
      delay = await wait($);
    } else {
      const sent = !busy && (await submit($));
      delay = sent ? 0 : HELD_MS;
    }
  } catch {
    delay = ERROR_MS;
  }
  // A session.start during this round began another chain, or stood the mod down.
  if (mine === generation) {
    schedule($, delay);
  }
}

/** @param {(event: string, handler: Handler) => void} on */
export function register(on) {
  on("session.start", async ($, e, next) => {
    // `claude -p` answers one prompt and exits, so it gets no wake, as with the hook. The SDK (T3) is `sdk-ts`.
    if ((await $.env.get("CLAUDE_CODE_ENTRYPOINT")) === "sdk-cli") {
      return next(e);
    }
    // A mod cannot send headers, so a server that asks for a token is left to the wake hooks.
    const wakeUrl = (await $.env.get("SWARMAIL_WAKE_URL")) || "http://127.0.0.1:18765";
    if (!isLoopback(wakeUrl)) {
      generation++; // Ends a chain this session's earlier start began.
      held = null; // A hint it held must not start a turn after the hand-over.
      await $.env.set("SWARMAIL_WAKE_MOD", "0"); // An inherited "1" would stop the hooks too.
      return next(e);
    }
    busy = false;
    held = null;
    acked = 0;
    waitSeconds = e.isInteractive === false ? UNATTENDED_WAIT_SECONDS : WAIT_SECONDS;
    generation++;
    await $.env.set("SWARMAIL_WAKE_MOD", "1");
    schedule($, 0);
    return next(e);
  });

  // A subagent's run raises no turn.start, so this is the main loop's.
  on("turn.start", async ($, e, next) => {
    busy = true;
    return next(e);
  });

  // A hint still held when the turn ends starts the next one, on the chain's next step.
  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) {
      busy = false;
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    const sid = held ? await $.session.id() : undefined;
    if (
      !held ||
      held.sid !== sid ||
      held.submitting ||
      e.agentId ||
      !busy ||
      typeof result?.deny === "string"
    ) {
      return result;
    }
    const pending = held;
    const allowed = await eligible($, sid);
    const current = await $.session.id();
    const live = await registered($, sid);
    if (!allowed || !live || current !== sid || held !== pending || pending.submitting) {
      return result;
    }
    const { hint } = held;
    delivered();
    return { ...result, context: [...(result.context ?? []), hint] };
  });
}
