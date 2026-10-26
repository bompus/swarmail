import { execFileSync } from "node:child_process";

import { authHeaders, swarmailUrl } from "./paths.ts";

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
  // The request goes to curl as a config file on stdin, so the bearer token never appears in the process list or in
  // the message of an error that carries curl's command line.
  const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
  const config = [
    ["header", "content-type: application/json"],
    ["header", "accept: application/json, text/event-stream"],
    ...Object.entries(authHeaders(process.env, url)).map(([name, value]) => [
      "header",
      `${name}: ${value}`,
    ]),
    ["data-binary", request],
    ["url", url],
  ]
    .map(([option, value]) => `${option} = ${quote(value!)}`)
    .join("\n");
  const out = execFileSync(
    "curl",
    ["-sf", "--connect-timeout", "1", "--max-time", "4", "-K", "-"],
    { input: config, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  );
  const { result, error } = JSON.parse(out);
  if (error || !result || result.isError) {
    throw new Error(`${name} failed: ${error?.message ?? result?.content?.[0]?.text}`);
  }
  return JSON.parse(result.content[0].text);
}
