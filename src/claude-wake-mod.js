// Swarmail's wake for Claude Code, as a mod (a Claude Code plugin's hooks module). It long-polls the server's /wait
// for mail to the agents registered under this session and hands Claude the one-line hint, with no hook process
// waiting beside the session. The hooks installer copies it into a plugin directory listed in
// env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json. It sets SWARMAIL_WAKE_MOD=1 for the session, and the
// settings wake hooks (`swarmail hook wake claude`) stand down when they see it.
//   idle: $.prompt.submit starts a turn with the hint.
//   mid-turn: the hint goes with the next main-loop tool result, as the PostToolUse hook's did; when the turn ends
//     first, it starts the next turn instead.
// Each wait passes `after`, the last hint delivered, so a hint the server offered but this mod never delivered (a
// dropped connection, a reload) is offered again.
// Claude Code checks the module statically: `$` is only ever a parameter named `$`, never stored.

// $.http.fetch gives up after 30 s.
const WAIT_SECONDS = 25;
// How often an unregistered session checks its registration, and the pause after an error or a replaced wait.
const IDLE_MS = 5000;
const ERROR_MS = 3000;
// How often a held hint checks whether the turn has ended.
const HELD_MS = 1000;

// One module runs per session, so its state is the session's. `busy`: a main-loop turn is running. `held`: the hint
// the server offered and this mod has not delivered yet, { hint, eventId, sid, submitting }; no wait runs while one is held.
let busy = false;
let held = null;
let acked = 0;
// The session `acked` belongs to; /clear and /resume change it, and the new session starts over.
let waitedFor = "";
// Bumped by session.start, so a timer from an older chain does nothing.
let generation = 0;

function schedule($, ms) {
  const mine = generation;
  $.clock.after(ms, () => {
    if (mine === generation) {
      void round($);
    }
  });
}

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
  acked = held.eventId;
  held = null;
}

async function submit($) {
  held.submitting = true;
  try {
    // Resolves once the turn starts, or once the prompt is queued behind a turn that started meanwhile.
    await $.prompt.submit({ text: held.hint });
  } catch (error) {
    held.submitting = false;
    throw error;
  }
  delivered();
}

// One wait for mail to the session's agents, once it is registered: the pause before the next step.
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
    `${base}/wait?session=${encodeURIComponent(sid)}&timeout=${WAIT_SECONDS}&after=${acked}`,
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
async function round($) {
  let delay;
  try {
    if (held && (await $.session.id()) !== held.sid) {
      // /clear replaced the session the hint is for.
      held = null;
    }
    if (!held) {
      delay = await wait($);
    } else {
      if (!busy) {
        await submit($);
      }
      delay = held ? HELD_MS : 0;
    }
  } catch {
    delay = ERROR_MS;
  }
  schedule($, delay);
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    // `claude -p` answers one prompt and exits, so it gets no wake, as with the hook. The SDK (T3) is `sdk-ts`.
    if ((await $.env.get("CLAUDE_CODE_ENTRYPOINT")) === "sdk-cli") {
      return next(e);
    }
    busy = false;
    held = null;
    acked = 0;
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
    const { hint } = held;
    delivered();
    return { ...result, context: [...(result.context ?? []), hint] };
  });
}
