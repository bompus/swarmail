#!/usr/bin/env bun
// Installs the Swarmail hooks (`swarmail register`, `swarmail hook wake`) for every host: Claude settings, which Cursor, Devin and Grok also load; Cursor's own hooks.json for its
// session-start registration and wake hook; Codex (~/.codex/hooks.json), OpenCode (a plugin) and Antigravity
// (~/.gemini/config/hooks.json). Claude Code also gets the Swarmail mod, its wake without a waiting hook process,
// unless --no-claude-mod. On Windows every hook command is one unquoted path, which Git Bash, PowerShell and cmd
// all run alike. A host whose directory doesn't exist is skipped, so a host that isn't installed gets no config
// directory.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
import { binaryPath, homeDir } from "../src/paths.ts";
import { shortPath } from "../src/proc-win32.ts";
import {
  object,
  planJson,
  present,
  readConfig,
  withHook as withOwnedHook,
  writeChanged,
} from "./lib/config-files.ts";
import { WAKE_SECONDS } from "../src/wake-hook.ts";

const marker = "swarmail-register-hook";
// Replaces hooks that invoke the Swarmail binary, by either slash (JSON doubles a backslash).
const ours = /\.local[\\/]+bin[\\/]+swarmail\b/i;
// What a hook shell takes as one word with no quoting.
const SHELL_WORD = /^[\w.:/~-]+$/;

/**
 * The binary as it appears in a hook command. Windows hosts run the command through Git Bash, PowerShell or cmd,
 * and a quoted path is a parse error in PowerShell and cmd, so the path goes unquoted with forward slashes. A
 * profile path with a space, another shell character or a non-ASCII letter is replaced by its 8.3 short name.
 */
export function hookBinary(
  home: string,
  platform: NodeJS.Platform = process.platform,
  short: (path: string) => string = shortPath,
): string {
  if (platform !== "win32") {
    return `"${binaryPath(home, platform)}"`;
  }
  const word = (dir: string) =>
    win32.join(dir, ".local", "bin", "swarmail.exe").replaceAll("\\", "/");
  let bin = word(home);
  if (!SHELL_WORD.test(bin)) {
    bin = word(short(home));
  }
  if (!SHELL_WORD.test(bin)) {
    throw new Error(
      `${bin}: hooks can't run a path with spaces, shell characters or non-ASCII letters, and this volume has no short name for it`,
    );
  }
  return bin;
}

/** The `swarmail` binary (scripts/build.ts builds it) and the hook commands that run it. */
export function swarmailHookPaths(home: string, platform: NodeJS.Platform = process.platform) {
  const bin = binaryPath(home, platform);
  const run = hookBinary(home, platform);
  // Claude runs a Windows hook through Git Bash or PowerShell, and PowerShell reports any exit code but 0 as 1, which
  // would lose the wake's exit 2. Git Bash reads the unset variable as a bare `exit`, which keeps the status. cmd
  // passes the suffix to the binary as arguments, and the CLI ignores everything from `claude;` or `rearm;` on.
  const keepExit = platform === "win32" ? "; exit $LASTEXITCODE" : "";
  return {
    bin,
    command: `${run} register`,
    // The compiled binary rather than a shell script: about 9.4 MB per waiting session against 3.2 MB
    // (measured 2026-09-28), for one code path on every host.
    wake: (host: string) => `${run} hook wake ${host}${host === "claude" ? keepExit : ""}`,
    // PostToolUse runs after every tool call, so the shell skips the binary unless this is a registered session
    // with no live waiter (one that already delivered its hint this turn, or a first turn before any Stop) and no
    // Swarmail mod doing the waiting.
    // Windows has no shell to count on, so the binary makes the same checks itself.
    rearm:
      platform === "win32"
        ? `${run} hook rearm${keepExit}`
        : '[ "$SWARMAIL_WAKE_MOD" = 1 ] && exit 0; ' +
          's="${XDG_STATE_HOME:-$HOME/.local/state}"; i="$CLAUDE_CODE_SESSION_ID"; ' +
          '[ -n "$i" ] && [ -f "$s/swarmail-register/$i.json" ] || exit 0; ' +
          '{ read -r p < "$s/swarmail-wake/$i"; } 2>/dev/null && kill -0 "$p" 2>/dev/null && exit 0; ' +
          `exec ${run} hook wake claude`,
  };
}

