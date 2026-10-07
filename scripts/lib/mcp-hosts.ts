// The MCP host config table and plan/commit loop for scripts/configure-mcp.ts.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { present, readConfig, writeChanged } from "./config-files.ts";

/** `opencode` is the OpenCode 2 shape: servers under `mcp.servers`. */
export type McpFormat = "toml" | "json" | "opencode";

const HOSTS: Array<[client: string, rel: string, format: McpFormat]> = [
  ["codex", ".codex/config.toml", "toml"],
  ["claude", ".claude.json", "json"],
  ["cursor", ".cursor/mcp.json", "json"],
  ["grok", ".grok/config.toml", "toml"],
  ["antigravity", ".gemini/config/mcp_config.json", "json"],
  ["devin", ".config/devin/mcp_config.json", "json"],
  ["opencode", ".config/opencode/opencode.json", "opencode"],
];
const WINDOWS_DEVIN_REL = "AppData/Roaming/devin/mcp_config.json";

/** The config file each host reads under home; opencode uses whichever of .jsonc/.json exists. */
export function mcpHosts(
  home: string,
  windows: boolean,
): Array<{ client: string; path: string; format: McpFormat }> {
  return HOSTS.map(([client, rel, format]) => {
    let path = join(home, client === "devin" && windows ? WINDOWS_DEVIN_REL : rel);
    if (client === "opencode" && present(path + "c")) {
      path += "c";
    }
    return { client, path, format };
  });
}

export function serversKey(format: McpFormat): string {
  return format === "toml" ? "mcp_servers" : format === "opencode" ? "mcp" : "mcpServers";
}

type Table = Record<string, unknown>;

function table(value: unknown, where: string): Table {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object: " + where);
  }
  return value as Table;
}

/** The server table of a parsed host config. */
export function serversOf(
  settings: Table,
  format: McpFormat,
  path: string,
): Record<string, Record<string, unknown> | undefined> {
  const outer = table(settings[serversKey(format)], path + ":" + serversKey(format));
  if (format !== "opencode") {
    return outer as Record<string, Record<string, unknown>>;
  }
  // An OpenCode 1 file keeps servers directly under `mcp`; writing `mcp.servers` beside
  // them would leave a mixed file, so it must be migrated first. `timeout` is OpenCode 2's.
  const legacy = Object.keys(outer).filter((name) => name !== "servers" && name !== "timeout");
  if (legacy.length) {
    throw new Error(
      `OpenCode 1 MCP entries (${legacy.join(", ")}) in ${path}; migrate them under mcp.servers first`,
    );
  }
  return table(outer.servers, path + ":mcp.servers") as Record<string, Record<string, unknown>>;
}

/** `settings` with its server table replaced. */
export function withServers(settings: Table, format: McpFormat, servers: Table): Table {
  const key = serversKey(format);
  return format === "opencode"
    ? { ...settings, [key]: { ...table(settings[key], key), servers } }
    : { ...settings, [key]: servers };
}

export function mcpParser(
  format: McpFormat,
): (text: string) => Record<string, Record<string, Record<string, unknown>>> {
  return (format === "toml" ? Bun.TOML.parse : Bun.JSONC.parse) as (
    text: string,
  ) => Record<string, Record<string, Record<string, unknown>>>;
}

export interface McpPlan {
  client: string;
  path: string;
  original: string;
  next: string;
  status: string;
}

export interface McpResult {
  client: string;
  path: string;
  status: string;
  backup?: string | null;
}

/**
 * Validates that no changing destination moved since planning, then writes each
 * changed plan with a backup. Dry runs report would-add/would-update instead.
 */
export function commitMcpPlans(plans: McpPlan[], home: string, dryRun: boolean): McpResult[] {
  for (const plan of plans) {
    if (plan.original !== plan.next && readConfig(plan.path, home) !== plan.original) {
      throw new Error("Configuration changed during setup: " + plan.path);
    }
  }
  return plans.map(({ client, path, original, next, status }) => {
    if (original === next || dryRun) {
      const reported =
        original === next ? status : status === "added" ? "would-add" : "would-update";
      return { client, path, status: reported };
    }
    mkdirSync(dirname(path), { recursive: true });
    if (readConfig(path, home) !== original) {
      throw new Error("Configuration changed during setup: " + path);
    }
    const backup = writeChanged(path, original, next, "mcp-backup");
    return { client, path, status, backup };
  });
}

/**
 * An explicit `--windows-home=DIR`, or the conventional mount when the bare
 * flag is given; null when Windows registrations were not requested.
 */
export function resolveWindowsHome(args: string[], home: string = homedir()): string | null {
  const flag = args.find((arg) => arg === "--windows-home" || arg.startsWith("--windows-home="));
  if (flag == null) {
    return null;
  }
  if (flag.startsWith("--windows-home=")) {
    const dir = flag.slice("--windows-home=".length);
    if (!dir) {
      throw new Error("--windows-home requires a directory");
    }
    return dir;
  }
  return join("/mnt/c/Users", basename(home));
}

/** `[--dry-run] [--home DIR] [--windows-home[=DIR]]` plus whatever positionals remain. */
export function parseConfigureArgs(args: string[]): {
  dryRun: boolean;
  home: string;
  windowsHome: string | null;
  positional: string[];
} {
  const homeIndex = args.indexOf("--home");
  const home = homeIndex === -1 ? homedir() : args[homeIndex + 1];
  if (!home) {
    throw new Error("--home requires a directory");
  }
  const positional = args.filter(
    (arg, i) =>
      arg !== "--dry-run" &&
      arg !== "--windows-home" &&
      !arg.startsWith("--windows-home=") &&
      (homeIndex === -1 || (i !== homeIndex && i !== homeIndex + 1)),
  );
  return {
    dryRun: args.includes("--dry-run"),
    home,
    windowsHome: resolveWindowsHome(args),
    positional,
  };
}
