#!/usr/bin/env bun
// Installs the Swarmail hooks (`swarmail register`, `swarmail hook wake`) for every host: Claude settings, which Cursor, Devin and Grok also load; Cursor's own hooks.json for its
// wake hook; Codex (~/.codex/hooks.json), OpenCode (a plugin) and Antigravity
// (~/.gemini/config/hooks.json). Linux home only.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  planJson,
  readConfig,
  withHook as withOwnedHook,
  writeChanged,
} from "./lib/config-files.ts";

const marker = "swarmail-register-hook";
// Replaces hooks that invoke the Swarmail binary.
const ours = /\.local\/bin\/swarmail\b/;

/** The `swarmail` binary (scripts/enable.sh builds it) and the hook commands that run it. */
export function swarmailHookPaths(home: string) {
  const bin = join(home, ".local", "bin", "swarmail");
  return {
    bin,
    command: `"${bin}" register`,
    // The compiled binary rather than a shell script: about 9.4 MB per waiting session against 3.2 MB
    // (measured 2026-09-28), for one code path on every host.
    wake: (host: string) => `"${bin}" hook wake ${host}`,
    // PostToolUse runs after every tool call, so the shell skips the binary unless this is a registered session
    // with no live waiter: one that already delivered its hint this turn, or a first turn before any Stop.
    rearm:
      's="${XDG_STATE_HOME:-$HOME/.local/state}"; i="$CLAUDE_CODE_SESSION_ID"; ' +
      '[ -n "$i" ] && [ -f "$s/swarmail-register/$i.json" ] || exit 0; ' +
      '{ read -r p < "$s/swarmail-wake/$i"; } 2>/dev/null && kill -0 "$p" 2>/dev/null && exit 0; ' +
      `exec "${bin}" hook wake claude`,
  };
}

/** The Codex hooks/list entry for the register hook, whose trust Codex checks before running it. */
export const isRegisterCommand = (command: string | undefined) =>
  !!command?.includes('swarmail" register');

/** Replaces this installer's entry in a `hooks.<event>` list, keeping every other hook. */
export const withHook = (config: Record<string, unknown>, event: string, entry: object) =>
  withOwnedHook(config, event, entry, ours);

/**
 * Claude settings: the register hook on file-edit tools (the lowercase names are Devin's, which loads
 * this file too), on UserPromptSubmit, which retries a registration that failed, and on SessionEnd,
 * which records the end and releases the session's reservations; and the wake hook
 * as an async Stop hook that waits for mail after each turn, whose exit 2 starts a new turn. The same
 * wait on PostToolUse (`rearmCommand`) covers mail that arrives mid-turn after the previous wait has
 * delivered, or before the session's first Stop; its hint joins the running turn.
 */
export function withClaudeHooks(
  settings: Record<string, unknown>,
  command: string,
  wakeCommand: string,
  rearmCommand: string,
) {
  const entry = (matcher?: string) => ({
    ...(matcher && { matcher }),
    hooks: [{ type: "command", command, timeout: 15 }],
  });
  let next = withHook(
    settings,
    "PreToolUse",
    entry("Edit|Write|MultiEdit|NotebookEdit|edit|write|apply_patch|notebook_edit"),
  );
  next = withHook(next, "UserPromptSubmit", entry());
  next = withHook(next, "SessionEnd", entry());
  // The script waits up to 8 h (28800 s); the timeout only has to outlast it.
  next = withHook(next, "PostToolUse", {
    hooks: [{ type: "command", command: rearmCommand, asyncRewake: true, timeout: 28900 }],
  });
  return withHook(next, "Stop", {
    hooks: [{ type: "command", command: wakeCommand, asyncRewake: true, timeout: 28900 }],
  });
}

/**
 * The OpenCode plugin: forwards edit-tool calls to `swarmail register` without waiting on it.
 * One default export serves both majors: OpenCode 2 calls `setup(ctx)`, OpenCode 1 (1.18.29+)
 * calls `server(input)`. T3 Code still drives OpenCode 1, which shares this plugin directory,
 * and OpenCode 2 still discovers the singular `plugin/` directory.
 */
