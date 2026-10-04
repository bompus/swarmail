import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  claudeModPlugin,
  configureSwarmailHooks,
  hookBinary,
  openCodePlugin,
  swarmailHookPaths,
  withHook,
  withPluginDir,
} from "../scripts/configure-hooks.ts";

const windows = process.platform === "win32";

const homes = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-hooks-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adds the Codex hook once beside existing hooks, and a dry run writes nothing", () => {
  const dir = home();
  const path = join(dir, ".codex", "hooks.json");
  mkdirSync(join(dir, ".codex"));
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "audit" }] };
  const existing = {
    matcher: "Edit|Write",
    hooks: [{ type: "command", command: `"${dir}/.local/bin/swarmail" register`, timeout: 10 }],
  };
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [other, existing] } }));

  expect(configureSwarmailHooks(dir, { dryRun: true }).changed).toContain(path);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toEqual([other, existing]);

  configureSwarmailHooks(dir);
  configureSwarmailHooks(dir);
  const pre = JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse;
  expect(pre[0]).toEqual(other);
  expect(pre).toEqual([
    other,
    {
      matcher: "Edit|Write",
      hooks: [{ type: "command", command: `${hookBinary(dir)} register`, timeout: 15 }],
    },
  ]);
  expect(configureSwarmailHooks(dir).changed).toEqual([]);
});

test("skips hosts that aren't installed; Cursor alone still gets the Claude settings it reads", () => {
  const empty = home();
  expect(configureSwarmailHooks(empty).changed).toEqual([]);
  expect(readdirSync(empty)).toEqual([]);

  const dir = home();
  mkdirSync(join(dir, ".cursor"));
  expect(configureSwarmailHooks(dir).changed).toEqual([
    join(dir, ".claude", "settings.json"),
    join(dir, ".cursor", "hooks.json"),
  ]);
  expect(readdirSync(dir).sort()).toEqual([".claude", ".cursor"]);
});

test("the CLI prints usage for --help and refuses unknown flags before writing", () => {
  const dir = home();
  mkdirSync(join(dir, ".claude"));
  const script = Bun.fileURLToPath(new URL("../scripts/configure-hooks.ts", import.meta.url));
  const run = (args) =>
    Bun.spawnSync([process.execPath, script, ...args], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    });
  const help = run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("Usage:");
  const bad = run(["--hosts", "claude-code,codex"]);
  expect(bad.exitCode).toBe(64);
  // A usage line, not an uncaught-error trace.
  expect(bad.stderr.toString()).toStartWith("Usage:");
  expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
});

test("writes the OpenCode plugin and an Antigravity hook group beside existing groups", () => {
  const dir = home();
  const agy = join(dir, ".gemini", "config", "hooks.json");
  mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
  writeFileSync(agy, JSON.stringify({ "lint-checker": { PostToolUse: [] } }));
  mkdirSync(join(dir, ".config", "opencode"), { recursive: true });

  configureSwarmailHooks(dir);
  const groups = JSON.parse(readFileSync(agy, "utf8"));
  expect(Object.keys(groups)).toEqual(["lint-checker", "swarmail-register-hook"]);
  expect(groups["swarmail-register-hook"].PreToolUse[0].matcher).toContain("write_to_file");
  const plugin = readFileSync(join(dir, ".config/opencode/plugin/swarmail-register.ts"), "utf8");
  expect(plugin).toContain(JSON.stringify([swarmailHookPaths(dir).bin, "register"]));
});

