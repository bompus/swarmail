import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configureSwarmailMcp } from "../scripts/configure-mcp.ts";

const managedUrl = "http://127.0.0.1:18765/mcp/";
const windows = process.platform === "win32";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarmail-mcp-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  return { home, bin };
}
/** Creates each host's config directory, as installing the seven hosts would. */
function installHosts(home: string) {
  for (const dir of [
    ".claude",
    ".codex",
    ".cursor",
    ".grok",
    ".gemini/config",
    ".config/devin",
    ".config/opencode",
  ]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
}
function write(home: string, relative: string, contents: string) {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers all seven clients over HTTP, preserves settings and is byte-stable on repeat", () => {
  const { home } = fixture();
  installHosts(home);
  const hub = write(home, ".codex_hub/config.toml", "not valid TOML");
  const codex = write(
    home,
    ".codex/config.toml",
    '# keep this comment\nmodel = "keep"\n[mcp_servers.codegraph]\ncommand = "custom"\n',
  );
  const claude = write(
    home,
    ".claude.json",
    JSON.stringify({ oauthAccount: { keep: true }, mcpServers: { other: { command: "keep" } } }),
  );
  write(home, ".gemini/config/mcp_config.json", "");
  const opencode = write(
    home,
    ".config/opencode/opencode.jsonc",
    '{ // retained in backup\n"model":"keep", "mcp":{"timeout":5000,"servers":{"other":{"type":"remote","url":"https://example.com"}}},\n}',
  );
  const results = configureSwarmailMcp(home);
  expect(readFileSync(hub, "utf8")).toBe("not valid TOML");
  expect(results).toHaveLength(7);
  expect(results.filter((r) => r.status === "added")).toHaveLength(7);
  expect(readFileSync(codex, "utf8")).toStartWith('# keep this comment\nmodel = "keep"');
  const toml = Bun.TOML.parse(readFileSync(codex, "utf8")) as {
    mcp_servers: Record<string, { command: string }>;
  };
  expect(toml.mcp_servers.codegraph!.command).toBe("custom");
  expect(JSON.parse(readFileSync(claude, "utf8")).oauthAccount).toEqual({ keep: true });
  expect(JSON.parse(readFileSync(opencode, "utf8")).mcp.servers.other.url).toBe(
    "https://example.com",
  );
  expect(JSON.parse(readFileSync(opencode, "utf8")).mcp.timeout).toBe(5000);
  for (const result of results) {
    const raw = readFileSync(result.path, "utf8");
    const parsed = result.path.endsWith("toml") ? Bun.TOML.parse(raw) : JSON.parse(raw);
    const entry = (parsed.mcp_servers ?? parsed.mcpServers ?? parsed.mcp.servers)["swarmail"];
    switch (result.client) {
      case "opencode":
        expect(entry).toEqual({ type: "remote", url: managedUrl });
        break;
      case "claude":
        expect(entry).toEqual({ type: "http", url: managedUrl });
        break;
      case "antigravity":
        expect(entry).toEqual({ httpUrl: managedUrl });
        break;
      case "devin":
        expect(entry).toEqual({ url: managedUrl, transport: "http" });
        break;
      case "cursor":
        expect(entry).toEqual({ url: managedUrl });
        break;
      default: // codex, grok
        expect(entry).toEqual({ url: managedUrl, enabled: true });
    }
    // Windows has no Unix modes; a config under the profile is the user's alone.
    if (!windows) {
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
    if (result.backup) {
      expect(existsSync(result.backup)).toBe(true);
    }
  }
  const written = results.filter((r) => existsSync(r.path));
  const before = written.map((r) => readFileSync(r.path, "utf8"));
  expect(configureSwarmailMcp(home).every((r) => r.status === "preserved-existing")).toBe(true);
  expect(written.map((r) => readFileSync(r.path, "utf8"))).toEqual(before);
  expect(readdirSync(dirname(codex)).filter((n) => n.includes("mcp-backup"))).toHaveLength(1);
});

test("retains an explicitly disabled or custom swarmail server verbatim", () => {
  const { home } = fixture();
  const disabled = '[mcp_servers.swarmail]\nurl = "' + managedUrl + '"\nenabled = false\n';
  const custom =
    '[mcp_servers.swarmail]\ncommand = "custom"\n[mcp_servers.other]\ncommand = "keep"\n';
  const disabledPath = write(home, ".codex/config.toml", disabled);
  const customPath = write(home, ".grok/config.toml", custom);
  const results = configureSwarmailMcp(home);
  const grok = results.find((r) => r.client === "grok");
  expect(results.find((r) => r.client === "codex")!.status).toBe("preserved-disabled");
  expect(grok!.status).toBe("preserved-existing");
  expect(readFileSync(disabledPath, "utf8")).toBe(disabled);
  expect(readFileSync(customPath, "utf8")).toBe(custom);
});

test("preserves extra fields in an existing managed entry and leaves other settings intact", () => {
  const { home } = fixture();
  const projects = { "/proj": { mcpServers: { other: { command: "keep" } } } };
  const claude = write(
    home,
    ".claude.json",
    JSON.stringify({
      projects,
      mcpServers: {
        swarmail: { type: "http", url: managedUrl, startup_timeout_sec: 30 },
        other: { command: "keep" },
      },
    }),
  );
  const secondary = JSON.stringify({
    theme: "keep",
    mcpServers: { other: { httpUrl: managedUrl } },
  });
  const settings = write(home, ".gemini/settings.json", secondary);
  const result = configureSwarmailMcp(home).find((r) => r.client === "claude");
  expect(result!.status).toBe("preserved-existing");
  const parsed = JSON.parse(readFileSync(claude, "utf8"));
  expect(parsed.projects).toEqual(projects);
  expect(parsed.mcpServers.other).toEqual({ command: "keep" });
  expect(parsed.mcpServers.swarmail).toEqual({
    type: "http",
    url: managedUrl,
    startup_timeout_sec: 30,
  });
  expect(readFileSync(settings, "utf8")).toBe(secondary);
});

test("registers only installed hosts", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".codex"));
  const byClient = Object.fromEntries(configureSwarmailMcp(home).map((r) => [r.client, r.status]));
  // Home always exists, so it does not make Claude count as installed.
  expect(byClient).toEqual({
    codex: "added",
    claude: "skipped-absent",
    cursor: "skipped-absent",
    grok: "skipped-absent",
    antigravity: "skipped-absent",
    devin: "skipped-absent",
    opencode: "skipped-absent",
  });
  expect(readdirSync(home).sort()).toEqual([".codex", ".local"]);
});

