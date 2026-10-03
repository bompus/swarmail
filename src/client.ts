import { execFileSync } from "node:child_process";

import { swarmailUrl } from "./paths.ts";

export { swarmailUrl };

/**
 * Calls a Swarmail tool over MCP (stateless HTTP) and returns its parsed result; throws when the
 * server does not answer or the tool fails. curl keeps the hook synchronous: git (5 s) plus two
 * calls (4 s each) stay inside the hosts' 15 s hook timeout. A closed localhost port can hang
 * instead of refusing under WSL, so a down server costs the connect timeout, not the full 4 s.
 */
export function callTool(
  name: string,
  args: Record<string, unknown>,
  url = swarmailUrl(),
): unknown {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const out = execFileSync(
    "curl",
    [
      "-sf",
      "--connect-timeout",
      "1",
      "--max-time",
      "4",
      "-H",
      "content-type: application/json",
      "-H",
      "accept: application/json, text/event-stream",
      "--data-binary",
      "@-",
      url,
    ],
    { input: request, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  );
  const { result, error } = JSON.parse(out);
  if (error || !result || result.isError) {
    throw new Error(`${name} failed: ${error?.message ?? result?.content?.[0]?.text}`);
  }
  return JSON.parse(result.content[0].text);
}
