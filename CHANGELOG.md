# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- A Claude Code plugin in `packages/claude-plugin/` connects Claude Code to a
  running local server. Add this repository as a marketplace with
  `claude plugin marketplace add bompus/swarmail`, then install the plugin with
  `claude plugin install swarmail@swarmail`.
- A Cursor plugin in `packages/cursor-plugin/` connects Cursor to a running
  local server, for people who install from the Cursor Marketplace.
- Export `pause(ms, signal)` from `wake-loop.ts`: a wait that ends as soon as its
  signal aborts. The delivery loop's retry backoff now uses it.
- Sort package fields and dependency maps with Oxfmt while preserving script order.

- Check authored documentation and configuration files with Oxfmt; preserve
  the generated dependency lockfile.
- Sending guidance gives coordination messages a brief Markdown recipe with
  receiver-needed facts, an explicit next action and linked execution details.

## 0.4.0 - 2026-10-07

- Default ordinary normal/low, acknowledgement-free mail to quiet when every
  recipient has a valid registered T3 thread ID. Explicit policies, urgent mail
  and mixed or unidentified recipients retain their existing behavior.

- Add optional T3 credential, backend identity and polling modules for reader consumers.
  Clean owned credentials retry measured connection refusal, reset and request timeout
  within one five-minute grace. Rejection and unfinished ownership stay outside that
  retry path. Source availability does not install or restart a reader.

- Remove unused installer fields and an unused generic V2 command builder; retain notice and legacy journal delivery. Process readers now explicitly support only Linux and Windows.
- Add validated resource release/cancellation notices with generated readable text and derived quiet or actionable delivery, available through MCP send_message and CLI JSON stdin.
- Keep resource coordination and receiver summaries relevant, with readable sender prose.

- Preserve hook configuration files when only JSON object key order or formatting differs; report and repair changed values as before.

- Product guidance clarifies roster/ping evidence, acknowledgment timing and
  metadata-only session inboxes; CLI help explains the optional update lifecycle.
- Maintenance documentation distinguishes idle-agent retirement from startup
  and hourly retry-key cleanup.

- Sending guidance distinguishes informational messages from requested work,
  and source implementation from update installation or guidance additions.

- Readable mail output labels senders with session titles or repository names
  when available. The identity-checked session inbox calls its receiver "this
  session"; sender names, JSON and stored message bodies are preserved. Product
  guidance asks agents to label
  session references in their own summaries.

- MCP connections and CLI help provide Swarmail's agent briefing, with concise
  sending guidance beside send and reply tools. Personal agent rules are no
  longer required to obtain product guidance; client exposure and refresh vary.

- Validator research is preserved through a pinned historical link in the
  README instead of a report in the current source tree.

- Sends and replies support quiet normal/low informational mail, retained in
  inbox and search without automatic wakeups. Urgent mail and acknowledgement
  requests require wake delivery. Non-T3 and mixed recipients keep wake delivery
  by default; ordinary registered T3 recipients default to quiet as described above.

- Opt-in approved update targets produce one pending hint at supported session
  context hooks. Loaded attestations are separate from mail acknowledgments;
  frozen contexts can hold updates. `swarmail updates --session` exposes pending
  targets, and `/versions` reports the running build and protocol-specific tool
  fingerprint. Checks never install, restart or wake idle sessions.

- Mail result validation uses direct checks without runtime package dependencies.
  JSON Schema validation remains a development test reference.

- Replies default to no acknowledgement request, even when the original message
  requested one. Set `ack_required: true` to request acknowledgement of a reply.
  Existing retry records retain their original result.
- Modern MCP requests receive closed output schemas and structured results for
  sends, replies and delivery receipts alongside the existing JSON text. Result
  validation runs before transaction commit. Legacy requests retain text results;
  unsupported protocol headers fail before execution.
- The npm relay forwards the successfully negotiated MCP protocol version on
  subsequent requests. Core, relay and registry versions are aligned at 0.4.0.
  Release checks reject mismatched versions.

## 0.3.0 - 2026-10-06

