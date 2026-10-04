// Glama's container entry (CMD `bun scripts/glama.ts`): starts a Swarmail server in this process and relays stdio
// MCP to it, so Glama can list the tools. A client deployed from Glama reaches only this container's mail, not the
// Swarmail server on the user's own machine.
import { createServer } from "../src/server.ts";
import { databasePath, DEFAULT_PORT } from "../src/paths.ts";

const port = Number(process.env.SWARMAIL_PORT ?? DEFAULT_PORT);
const { server } = createServer(databasePath(), port);
// Unreferenced, the server lets the process exit once stdin closes and the relay has answered the last line.
server.unref();
process.env.SWARMAIL_URL = new URL("/mcp/", server.url).href;
await import("../packages/mcp-relay/index.mjs");
