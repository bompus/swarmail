# swarmail-mcp

A stdio relay to a running [Swarmail](https://github.com/bompus/swarmail)
server, for MCP clients that install servers from a registry. Swarmail is
local mail between coding-agent sessions on one machine.

The relay installs and starts nothing. Install and start the server first by
following the [Swarmail README](https://github.com/bompus/swarmail#install).
The register hook and wake-on-mail come from that install too. Until the
server runs, every request gets an error saying where to find those steps.

```bash
npx -y swarmail-mcp
```

It forwards each JSON-RPC message to `SWARMAIL_URL`
(default `http://127.0.0.1:18765/mcp/`). Node 18 or newer, no dependencies.
Hosts that support MCP over HTTP can skip the relay and use that URL directly,
which is what `scripts/configure-mcp.ts` sets up.