- Session name discovery uses the explicit provider session ID when several
  sessions share a host process. Ambiguous process-only discovery claims no
  names, so the roster and Git guard cannot treat a sibling session as their own.

- Original senders can withdraw unclaimed recipient deliveries and edit message
  priority with revision checks and required retry keys. Live inbox/wake paths
  exclude withdrawn deliveries while content, receipts and audit remain. Priority
  edits create no new notice. Execution defaults off until all readers are
  qualified and explicitly enabled.

- Sends and replies refresh configured T3 lifecycle state before admission.
  Rejected recipients have explicit reasons and leave no partial message.
  Stored mail includes durable admission observations and warns when session
  availability or wake support is unknown. Replayed observations are historical.

- Roster entries absent from the visible result now show registration and
  delivery as unknown. A capped or filtered roster does not prove a session
  never registered or cannot receive mail.

- Explicit local T3 V2 lifecycle reconciliation hides settled, archived and
  deleted identities from the roster and rejects new mail or reservations.
  Verified reopening preserves names, history and unread mail. Wake delivery
  holds pending notices when lifecycle is inactive or unavailable.

- Session inbox drains stop after an underfull page, avoiding an extra empty
  fetch. MCP and usage guidance use the same capped page-size rule.

- Generic inbox notices are suppressed after admission until the receiving
  session drains its unread mail. Partial reads and previews keep the notice
  outstanding; lost offers retry their original event across restart.

- Configured wake bridges are available through `swarmail wake-bridge` for
  T3 Code, OpenCode and native Unix Codex/Grok targets. They preserve delivery
  journals across restart and require explicit target configuration.

- Mail notices use one short inbox instruction. `swarmail inbox --session`
  discovers the receiving session and drains unread mail across repositories;
  `fetch_session_inbox` provides the corresponding explicit MCP interface.

- Usage guidance explains retry-key conflicts, empty keys and cleanup timing.
  A missing roster row no longer implies that a session never registered.

## 0.2.5 - 2026-10-05

- Wake adapters can read current unread mailbox identities through `/wait/peek`
  without changing wake cursors, mail receipts or an outstanding wait.

- Tool help explains search and inbox selection, bounded thread results, retry
  keys, return fields and reservation filters. Handlers and API defaults stay
  unchanged.

- `swarmail register --host <host>` selects the host explicitly.

- Native Cursor, Devin and Antigravity hooks deliver mail at the next context
  point during active work without cancelling the task or requiring T3 Code.
  Devin gets its own hook configuration on Linux and Windows. The hooks use
  an immediate wake check, suppress repeated notices and preserve inbox mail.

- Inbox help and usage explain how to read bodies and page through all unread
  mail, and how to preview metadata without marking it read. Unread-count
  guidance covers paused sessions and unavailable delivery. API defaults stay
  unchanged.

## 0.2.4 - 2026-10-04

- Roster titles use native Codex, Grok, OpenCode, Devin and AGY CLI metadata
  when no T3 title is available. Sender locations keep the title at send time.

- README performance charts rank each metric, and smaller tables show latency,
  throughput, memory and startup with explicit sort columns.

- The README compares roster scope, search, threads, receipts, file reservations
  and idle wakes across the six benchmarked servers, with pinned source links.

## 0.2.3 - 2026-10-04

- Tool descriptions distinguish preserved message timestamps from refreshed agent
  activity on repeated acknowledgements, and explain when to release reservations
  instead of renewing them and how release filters combine.
- The release guide covers Glama Auto-Release and the delay before its public
  listing and scores update.
- Roster entries include an edit location with the repository, worktree, current
  branch and available T3 title. Agent names and launch directories stay stable.
  New messages retain their sender location at send time; older messages keep
  an unknown location.

## 0.2.2 - 2026-10-04