test("adds the Claude register and wake hooks once, keeping other hooks", () => {
  const dir = home();
  const path = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"));
  const other = { hooks: [{ type: "command", command: "codegraph prompt-hook" }] };
  writeFileSync(
    path,
    JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [other] } }) + "\n",
  );

  configureSwarmailHooks(dir);
  configureSwarmailHooks(dir);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const ours = (event) =>
    settings.hooks[event].filter((e) => /\.local[\\/]+bin[\\/]+swarmail/.test(JSON.stringify(e)));
  expect(settings.theme).toBe("dark");
  expect(settings.hooks.UserPromptSubmit[0]).toEqual(other);
  expect(ours("UserPromptSubmit")).toHaveLength(1);
  expect(ours("UserPromptSubmit")[0].matcher).toBeUndefined();
  expect(ours("SessionEnd")).toHaveLength(1);
  expect(ours("PreToolUse")[0].matcher).toBe(
    "Edit|Write|MultiEdit|NotebookEdit|edit|write|apply_patch|notebook_edit",
  );
  const wake = ours("Stop");
  expect(wake).toHaveLength(1);
  // Claude cancels an asyncRewake hook at its timeout; this one is about 23 days, under the 2^31 ms timer limit.
  expect(wake[0].hooks[0]).toMatchObject({
    asyncRewake: true,
    command: `${hookBinary(dir)} hook wake claude${windows ? "; exit $LASTEXITCODE" : ""}`,
    timeout: 2_000_000,
  });
  const rearm = ours("PostToolUse");
  expect(rearm).toHaveLength(1);
  expect(rearm[0].matcher).toBeUndefined();
  expect(rearm[0].hooks[0]).toMatchObject({ asyncRewake: true, timeout: 2_000_000 });
});

// Windows hooks run `swarmail hook rearm` instead of this shell (rearmHook, tested in wake.test.js).
test.skipIf(windows)(
  "the PostToolUse re-arm starts a wait only for a registered session with no live waiter",
  () => {
    const dir = home();
    const { bin, rearm } = swarmailHookPaths(dir);
    const state = join(dir, "state");
    mkdirSync(join(dir, ".local/bin"), { recursive: true });
    // Stands in for the binary: records that the shell got past its checks.
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/ran"\n`, { mode: 0o755 });
    const run = (session, extra = {}) => {
      rmSync(join(dir, "ran"), { force: true });
      const res = Bun.spawnSync(["sh", "-c", rearm], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          XDG_STATE_HOME: state,
          CLAUDE_CODE_SESSION_ID: session,
          ...extra,
        },
      });
      expect(res.exitCode).toBe(0);
      return existsSync(join(dir, "ran"));
    };
    expect(run("s-1")).toBe(false); // not registered
    mkdirSync(join(state, "swarmail-register"), { recursive: true });
    writeFileSync(join(state, "swarmail-register/s-1.json"), "{}");
    expect(run("")).toBe(false); // no session id
    expect(run("s-1")).toBe(true); // registered, no waiter yet
    expect(readFileSync(join(dir, "ran"), "utf8").trim()).toBe("hook wake claude");
    expect(run("s-1", { SWARMAIL_WAKE_MOD: "1" })).toBe(false); // the Swarmail mod waits instead
    mkdirSync(join(state, "swarmail-wake"));
    // The shell reads the PID line and leaves the start time on the next one.
    writeFileSync(join(state, "swarmail-wake/s-1"), `${process.pid}\n12345\n`);
    expect(run("s-1")).toBe(false); // a live waiter
    const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
    writeFileSync(join(state, "swarmail-wake/s-1"), `${gone}\n`);
    expect(run("s-1")).toBe(true); // its waiter exited without cleaning up
  },
);

test("hooks run the binary and mod from the Swarmail home when it differs from the profile the hosts read", () => {
  const profile = home();
  const swarmailHome = home();
  mkdirSync(join(profile, ".claude"));
  configureSwarmailHooks(profile, { swarmailHome });
  const settings = JSON.parse(readFileSync(join(profile, ".claude", "settings.json"), "utf8"));
  const { command } = swarmailHookPaths(swarmailHome);
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(command);
  const { dir: plugin, files } = claudeModPlugin(swarmailHome);
  expect(settings.env.CLAUDE_CODE_PLUGIN_DIRS).toBe(plugin);
  for (const file of Object.keys(files)) {
    expect(existsSync(file)).toBe(true);
  }
  expect(existsSync(join(profile, ".local"))).toBe(false);
});

