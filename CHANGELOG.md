# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- `configure-hooks.ts` refuses `--help` and unknown flags before writing
  anything. It used to ignore them and install hooks for every host.
- `configure-hooks.ts` skips hosts whose config directory doesn't exist,
  as `configure-mcp.ts` does. Claude's `settings.json` is written when any
  host that reads it (Claude Code, Cursor, Grok, Devin) is installed.
- `docs/usage.md` says to tell the sender when you won't act on
  `ack_required` mail, when pausing your own work for another session is
  fine, and that `macro_start_session` takes `human_key`.

## 0.1.0 - 2026-10-02

First public release.

- MCP mail server on `127.0.0.1:18765`: per-repository rosters, threaded
  inboxes with full-text search, acknowledgements and advisory file
  reservations, stored in one SQLite database.
- `swarmail` command for sending, reading, searching and finding sessions.
- Setup scripts for Claude Code, Codex, Cursor, Grok, Antigravity, Devin and
  OpenCode, a register hook that names each session on its first edit, and a
  wake hook that starts a Claude Code or Cursor turn when mail arrives.
- Optional git guard that refuses a commit touching another agent's
  exclusive reservation.
