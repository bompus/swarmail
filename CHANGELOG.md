# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## 0.1.1 - 2026-10-02

- `configure-hooks.ts` and `configure-mcp.ts` print usage for `--help` and
  exit 64 with a usage line on an unknown flag, before writing anything.
  `configure-hooks.ts` used to ignore every flag and install hooks for every
  host.
- `configure-mcp.ts` registers Claude Code only when `~/.claude.json` or
  `~/.claude/` exists. It used to create `~/.claude.json` in any home.
- `scripts/enable.sh` is executable, so README step 2 runs as written.
- The register hook and `swarmail who` read T3 Code's `statev2.sqlite` when
  it exists, so they find T3 Code Orchestrator V2 threads.
- `configure-hooks.ts` skips hosts whose config directory doesn't exist,
  as `configure-mcp.ts` does. Claude's `settings.json` is written when any
  host that reads it (Claude Code, Cursor, Grok, Devin) is installed.
- `docs/usage.md` says to tell the sender when you won't act on
  `ack_required` mail, when and how to pause your own work for another
  session, and that `macro_start_session` takes `human_key`.

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
