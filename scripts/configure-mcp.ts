#!/usr/bin/env bun
import { swarmailUrl } from "../src/paths.ts";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { object, present, readConfig } from "./lib/config-files.ts";
import {
  commitMcpPlans,
  mcpHosts,
  mcpParser,
  parseConfigureArgs,
  serversKey,
  serversOf,
  withServers,
  type McpFormat,
  type McpPlan,
  type McpResult,
} from "./lib/mcp-hosts.ts";

// The server's own name; tools appear to agents as `mcp__swarmail__<tool>` and the like.
const serverName = "swarmail";
const managedUrl = swarmailUrl({});
// Replaces a `[mcp_servers.<name>]` table in place; appending would produce a
// duplicate table header, which is invalid TOML.
function replaceTomlSection(
  original: string,
  key: string,
  serverName: string,
  block: string,
): string {
  const header = new RegExp(`^\\s*\\[\\s*${key}\\s*\\.\\s*"?${serverName}"?\\s*\\]\\s*$`);
  const lines = original.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    throw new Error("Managed entry has no replaceable table header: " + key + "." + serverName);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const replacement = block.trimEnd().split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

export interface ServerEntry {
  command?: unknown;
  url?: string;
  serverUrl?: string;
  httpUrl?: string;
  enabled?: boolean;
  disabled?: boolean;
}

type Target = [client: string, path: string, format: McpFormat];
interface HostConfig {
  format: McpFormat;
  original: string;
  settings: Record<string, unknown>;
  servers: Record<string, ServerEntry | undefined>;
}

function rebuild(config: HostConfig, entry: Record<string, unknown>, replace = false): string {
  const { format, original, settings, servers } = config;
  const key = serversKey(format);
  if (format === "toml") {
    const block = Bun.TOML.stringify({ [key]: { [serverName]: entry } }) ?? "";
    return replace
      ? replaceTomlSection(original, key, serverName, block)
      : original + "\n" + block + "\n";
  }
  return (
    JSON.stringify(withServers(settings, format, { ...servers, [serverName]: entry }), null, 2) +
    "\n"
  );
}

// All seven hosts support streamable HTTP, with a host-specific URL shape.
const managedEntry = (format: McpFormat, client: string): Record<string, unknown> =>
  format === "toml"
    ? { url: managedUrl, enabled: true }
    : format === "opencode"
      ? { type: "remote", url: managedUrl }
      : client === "claude"
        ? { type: "http", url: managedUrl }
        : client === "antigravity"
          ? { httpUrl: managedUrl }
          : client === "devin"
            ? { url: managedUrl, transport: "http" }
            : { url: managedUrl };

function planHost(home: string, windows: boolean, [client, path, format]: Target): McpPlan {
  // Register only where the host's config file or directory already exists, so a host that
  // isn't installed gets no config directory. Claude's file sits in home itself, which always
  // exists, so its ~/.claude directory stands in for the config directory.
  const dir = client === "claude" ? join(dirname(path), ".claude") : dirname(path);
  if (!present(path) && !present(dir)) {
    return { client, path, original: "", next: "", status: "skipped-absent" };
  }
  const original = readConfig(path, home);
  const parse = mcpParser(format);
  const settings = object(parse(original.trim() ? original : format === "toml" ? "" : "{}"), path);
  const servers = serversOf(settings, format, path) as Record<string, ServerEntry | undefined>;
  const isManaged = (server: ServerEntry | undefined): boolean =>
    (server?.url ?? server?.serverUrl ?? server?.httpUrl) === managedUrl;
  const config: HostConfig = { format, original, settings, servers };
  const checkRoundTrip = (next: string, entry: Record<string, unknown>): void => {
    if (
      JSON.stringify(serversOf(parse(next), format, path)[serverName]) !== JSON.stringify(entry)
    ) {
      throw new Error("Server did not round-trip: " + path);
    }
  };

  const entry = managedEntry(format, client);
  const existing = servers[serverName];
  if (existing !== undefined) {
    // An explicitly disabled entry is a user choice: keep it verbatim and
    // report it distinctly so it is not silently treated as configured.
    if (existing.enabled === false || existing.disabled === true) {
      return { client, path, original, next: original, status: "preserved-disabled" };
    }
    if (!isManaged(existing) || JSON.stringify(existing) === JSON.stringify(entry)) {
      return { client, path, original, next: original, status: "preserved-existing" };
    }
    const updated = rebuild(config, entry, true);
    checkRoundTrip(updated, entry);
    return { client, path, original, next: updated, status: "updated" };
  }

  const next = rebuild(config, entry, false);
  checkRoundTrip(next, entry);
  return { client, path, original, next, status: "added" };
}

export function configureSwarmailMcp(
  home: string = homedir(),
  { dryRun = false, windows = false }: { dryRun?: boolean; windows?: boolean } = {},
): McpResult[] {
  home = resolve(home);
  const targets = mcpHosts(home, windows).map(({ client, path, format }): Target => [
    client,
    path,
    format,
  ]);
  const plans = targets.map((target) => planHost(home, windows, target));
  return commitMcpPlans(plans, home, dryRun);
}

if (import.meta.main) {
  if (!["linux", "win32"].includes(process.platform) || process.getuid?.() === 0) {
    throw new Error("Run as your normal user, on Linux or Windows.");
  }
  const { dryRun, home, windowsHome, positional } = parseConfigureArgs(process.argv.slice(2));
  if (positional.length > 0) {
    const help = positional.some((arg) => arg === "--help" || arg === "-h");
    (help ? console.log : console.error)(
      "Usage: bun scripts/configure-mcp.ts [--dry-run] [--home DIR] [--windows-home[=DIR]]",
    );
    process.exit(help ? 0 : 64);
  }
  console.log(
    JSON.stringify(
      configureSwarmailMcp(windowsHome ?? home, {
        dryRun,
        windows: windowsHome !== null || process.platform === "win32",
      }),
      null,
      2,
    ),
  );
}