/** The plugin directory that holds the Swarmail mod, and its files. */
export function claudeModPlugin(home: string) {
  const dir = join(home, ".local", "share", "swarmail", "claude-plugin");
  const source = readFileSync(new URL("../src/claude-wake-mod.js", import.meta.url), "utf8");
  const json = (value: object) => JSON.stringify(value, null, 2) + "\n";
  return {
    dir,
    files: {
      [join(dir, ".claude-plugin", "plugin.json")]: json({
        name: "swarmail-wake",
        description: "Wakes this Claude Code session when Swarmail mail arrives",
      }),
      [join(dir, "hooks", "hooks.json")]: json({ modules: ["./register.js"] }),
      [join(dir, "hooks", "register.js")]:
        "// Installed by the Swarmail hooks installer from claude-wake-mod.js; edits here are overwritten.\n" +
        source,
    },
  };
}

/**
 * Claude settings' env.CLAUDE_CODE_PLUGIN_DIRS, split on the platform's path delimiter as Claude Code splits it
 * (";" on Windows), with `dir` added (or removed when `add` is false) and the user's own directories kept. Claude
 * Code loads each listed directory as `--plugin-dir` would.
 */
export function withPluginDir(
  settings: Record<string, unknown>,
  dir: string,
  add: boolean,
  separator = delimiter,
) {
  const env = settings.env === undefined ? {} : object(settings.env, "env");
  const { CLAUDE_CODE_PLUGIN_DIRS: listed, ...rest } = env;
  const dirs = String(listed ?? "")
    .split(separator)
    .filter((entry) => entry && entry !== dir);
  if (add) {
    dirs.push(dir);
  }
  if (!dirs.length && settings.env === undefined) {
    return settings;
  }
  return {
    ...settings,
    env: dirs.length ? { ...rest, CLAUDE_CODE_PLUGIN_DIRS: dirs.join(separator) } : rest,
  };
}

/** The Codex hooks/list entry for the register hook, whose trust Codex checks before running it. */
export const isRegisterCommand = (command: string | undefined) =>
  /swarmail(\.exe)?"? register\b/i.test(command ?? "");

/** Replaces this installer's entry in a `hooks.<event>` list, keeping every other hook. */
export const withHook = (config: Record<string, unknown>, event: string, entry: object) =>
  withOwnedHook(config, event, entry, ours);

/**
 * Claude settings: the register hook on file-edit tools (the lowercase names are Devin's, which loads
 * this file too), on SessionStart, which registers the session and tells it its name, on
 * UserPromptSubmit, which retries a registration that failed, and on SessionEnd, which records the end
 * and releases the session's reservations; and the wake hook
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
  next = withHook(next, "SessionStart", entry());
  next = withHook(next, "UserPromptSubmit", entry());
  next = withHook(next, "SessionEnd", entry());
  // Claude cancels an asyncRewake hook at this timeout, so it only has to outlast the script's own wait.
  const timeout = WAKE_SECONDS.claude + 100;
  next = withHook(next, "PostToolUse", {
    hooks: [{ type: "command", command: rearmCommand, asyncRewake: true, timeout }],
  });
  return withHook(next, "Stop", {
    hooks: [{ type: "command", command: wakeCommand, asyncRewake: true, timeout }],
  });
}

/**
 * The OpenCode plugin: forwards edit-tool calls to `swarmail register` without waiting on it.
 * One default export serves both majors: OpenCode 2 calls `setup(ctx)`, OpenCode 1 (1.18.29+)
 * calls `server(input)`. T3 Code V1 drives OpenCode 1, which shares this plugin directory,
 * and OpenCode 2 still discovers the singular `plugin/` directory.
 */