test("installs the Swarmail mod for Claude Code beside the user's plugin directories, and --no-claude-mod removes it", () => {
  const dir = home();
  const path = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/opt/mine", FOO: "1" } }));
  const { dir: plugin, files } = claudeModPlugin(dir);

  configureSwarmailHooks(dir);
  configureSwarmailHooks(dir);
  expect(JSON.parse(readFileSync(path, "utf8")).env).toEqual({
    CLAUDE_CODE_PLUGIN_DIRS: `/opt/mine${delimiter}${plugin}`,
    FOO: "1",
  });
  for (const [file, text] of Object.entries(files)) {
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  expect(JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8"))).toEqual({
    modules: ["./register.js"],
  });
  expect(readFileSync(join(plugin, "hooks/register.js"), "utf8")).toContain(
    readFileSync(new URL("../src/claude-wake-mod.js", import.meta.url), "utf8"),
  );
  expect(configureSwarmailHooks(dir).changed).toEqual([]);

  configureSwarmailHooks(dir, { claudeMod: false });
  expect(JSON.parse(readFileSync(path, "utf8")).env).toEqual({
    CLAUDE_CODE_PLUGIN_DIRS: "/opt/mine",
    FOO: "1",
  });
});

test("withPluginDir adds and removes only its own directory", () => {
  expect(withPluginDir({}, "/p", true, ":")).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/p" } });
  expect(withPluginDir({}, "/p", false, ":")).toEqual({});
  expect(withPluginDir({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/p" } }, "/p", false, ":")).toEqual({
    env: {},
  });
  expect(withPluginDir({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/a:/p::/b" } }, "/p", true, ":")).toEqual(
    { env: { CLAUDE_CODE_PLUGIN_DIRS: "/a:/b:/p" } },
  );
  // Windows: Claude Code splits on ";", and a drive letter's colon stays inside its entry.
  expect(
    withPluginDir({ env: { CLAUDE_CODE_PLUGIN_DIRS: "C:\\a;C:\\p" } }, "C:\\p", true, ";"),
  ).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: "C:\\a;C:\\p" } });
});

test("hook commands name the binary as one shell word on Windows, through the 8.3 name when the profile path needs it", () => {
  expect(hookBinary("/home/me", "linux")).toBe(`"${join("/home/me", ".local/bin/swarmail")}"`);
  const names = {
    "C:\\Users\\Jane Doe": "C:\\Users\\JANEDO~1",
    "C:\\Users\\José": "C:\\Users\\JOS~1",
  };
  const short = (path) => names[path] ?? path;
  expect(hookBinary("C:\\Users\\me", "win32", short)).toBe("C:/Users/me/.local/bin/swarmail.exe");
  expect(hookBinary("C:\\Users\\Jane Doe", "win32", short)).toBe(
    "C:/Users/JANEDO~1/.local/bin/swarmail.exe",
  );
  // The plain shell word is ASCII only.
  expect(hookBinary("C:\\Users\\José", "win32", short)).toBe(
    "C:/Users/JOS~1/.local/bin/swarmail.exe",
  );
  // A volume with 8.3 names turned off has none to give.
  expect(() => hookBinary("C:\\Users\\Jane Doe", "win32", (path) => path)).toThrow("no short name");
  // PowerShell would report the wake's exit 2 as 1 without the explicit exit.
  const paths = swarmailHookPaths("C:\\Users\\me", "win32");
  expect(paths.rearm).toBe("C:/Users/me/.local/bin/swarmail.exe hook rearm; exit $LASTEXITCODE");
  expect(paths.wake("claude")).toBe(
    "C:/Users/me/.local/bin/swarmail.exe hook wake claude; exit $LASTEXITCODE",
  );
  expect(paths.wake("cursor")).toBe("C:/Users/me/.local/bin/swarmail.exe hook wake cursor");
});

test("a Windows install replaces the hook a Linux-style or long-path install wrote", () => {
  const entry = (command) => ({ matcher: "Edit|Write", hooks: [{ type: "command", command }] });
  const fresh = entry("C:/Users/JANEDO~1/.local/bin/swarmail.exe register");
  for (const old of [
    '"C:\\Users\\Jane Doe\\.local\\bin\\swarmail.exe" register',
    '"/home/jane/.local/bin/swarmail" register',
  ]) {
    const config = { hooks: { PreToolUse: [entry("audit"), entry(old)] } };
    expect(withHook(config, "PreToolUse", fresh).hooks.PreToolUse).toEqual([entry("audit"), fresh]);
  }
});

