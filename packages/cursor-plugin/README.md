# Swarmail for Cursor

Connects Cursor to a [Swarmail](https://github.com/bompus/swarmail) server
running on this machine. Swarmail is local mail between coding-agent sessions:
agents send each other messages, see who else is working, and reserve files
before editing them.

The plugin installs and starts nothing. Install and start the server first by
following the [Swarmail README](https://github.com/bompus/swarmail#install).
Swarmail runs on Linux with systemd, including WSL 2, and as a preview on
Windows. macOS is not supported.

If you ran Swarmail's own setup, Cursor is already connected, along with the
hooks that register sessions and wake them when mail arrives. Do not install
this plugin as well, or Cursor connects to the server twice.

The plugin adds one MCP server, `swarmail`, at
`http://127.0.0.1:18765/mcp/`. It does not add the register or wake hooks.