- Every tool now declares MCP annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint: false`), and every parameter has a
  description. Tool descriptions name the tool to use instead where two are
  close, such as `whois` and `list_agents`, or `mark_message_read` and
  `acknowledge_message`. The tools/list answer grows from 10,980 to 18,110
  bytes.
- The server sets SQLite's 5-second busy timeout before its first statement,
  so a start that finds another process holding the database, or recovering
  its write-ahead log (`SQLITE_BUSY_RECOVERY`), waits instead of exiting with
  "database is locked".
- When a tool names an agent that is not in the project but is registered
  under another `project_key`, the NOT_FOUND error names that project and
  says to pass its key, instead of telling the caller to check the spelling.
  When the name is registered in several projects, it names them all and
  says to pass one of their keys. The error data lists those projects as
  `registered_in`.
- `swarmail-mcp` (`packages/mcp-relay/`), a stdio relay for MCP clients that
  install servers from a registry or speak only stdio. It forwards each
  JSON-RPC message to the running server at `SWARMAIL_URL` and answers every
  request with an error naming the install steps while the server is down.
  Node 18 or newer, no dependencies. `server.json` describes it for the
  official MCP registry as `io.github.bompus/swarmail`.
- `scripts/glama.ts`, the entry Glama's container build runs so it can list
  the tools. It starts a server in the same process, with its database under
  the container's home, and serves the relay on stdin and stdout. It exits
  when stdin closes. A server deployed from Glama holds only that container's
  mail.

## 0.2.1 - 2026-10-04

- Claude Code and Cursor sessions register when they start, and the agent is
  told its Swarmail name. Before, the register hook ran only on the first edit,
  so an agent that registered itself first got one name and the hook gave the
  same session a second. A session started outside a repository is told its
  session tag instead, which keeps its name when it registers by hand. Run the
  hooks installer again to add the hook. `macro_start_session` and
  `register_agent` say to reuse the name the hook gave.
- The register hook's placeholder task reads "registered by hook" instead of
  "registered on first edit".
- LICENSE names the copyright holder as Aaron Queen instead of the GitHub
  handle bompus. The license terms are unchanged.

## 0.2.0 - 2026-10-03

- On native Windows, `swarmail who` can tell whether a Cursor CLI session is
  still running. The Cursor CLI runs there as a `node.exe` under its
  `cursor-agent` directory, which the register hook did not recognize as the
  session's host, so it showed "liveness unknown" (#27).
- The README's performance numbers come from a new run timed with standard
  tools: hyperfine for startup, Tinybench for latency and oha for requests per
  second. [docs/benchmarks.md](docs/benchmarks.md) has the method and each
  tool's output, and adds agent-inbox. The load stage now sends 1,000 requests
  per operation instead of 300. Startup reads 44 ms instead of 18 ms because
  hyperfine's time includes its wrapper (8.5 ms) and killing the server; the
  server's own time to healthy went from 18 ms to 25 ms.
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
- Swarmail runs natively on Windows 10 and 11, as a preview: the hooks
  have not yet run inside a live Claude Code or Cursor session there.
  `scripts/enable-windows.ts` builds `~\.local\bin\swarmail.exe` and
  starts the server in a
  `Swarmail` scheduled task at each logon, hidden and without an
  administrator; a rerun stops the running server by the PID and start time
  it records in `.local\state\swarmail-server.json` under the user profile. The hook and MCP
  installers write the Windows host configs, with Devin's under
  `AppData\Roaming\devin`. `enable-windows.ts` reads `SWARMAIL_PORT` from
  the saved user environment the task gets, and warns when the terminal's
  value differs.
  - Hook commands name the binary as one unquoted path with forward
    slashes, which Git Bash, PowerShell and cmd all run, through the
    profile's 8.3 short name when the path has a space or a non-ASCII
    letter. The installer replaces the Swarmail hooks an earlier install
    wrote, whatever the path form. The hooks and the Swarmail mod use the
    binary under `HOME` when it is set, where the build puts it, while the
    host configs stay under the profile the hosts read.
  - The Claude Code wake and re-arm commands end in `; exit
    $LASTEXITCODE`, since PowerShell reports a native exit code 2 as 1.
    Under cmd the CLI ignores that suffix, which arrives as arguments.
    The re-arm runs `swarmail hook rearm`, which makes the checks the Linux
    hook writes as shell. The wait records its start time beside its PID,
    and the re-arm counts a waiter as live only while that same process
    runs.
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