test("adds the Cursor wake hook beside existing stop hooks", () => {
  const dir = home();
  const path = join(dir, ".cursor", "hooks.json");
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: "./audit.sh" }], afterFileEdit: [{ command: "./fmt.sh" }] },
    }),
  );
  configureSwarmailHooks(dir);
  configureSwarmailHooks(dir);
  const config = JSON.parse(readFileSync(path, "utf8"));
  expect(config.hooks.afterFileEdit).toEqual([{ command: "./fmt.sh" }]);
  expect(config.hooks.stop).toEqual([
    { command: "./audit.sh" },
    { command: `${hookBinary(dir)} hook wake cursor`, timeout: 28900 },
  ]);
  const fresh = home();
  mkdirSync(join(fresh, ".cursor"));
  configureSwarmailHooks(fresh);
  expect(JSON.parse(readFileSync(join(fresh, ".cursor", "hooks.json"), "utf8")).version).toBe(1);
});

// The stand-in binary is a shell script, which Windows can't run.
test.skipIf(windows)(
  "the OpenCode plugin forwards v2 edit-tool calls and ignores other tools",
  async () => {
    const dir = home();
    const received = join(dir, "payload.json");
    // Stands in for `swarmail register`.
    const bin = join(dir, "swarmail");
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = register ] && cat > "${received}"\n`, { mode: 0o755 });
    const pluginPath = join(dir, "plugin.js");
    writeFileSync(pluginPath, openCodePlugin(bin));
    const plugin = (await import(pluginPath)).default;
    const hooks = {};
    await plugin.setup({
      location: { directory: "/w" },
      tool: {
        hook: async (name, callback) => {
          hooks[name] = callback;
        },
      },
    });
    hooks["execute.before"]({ tool: "read", sessionID: "ses_0", input: { path: "/w/a" } });
    hooks["execute.before"]({
      tool: "write",
      sessionID: "ses_1",
      input: { path: "/w/a", content: "x" },
    });
    for (let i = 0; i < 100 && !existsSync(received); i++) {
      await Bun.sleep(20);
    }
    expect(JSON.parse(readFileSync(received, "utf8"))).toEqual({
      swarmail_host: "opencode",
      session_id: "ses_1",
      cwd: "/w",
      tool_input: { filePath: "/w/a" },
    });
    // OpenCode 2's patch tool is `patch`, carrying the patch text (shape captured live 2026-09-26).
    rmSync(received);
    const patchText = "*** Begin Patch\n*** Update File: /w/b\n@@\n-a\n+b\n*** End Patch";
    hooks["execute.before"]({ tool: "patch", sessionID: "ses_3", input: { patchText } });
    for (let i = 0; i < 100 && !existsSync(received); i++) {
      await Bun.sleep(20);
    }
    expect(JSON.parse(readFileSync(received, "utf8")).tool_input).toEqual({ command: patchText });
  },
);

test.skipIf(windows)("the OpenCode plugin also forwards OpenCode 1 edit-tool calls", async () => {
  const dir = home();
  const received = join(dir, "payload.json");
  // Stands in for `swarmail register`.
  const bin = join(dir, "swarmail");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = register ] && cat > "${received}"\n`, { mode: 0o755 });
  const pluginPath = join(dir, "plugin.js");
  writeFileSync(pluginPath, openCodePlugin(bin));
  const hooks = await (await import(pluginPath)).default.server({ directory: "/w" });
  await hooks["tool.execute.before"](
    { tool: "edit", sessionID: "ses_2" },
    { args: { filePath: "/w/b" } },
  );
  for (let i = 0; i < 100 && !existsSync(received); i++) {
    await Bun.sleep(20);
  }
  expect(JSON.parse(readFileSync(received, "utf8"))).toEqual({
    swarmail_host: "opencode",
    session_id: "ses_2",
    cwd: "/w",
    tool_input: { filePath: "/w/b" },
  });
});

test("keeps a user's disabled Antigravity group disabled", () => {
  const dir = home();
  const agy = join(dir, ".gemini", "config", "hooks.json");
  mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
  writeFileSync(
    agy,
    JSON.stringify({ "swarmail-register-hook": { enabled: false, PreToolUse: [] } }),
  );
  configureSwarmailHooks(dir);
  expect(JSON.parse(readFileSync(agy, "utf8"))["swarmail-register-hook"].enabled).toBe(false);
});
