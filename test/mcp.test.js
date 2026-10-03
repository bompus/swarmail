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
const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarmail-mcp-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  return { home, bin };
}
/** Creates each host's config directory, as installing the seven hosts would. */
function installHosts(home) {
  for (const dir of [
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
function write(home, relative, contents) {
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
  expect(results).toHaveLength(7);
  expect(results.filter((r) => r.status === "added")).toHaveLength(7);
  expect(readFileSync(codex, "utf8")).toStartWith('# keep this comment\nmodel = "keep"');
  expect(Bun.TOML.parse(readFileSync(codex, "utf8")).mcp_servers.codegraph.command).toBe("custom");
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
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
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
  expect(results.find((r) => r.client === "codex").status).toBe("preserved-disabled");
  expect(grok.status).toBe("preserved-existing");
  expect(readFileSync(disabledPath, "utf8")).toBe(disabled);
  expect(readFileSync(customPath, "utf8")).toBe(custom);
});

test("updates only the Swarmail entry and preserves project and secondary settings", () => {
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
  expect(result.status).toBe("updated");
  const parsed = JSON.parse(readFileSync(claude, "utf8"));
  expect(parsed.projects).toEqual(projects);
  expect(parsed.mcpServers.other).toEqual({ command: "keep" });
  expect(parsed.mcpServers.swarmail).toEqual({ type: "http", url: managedUrl });
  expect(readFileSync(settings, "utf8")).toBe(secondary);
});

test("registers only installed hosts", () => {
  const { home } = fixture();
  mkdirSync(join(home, ".codex"));
  const byClient = Object.fromEntries(configureSwarmailMcp(home).map((r) => [r.client, r.status]));
  // Claude's config sits in the home directory itself, so it always counts as installed.
  expect(byClient).toEqual({
    codex: "added",
    claude: "added",
    cursor: "skipped-absent",
    grok: "skipped-absent",
    antigravity: "skipped-absent",
    devin: "skipped-absent",
    opencode: "skipped-absent",
  });
  expect(readdirSync(home).sort()).toEqual([".claude.json", ".codex", ".local"]);
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
    symlinkSync(outside, join(home, relative));
    // Behind a symlinked .config, Devin's directory makes the host count as installed.
    mkdirSync(join(home, relative === ".config" ? ".config/devin" : relative), { recursive: true });
    expect(() => configureSwarmailMcp(home)).toThrow("Expected a real directory");
    const files = readdirSync(outside, { recursive: true }).filter((f) =>
      statSync(join(outside, f)).isFile(),
    );
    expect(files).toEqual([]);
    expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  },
);

test("rejects dangling config symlinks", () => {
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