export function openCodePlugin(bin: string): string {
  return `// Installed by swarmail scripts/configure-hooks.ts; edits here are overwritten.
// Registers this OpenCode session in Swarmail on its first edit in each repository.
const command = ${JSON.stringify([bin, "register"])};
// OpenCode 2 names its patch tool \`patch\`; OpenCode 1 called it \`apply_patch\`. Both send \`patchText\`.
const edits = new Set(["edit", "write", "patch", "apply_patch"]);

function register(tool, sessionID, cwd, input) {
  if (!edits.has(tool)) return;
  const args = input ?? {};
  const payload = { swarmail_host: "opencode", session_id: sessionID, cwd,
    tool_input: { filePath: args.path ?? args.filePath, command: args.patchText } };
  try {
    Bun.spawn(command, { stdin: new Blob([JSON.stringify(payload)]), stdout: "ignore", stderr: "ignore" });
  } catch {
    // Registration must never stop an edit.
  }
}

export default {
  id: "swarmail.register",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) =>
      register(event.tool, event.sessionID, ctx.location.directory, event.input));
  },
  async server({ directory }) {
    return {
      "tool.execute.before": async (input, output) =>
        register(input.tool, input.sessionID, directory, output.args),
    };
  },
};
`;
}

export function configureSwarmailHooks(home: string = homedir(), { dryRun = false } = {}) {
  home = resolve(home);
  const { bin, command, wake, rearm } = swarmailHookPaths(home);
  const hookEntry = { type: "command", command, timeout: 15 };
  const plans: { path: string; original: string; next: string }[] = [
    planJson(join(home, ".claude", "settings.json"), home, (config) =>
      withClaudeHooks(config, command, wake("claude"), rearm),
    ),
    // Cursor runs the Claude Stop hook too, where the script exits at once (no CLAUDE_PID ancestor).
    // Its own stop hook holds the idle turn open, and a followup_message starts the next one. Cursor
    // stops auto-continuing after 5 follow-ups with no user prompt (loop_limit), which also ends a
    // loop of agents waking each other.
    planJson(join(home, ".cursor", "hooks.json"), home, (config) =>
      withHook({ version: 1, ...config }, "stop", { command: wake("cursor"), timeout: 28900 }),
    ),
    // Codex matches `apply_patch` as Edit|Write and adds `turn_id`, which the hook uses to tell it from Claude.
    planJson(join(home, ".codex", "hooks.json"), home, (config) =>
      withHook(config, "PreToolUse", { matcher: "Edit|Write", hooks: [hookEntry] }),
    ),
    {
      path: join(home, ".config", "opencode", "plugin", "swarmail-register.ts"),
      original: readConfig(
        join(home, ".config", "opencode", "plugin", "swarmail-register.ts"),
        home,
      ),
      next: openCodePlugin(bin),
    },
    // Antigravity keys hooks by group name. Its docs derive matcher names from step types while the
    // model calls write_to_file / replace_file_content, so match both.
    // A user's `"enabled": false` on the group survives reinstalls.
    planJson(join(home, ".gemini", "config", "hooks.json"), home, (config) => ({
      ...config,
      [marker]: {
        ...((config[marker] as { enabled?: unknown } | undefined)?.enabled === false && {
          enabled: false,
        }),
        PreToolUse: [
          {
            matcher:
              "code_action|file_change|write_to_file|replace_file_content|multi_replace_file_content",
            hooks: [hookEntry],
          },
        ],
      },
    })),
  ];
  const changed = plans.filter((plan) => plan.original !== plan.next).map((plan) => plan.path);
  if (!dryRun) {
    for (const plan of plans) {
      writeChanged(plan.path, plan.original, plan.next, "setup-backup");
    }
  }
  return { changed, dryRun };
}

if (import.meta.main) {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    throw new Error("Run as your normal Linux user.");
  }
  console.log(
    JSON.stringify(
      configureSwarmailHooks(homedir(), { dryRun: process.argv.includes("--dry-run") }),
    ),
  );
}
