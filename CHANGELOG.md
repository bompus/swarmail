# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- The server no longer rewrites idempotency results stored in the
  pre-0.1.0 message format when it opens the database. Every release since
  0.1.0 stores the current format.
- The README names WSL 2 as a supported Linux and says macOS is not
  supported yet.
- The server stores each agent's session tag parts (`host`, `session_id`,
  `t3_thread`, `build`, `cwd`) as indexed columns of `agents`, set whenever a
  registration writes the task description. Opening an older database adds
  them and sets `PRAGMA user_version` to 1. Every open re-derives the columns
  from the descriptions, so rows an older build wrote after a rollback are
  repaired on the next upgrade. With 100 sessions waiting, a send costs
  the server about 40% less CPU, since each waiting session is now an index
  lookup instead of a scan of every description.
- `list_agents` returns `host`, `session_id`, `t3_thread` and `cwd` for each
  agent. On a 250-agent roster this costs about a quarter more server CPU
  per call.
- A wait matches agents by the exact host session id or T3 thread in their
  tag. Before, its id could also match another part of the tag, such as the
  end of a session id that contains a colon.
- The register hook reuses a roster name by the rule the server uses: a row
  from another T3 thread no longer matches only because it carries the same
  provider session id. `rowForSession` in `src/registry.ts` takes the
  session's tag, and `sessionMarker` is gone from `src/tag.ts`.
- `src/paths.ts` holds the default database path, state directory, port and
  URLs.
- Swarmail runs natively on Windows 10 and 11. `scripts/enable-windows.ts`
  builds `~\.local\bin\swarmail.exe` and starts the server in a
  `Swarmail` scheduled task at each logon, hidden and without an
  administrator; a rerun stops the running server by the PID and start time
  it records in `~/.local/state/swarmail-server.json`. The hook and MCP
  installers write the Windows host configs, with Devin's under
  `AppData\Roaming\devin`.
  - Hook commands name the binary as one unquoted path with forward
    slashes, which Git Bash, PowerShell and cmd all run, through the
    profile's 8.3 short name when the path has a space. The installer
    replaces the Swarmail hooks an earlier install wrote, whatever the path
    form.
  - The Claude Code wake and re-arm commands end in `; exit
    $LASTEXITCODE`, since PowerShell reports a native exit code 2 as 1.
    The re-arm runs `swarmail hook rearm`, which makes the checks the Linux
    hook writes as shell.
  - The Swarmail mod lists its directory in `CLAUDE_CODE_PLUGIN_DIRS` with
    `;`, the separator Claude Code splits on in Windows.
  - The wake hook reads its host's parent from kernel32 and its command
    line through PowerShell, and stops waiting once the host process with
    the recorded start time is gone.
  - The server, the register hook, `swarmail who` and the build read `HOME`
    when it is set and the user profile otherwise, keep the Linux layout
    under it, compare paths without regard to case or slash direction, and
    read process identity from kernel32 instead of `/proc`. A rebuild while
    the server runs moves the old `swarmail.exe` aside, since Windows refuses
    to replace a running program.
  - CI runs the checks and the whole test suite on `windows-latest`.
- The commands read standard input as a stream. On Windows,
  `Bun.stdin.text()` let the process exit before reading, and
  `readFileSync(0)` read nothing from a PowerShell pipeline.
- A wake hint writes a backslash in a project path as `/` instead of
  dropping it, so a Windows path stays readable.

## 0.1.4 - 2026-10-03

- `src/cli.ts` exports `main(args, extra)`, so another entry file can
  import it and add subcommands of its own. An extra subcommand with a
  built-in's name is ignored. `scripts/build.ts` compiles `src/main.ts` in
  place of `src/cli.ts` when that file exists.
- `src/cli-extra.ts` and `src/who-extra.ts` are gone. `swarmail who`
  reads `SWARMAIL_LIVE_ROOM` itself, as before, and the README lists it
  under Settings.

## 0.1.3 - 2026-10-03

- Claude Code sessions now wake through the Swarmail mod, a Claude Code
  plugin. `bun scripts/configure-hooks.ts` copies it to
  `~/.local/share/swarmail/claude-plugin` and adds that directory to
  `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping
  directories already listed there. The mod waits for mail for as long as
  the session runs, with no hook process beside it (about 38 MB each).
  Mail during a turn arrives with the next tool result. The wake hooks
  stand down in a session that runs the mod. Cursor, and a Claude Code
  without mods, keep the hooks. With `--no-claude-mod`, new sessions go
  back to the hooks. Tested with Claude Code 2.1.288.
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