test("registers Claude when its ~/.claude directory exists", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".claude"));
  const claude = configureSwarmailMcp(home).find((r) => r.client === "claude");
  expect(claude!.status).toBe("added");
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.swarmail).toEqual({
    type: "http",
    url: managedUrl,
  });
});

test("the CLI prints usage for --help and refuses unknown arguments before writing", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".claude"));
  const script = Bun.fileURLToPath(new URL("../scripts/configure-mcp.ts", import.meta.url));
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, script, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  const help = run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("Usage:");
  const bad = run(["--hosts", "claude"]);
  expect(bad.exitCode).toBe(64);
  expect(bad.stderr.toString()).toStartWith("Usage:");
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
});

test("windows mode registers only installed hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "swarmail-mcp-"));
  roots.push(root);
  const win = join(root, "winhome");
  const claude = write(
    win,
    ".claude.json",
    JSON.stringify({ mcpServers: { swarmail: { type: "http", url: managedUrl } } }),
  );
  mkdirSync(join(win, ".cursor"), { recursive: true });
  const opencode = write(
    win,
    ".config/opencode/opencode.json",
    JSON.stringify({ mcp: { servers: { other: { type: "local", command: ["x"] } } } }),
  );
  const results = configureSwarmailMcp(win, { windows: true });
  const byClient = Object.fromEntries(results.map((r) => [r.client, r.status]));
  expect(byClient.claude).toBe("preserved-existing");
  expect(byClient.cursor).toBe("added");
  expect(byClient.devin).toBe("skipped-absent");
  expect(byClient.grok).toBe("skipped-absent");
  const parsed = JSON.parse(readFileSync(claude, "utf8"));
  expect(Object.keys(parsed.mcpServers)).toEqual(["swarmail"]);
  expect(existsSync(join(win, ".grok"))).toBe(false);
  expect(JSON.parse(readFileSync(opencode, "utf8")).mcp.servers["swarmail"]).toEqual({
    type: "remote",
    url: managedUrl,
  });
});

