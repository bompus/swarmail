<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bompus/swarmail/main/docs/assets/banner-dark.png">
    <img src="https://raw.githubusercontent.com/bompus/swarmail/main/docs/assets/banner-light.png" alt="swarmail: Mail between coding-agent sessions, on one machine or across machines" width="100%">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/bompus/swarmail/actions/workflows/ci.yml"><img src="https://github.com/bompus/swarmail/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/bompus/swarmail/releases/latest"><img src="https://badgen.net/github/release/bompus/swarmail" alt="Latest GitHub release"></a>
  <a href="https://www.npmjs.com/package/swarmail-mcp"><img src="https://badgen.net/npm/v/swarmail-mcp" alt="Latest swarmail-mcp version on npm"></a>
  <a href="https://github.com/bompus/swarmail/blob/main/LICENSE"><img src="https://badgen.net/badge/license/MIT/blue" alt="MIT license"></a>
  <a href="https://glama.ai/mcp/servers/bompus/swarmail"><img src="https://glama.ai/mcp/servers/bompus/swarmail/badges/score.svg" alt="swarmail on Glama"></a>
  <a href="https://mcprush.com/to/swarmail-mcp?ref=badge"><img src="https://mcprush.com/badge/swarmail-mcp/score.svg" alt="Swarmail MCP on MCPRush"></a>
</p>

<p align="center">
  <a href="https://github.com/bompus/swarmail#how-agents-use-it">MCP server</a>&nbsp;·
  <a href="https://github.com/bompus/swarmail/blob/main/docs/usage.md#reading-mail">Threaded inbox and search</a>&nbsp;·
  <a href="https://github.com/bompus/swarmail/blob/main/docs/usage.md#file-reservations">File reservations</a>&nbsp;·
  <a href="https://github.com/bompus/swarmail#waking-sessions">Wake on mail</a>
</p>

`swarmail-mcp` is a stdio relay to a running [Swarmail](https://github.com/bompus/swarmail)
server, for MCP clients that install servers from a registry. Swarmail is
mail between coding-agent sessions, on one machine or across machines.

The relay does not install or start the server. Install and start it first by
following the [Swarmail README](https://github.com/bompus/swarmail#install).
The register hook and wake-on-mail come from that install too. Until the
server runs, every request gets an error saying where to find those steps.

```bash
npx -y swarmail-mcp
```

It forwards each JSON-RPC message to `SWARMAIL_URL`
(default `http://127.0.0.1:18765/mcp/`). Node 18 or newer, no dependencies.
For a server on another machine, follow the
[remote server setup](https://github.com/bompus/swarmail#using-it-from-another-machine)
first. Set `SWARMAIL_URL` to its full MCP endpoint, such as
`http://<hub address>:18765/mcp/`.
Set `SWARMAIL_TOKEN_FILE` to a file whose first line is the token that server
requires. The relay sends it as a bearer token and never reads the file for a
`localhost`, `127.0.0.1` or `[::1]` URL.
Hosts that support MCP over HTTP can skip the relay and use that URL directly,
which is what `scripts/configure-mcp.ts` sets up.

## Memory

Each MCP client that launches the relay keeps its own process tree running.
Recorded on 2026-10-09 on one Linux machine, with the relay idle after a first
request. These figures have not been remeasured for later
releases:

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
