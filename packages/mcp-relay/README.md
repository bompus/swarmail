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

## Memory

Each MCP client that launches the relay keeps its own process tree running.
On one Linux machine, with the relay idle after a first request:

| Command                   | Memory, whole process tree |
| ------------------------- | -------------------------- |
| `npx -y swarmail-mcp`     | about 180 MiB              |
| `bunx swarmail-mcp`       | about 82 MiB               |
| `bunx --bun swarmail-mcp` | about 46 MiB               |

Most of the `npx` figure is the `npm exec` process that stays running beside
the relay. `bunx` alone still runs the relay under Node, because the script's
`#!/usr/bin/env node` line wins; `--bun` runs it under Bun. The relay is plain
JavaScript with no dependencies, so it runs unchanged under Bun, but the
repository's relay tests run it under Node only. Use `--bun` only where Bun is
installed.
