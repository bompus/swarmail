# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- An idle Claude Code session now wakes on new mail for about 23 days
  after its last turn, up from 8 hours. Claude Code cancels the wake hook
  at its settings timeout, so rerun `bun scripts/configure-hooks.ts` to
  raise it to 2000000 seconds. The hook also starts a new wait when the
  server ends one after a day. Cursor still waits 8 hours.
- A tool call that fails partway writes nothing. A `macro_start_session`
  whose reservation fails used to leave its project and agent behind.
- `ttl_seconds`, `file_reservation_ttl_seconds` and `extend_seconds` must
  be whole JSON numbers from 1 to 2592000 (30 days), and
  `active_within_days` a number above 0. Anything else is an
  `INVALID_ARGUMENT` error, even from a `macro_start_session` that reserves
  no paths. A string TTL used to be accepted, a negative
  one granted an already expired reservation, and a bad `active_within_days`
  returned an empty list.
- The register hook writes its session state to a temporary file and
  renames it into place, so `swarmail who`, the git guard and the wake
  hook never read a half-written file. The file format is unchanged.

## 0.1.2 - 2026-10-03

- A session keeps one name. `register_agent` or `macro_start_session`
  without a name, whose task description starts with a session tag a live
  agent already has, now updates that agent instead of creating a second
  one. Tags match on the same T3 Code thread, or else on the same host and
  session id. Retired agents are not reused.
- The register hook keeps a T3 Code thread's name when T3 starts a new
  provider session in that thread. It used to register the new session
  under a new name while mail kept going to the old one.
- `swarmail register --tag <host>` reads the session id from the host's
  shell variable (`$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`,
  `$CURSOR_CONVERSATION_ID` and so on) when none is given, so a manual tag
  names the session.

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
