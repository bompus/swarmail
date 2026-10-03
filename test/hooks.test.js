import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureSwarmailHooks,
  openCodePlugin,
  swarmailHookPaths,
} from "../scripts/configure-hooks.ts";

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
      hooks: [{ type: "command", command: `"${dir}/.local/bin/swarmail" register`, timeout: 15 }],
    },
  ]);
  expect(configureSwarmailHooks(dir).changed).toEqual([]);
});

test("writes the OpenCode plugin and an Antigravity hook group beside existing groups", () => {
  const dir = home();
  const agy = join(dir, ".gemini", "config", "hooks.json");
  mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
  writeFileSync(agy, JSON.stringify({ "lint-checker": { PostToolUse: [] } }));

  configureSwarmailHooks(dir);
  const groups = JSON.parse(readFileSync(agy, "utf8"));
  expect(Object.keys(groups)).toEqual(["lint-checker", "swarmail-register-hook"]);
  expect(groups["swarmail-register-hook"].PreToolUse[0].matcher).toContain("write_to_file");
  const plugin = readFileSync(join(dir, ".config/opencode/plugin/swarmail-register.ts"), "utf8");
  expect(plugin).toContain(JSON.stringify([join(dir, ".local/bin/swarmail"), "register"]));
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
    settings.hooks[event].filter((e) => JSON.stringify(e).includes("/.local/bin/swarmail"));
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
  expect(wake[0].hooks[0]).toMatchObject({
    asyncRewake: true,
    command: `"${join(dir, ".local/bin/swarmail")}" hook wake claude`,
  });
  const rearm = ours("PostToolUse");
  expect(rearm).toHaveLength(1);
  expect(rearm[0].matcher).toBeUndefined();
  expect(rearm[0].hooks[0]).toMatchObject({ asyncRewake: true, timeout: 28900 });
});

test("the PostToolUse re-arm starts a wait only for a registered session with no live waiter", () => {
  const dir = home();
  const { bin, rearm } = swarmailHookPaths(dir);
  const state = join(dir, "state");
  mkdirSync(join(dir, ".local/bin"), { recursive: true });
  // Stands in for the binary: records that the shell got past its checks.
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/ran"\n`, { mode: 0o755 });
  const run = (session) => {
    rmSync(join(dir, "ran"), { force: true });
    const res = Bun.spawnSync(["sh", "-c", rearm], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        XDG_STATE_HOME: state,
        CLAUDE_CODE_SESSION_ID: session,
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
  mkdirSync(join(state, "swarmail-wake"));
  writeFileSync(join(state, "swarmail-wake/s-1"), `${process.pid}\n`);
  expect(run("s-1")).toBe(false); // a live waiter
  const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
  writeFileSync(join(state, "swarmail-wake/s-1"), `${gone}\n`);
  expect(run("s-1")).toBe(true); // its waiter exited without cleaning up
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
    { command: `"${join(dir, ".local/bin/swarmail")}" hook wake cursor`, timeout: 28900 },
  ]);
  const fresh = home();
  configureSwarmailHooks(fresh);
  expect(JSON.parse(readFileSync(join(fresh, ".cursor", "hooks.json"), "utf8")).version).toBe(1);
});

test("the OpenCode plugin forwards v2 edit-tool calls and ignores other tools", async () => {
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
});

test("the OpenCode plugin also forwards OpenCode 1 edit-tool calls", async () => {
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