test("refuses an OpenCode 1 config before any writes", () => {
  const { home } = fixture();
  const contents = JSON.stringify({
    mcp: { other: { type: "remote", url: "https://example.com" } },
  });
  const path = write(home, ".config/opencode/opencode.json", contents);
  expect(() => configureSwarmailMcp(home)).toThrow("migrate them under mcp.servers");
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
});

test.each(["{broken", '{"mcpServers":[]}'])(
  "rejects malformed destination before any writes: %s",
  (contents) => {
    const { home } = fixture();
    const path = write(home, ".gemini/config/mcp_config.json", contents);
    expect(() => configureSwarmailMcp(home)).toThrow();
    expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(contents);
  },
);

test.each([".cursor", ".config", ".gemini/config"])(
  "rejects symlinked config parents: %s",
  (relative) => {
    const { home } = fixture();
    const outside = join(dirname(home), "outside");
    mkdirSync(outside);
    mkdirSync(dirname(join(home, relative)), { recursive: true });
    // A junction, which Windows lets any user create; elsewhere the type is ignored.
    symlinkSync(outside, join(home, relative), "junction");
    // Behind a symlinked .config, Devin's directory makes the host count as installed.
    mkdirSync(join(home, relative === ".config" ? ".config/devin" : relative), { recursive: true });
    expect(() => configureSwarmailMcp(home)).toThrow("Expected a real directory");
    const files = readdirSync(outside, { recursive: true, encoding: "utf8" }).filter((f) =>
      statSync(join(outside, f)).isFile(),
    );
    expect(files).toEqual([]);
    expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  },
);

// A file symlink on Windows needs Developer Mode or an administrator.
test.skipIf(windows)("rejects dangling config symlinks", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".codex"));
  symlinkSync(join(home, "missing"), join(home, ".codex/config.toml"));
  expect(() => configureSwarmailMcp(home)).toThrow("Expected a regular config");
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
});

test("dry-run reports would-add without writing", () => {
  const { home } = fixture();
  installHosts(home);
  const results = configureSwarmailMcp(home, { dryRun: true });
  expect(results).toHaveLength(7);
  expect(results.filter((r) => r.status === "would-add")).toHaveLength(7);
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
});