export function openCodePlugin(bin: string): string {
  return `// Installed by the Swarmail hooks installer (scripts/configure-hooks.ts); edits here are overwritten.
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

/**
 * Writes the hooks into the host configs under `home`. `swarmailHome` is where scripts/build.ts put the binary and
 * where the mod goes: HOME first, which on Windows can differ from the profile the hosts read their configs from.
 */
export function configureSwarmailHooks(
  home: string = homedir(),
  { dryRun = false, claudeMod = true, swarmailHome = home } = {},
) {
  home = resolve(home);
  swarmailHome = resolve(swarmailHome);
  const { bin, command, wake, rearm } = swarmailHookPaths(swarmailHome);
  const windows = process.platform === "win32";
  const mod = claudeModPlugin(swarmailHome);
  // Only Claude Code loads the mod; Cursor, Devin and Grok keep the wake hooks.
  const withMod = claudeMod && !!present(join(home, ".claude"));
  const hookEntry = { type: "command", command, timeout: 15 };
  // Each plan lists the home directories that mean its host is installed.
  const plans: { path: string; original: string; next: string; hosts: string[] }[] = [
    {
      ...planJson(join(home, ".claude", "settings.json"), home, (config) =>
        withPluginDir(withClaudeHooks(config, command, wake("claude"), rearm), mod.dir, withMod),
      ),
      // Devin keeps its own config under AppData on Windows (scripts/lib/mcp-hosts.ts).
      hosts: [".claude", ".cursor", ".grok", windows ? "AppData/Roaming/devin" : ".config/devin"],
    },
    ...(withMod ? Object.entries(mod.files) : []).map(([path, next]) => ({
      path,
      original: readConfig(path, swarmailHome),
      next,
      hosts: [".claude"],
    })),
    // Cursor runs the Claude Stop hook too, where the script exits at once (no CLAUDE_PID ancestor).
    // Its own stop hook holds the idle turn open, and a followup_message starts the next one. Cursor
    // stops auto-continuing after 5 follow-ups with no user prompt (loop_limit), which also ends a
    // loop of agents waking each other. The Cursor CLI ran no Claude SessionStart hook in testing, so
    // registration at session start has its own entry here.
    {
      ...planJson(join(home, ".cursor", "hooks.json"), home, (config) =>
        withHook(
          withHook({ version: 1, ...config }, "sessionStart", { command, timeout: 15 }),
          "stop",
          { command: wake("cursor"), timeout: WAKE_SECONDS.cursor + 100 },
        ),
      ),
      hosts: [".cursor"],
    },
    // Codex matches `apply_patch` as Edit|Write and adds `turn_id`, which the hook uses to tell it from Claude.
    {
      ...planJson(join(home, ".codex", "hooks.json"), home, (config) =>
        withHook(config, "PreToolUse", { matcher: "Edit|Write", hooks: [hookEntry] }),
      ),
      hosts: [".codex"],
    },
    {
      path: join(home, ".config", "opencode", "plugin", "swarmail-register.ts"),
      original: readConfig(
        join(home, ".config", "opencode", "plugin", "swarmail-register.ts"),
        home,
      ),
      next: openCodePlugin(bin),
      hosts: [".config/opencode"],
    },
    // Antigravity keys hooks by group name. Its docs derive matcher names from step types while the
    // model calls write_to_file / replace_file_content, so match both.
    // A user's `"enabled": false` on the group survives reinstalls.
    {
      ...planJson(join(home, ".gemini", "config", "hooks.json"), home, (config) => ({
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
      hosts: [".gemini"],
    },
  ];
  const installed = plans.filter(({ hosts }) => hosts.some((dir) => present(join(home, dir))));
  const changed = installed.filter((plan) => plan.original !== plan.next).map((plan) => plan.path);
  if (!dryRun) {
    for (const plan of installed) {
      writeChanged(plan.path, plan.original, plan.next, "setup-backup");
    }
  }
  return { changed, dryRun };
}

if (import.meta.main) {
  if (!["linux", "win32"].includes(process.platform) || process.getuid?.() === 0) {
    throw new Error("Run as your normal user, on Linux or Windows.");
  }
  // Any other argument stops before a write: --help prints usage, anything else is an error.
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run" && arg !== "--no-claude-mod")) {
    const help = args.some((arg) => arg === "--help" || arg === "-h");
    (help ? console.log : console.error)(
      "Usage: bun scripts/configure-hooks.ts [--dry-run] [--no-claude-mod]",
    );
    process.exit(help ? 0 : 64);
  }
  console.log(
    JSON.stringify(
      configureSwarmailHooks(homedir(), {
        swarmailHome: homeDir(),
        dryRun: args.includes("--dry-run"),
        claudeMod: !args.includes("--no-claude-mod"),
      }),
    ),
  );
}
