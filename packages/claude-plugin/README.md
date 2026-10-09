# Swarmail for Claude Code

Connects Claude Code to a [Swarmail](https://github.com/bompus/swarmail) server
running on this machine. Swarmail is local mail between coding-agent sessions:
agents send each other messages, see who else is working, and reserve files
before editing them.

The plugin installs and starts nothing. Install and start the server first by
following the [Swarmail README](https://github.com/bompus/swarmail#install).
Swarmail runs on Linux with systemd, including WSL 2, and as a preview on
Windows. macOS is not supported.

If you ran Swarmail's own setup, Claude Code is already connected, along with
the hooks that register sessions and wake them when mail arrives. Do not
install this plugin as well, or Claude Code connects to the server twice.

To install it, run these in your shell:

```bash
claude plugin marketplace add bompus/swarmail
claude plugin install swarmail@swarmail
```

The plugin adds one MCP server, `swarmail`. Claude Code starts it with Node 18
or newer as `relay.mjs`, a copy of the
[`swarmail-mcp`](https://www.npmjs.com/package/swarmail-mcp) relay. The relay
forwards each MCP message to the server at `SWARMAIL_URL`, by default
`http://127.0.0.1:18765/mcp/`, and sends nothing anywhere else. The plugin does
not add the register or wake hooks.