test("selects exactly four clients, including Codex Hub, and is byte-stable on repeat", () => {
  const { home } = fixture();
  installHosts(home);
  mkdirSync(join(home, ".codex_hub"));
  const untouched = write(home, ".cursor/mcp.json", "malformed but unselected");
  const opencode = write(home, ".config/opencode/opencode.jsonc", '{"mcp":{"servers":{}}}');
  const clients = ["codex", "grok", "opencode", "codex-hub"];
  const preview = configureSwarmailMcp(home, { clients, dryRun: true });
  expect(preview.map((r) => r.client).sort()).toEqual([...clients].sort());
  expect(preview.every((r) => r.status === "would-add")).toBe(true);
  expect(existsSync(join(home, ".codex_hub/config.toml"))).toBe(false);
  const results = configureSwarmailMcp(home, { clients });
  expect(results.map((r) => r.client).sort()).toEqual([...clients].sort());
  expect(results.every((r) => r.status === "added")).toBe(true);
  const hub = join(home, ".codex_hub/config.toml");
  expect(Bun.TOML.parse(readFileSync(hub, "utf8"))).toEqual({
    mcp_servers: { swarmail: { url: managedUrl, enabled: true } },
  });
  expect(results.find((r) => r.client === "opencode")!.path).toBe(opencode);
  expect(JSON.parse(readFileSync(opencode, "utf8")).mcp.servers.swarmail).toEqual({
    type: "remote",
    url: managedUrl,
  });
  expect(readFileSync(untouched, "utf8")).toBe("malformed but unselected");
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(readdirSync(join(home, ".config/devin"))).toEqual([]);
  expect(readdirSync(join(home, ".gemini/config"))).toEqual([]);
  const before = results.map((r) => readFileSync(r.path, "utf8"));
  expect(
    configureSwarmailMcp(home, { clients }).every((r) => r.status === "preserved-existing"),
  ).toBe(true);
  expect(results.map((r) => readFileSync(r.path, "utf8"))).toEqual(before);
});

test("does not discover OpenCode or read other clients when only Codex is selected", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".codex"));
  // Traversing this path would fail even before a config could be parsed.
  const unselected = write(home, ".config", "not a directory");
  const results = configureSwarmailMcp(home, { clients: ["codex"] });
  expect(results.map((r) => [r.client, r.status])).toEqual([["codex", "added"]]);
  expect(readFileSync(unselected, "utf8")).toBe("not a directory");
});

test.each(
  [[], [""], ["unknown"], ["codex", "unknown"], ["codex", "codex"], Array<string>(1)].map(
    (clients) => ({ clients }),
  ),
)("rejects invalid client selection before discovering any destination: %j", ({ clients }) => {
  const { home } = fixture();
  write(home, ".config", "not a directory");
  mkdirSync(join(home, ".codex"));
  expect(() => configureSwarmailMcp(home, { clients })).toThrow("client selection");
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
});

test.each([
  ['url = "' + managedUrl + '"\nenabled = false', "preserved-disabled"],
  ['command = "custom"', "preserved-existing"],
  [
    'url = "' +
      managedUrl +
      '"\nstartup_timeout_sec = 30\n[mcp_servers.swarmail.env]\nKEEP = "yes"',
    "preserved-existing",
  ],
])("preserves an existing selected Codex Hub entry verbatim: %s", (entry, status) => {
  const { home } = fixture();
  const contents = "# keep comment\n[mcp_servers.swarmail]\n" + entry + "\n";
  const path = write(home, ".codex_hub/config.toml", contents);
  expect(configureSwarmailMcp(home, { clients: ["codex-hub"] })[0]!.status).toBe(status);
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(readdirSync(dirname(path))).toEqual(["config.toml"]);
});

test("the CLI accepts repeated --client and rejects missing or unknown names before discovery", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".codex_hub"));
  write(home, ".config", "not a directory");
  const script = Bun.fileURLToPath(new URL("../scripts/configure-mcp.ts", import.meta.url));
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, script, "--home", home, ...args]);
  for (const args of [
    ["--client"],
    ["--client", ""],
    ["--client", "unknown"],
    ["--client", "codex", "--client", "codex"],
    ["--client", "--dry-run"],
  ]) {
    const result = run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("client");
    expect(result.stderr.toString()).not.toContain("ENOTDIR");
  }
  const args = ["--client", "codex", "--client", "codex-hub"];
  const preview = run([...args, "--dry-run"]);
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout.toString()).map((r: { status: string }) => r.status)).toEqual([
    "would-add",
    "would-add",
  ]);
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  const result = run(args);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).map((r: { client: string }) => r.client)).toEqual([
    "codex",
    "codex-hub",
  ]);
});
