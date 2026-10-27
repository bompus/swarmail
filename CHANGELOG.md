# Changelog

Notable changes to Swarmail. Versions follow [semantic versioning](https://semver.org).

## 0.7.1 - 2026-10-27

- Bun 1.4.2, the oldest version `package.json` allows, can read `bunfig.toml` again. It had written `minimumReleaseAge` as `"3d"`, which only Bun 1.4.4 and later accept, so `bun install` failed on 1.4.2 with "Invalid Bunfig", including the Glama container build. `bun run check` now fails if the value is not a number of seconds.

## 0.7.0 - 2026-10-26

- One machine can serve sessions on others. `SWARMAIL_HOST` adds a second listener on one non-loopback address, such
  as a Tailscale IP, that answers every route except `/healthz` only with `Authorization: Bearer <token>`, where the token is the first
  line of `SWARMAIL_TOKEN_FILE` (32 characters or more). The loopback listener is unchanged. When
  `SWARMAIL_TOKEN_FILE` is set, the `swarmail` command, the register hook, `swarmail-mcp`, the wake hook, the wake
  bridges and `swarmail canary` send the token to a non-loopback `SWARMAIL_URL`, `SWARMAIL_WAKE_URL` or bridge
  `swarmailUrl`; a bridge accepts such a URL only when the token file is named. The Claude Code mod cannot send it, so
  it does nothing for a non-loopback `SWARMAIL_WAKE_URL`. The extra listener speaks plain HTTP, so use it only on a
  network that encrypts every peer, and treat the token as read access to every mailbox, the roster, project paths
  and reservations on that server. A hub stops removing projects whose checkout is gone, and `swarmail overdue`
  refuses to run against a remote server. The mailbox schema moves from version 7 to 9, and a build that supports an
  older schema refuses to open a mailbox at version 9.

- Against a remote server, the `swarmail` command and the register hook name a project by the clone's `origin`
  remote (`git:host/owner/repo`) instead of its checkout path. A hub that holds a clone of the repository answers
  with that checkout's project, so a laptop and the hub share one roster and mailbox for the same repository, and
  the hub's clone takes over a project that remote sessions created first. A hub clone that registered before it had
  an `origin` keeps its own project; the README lists this and the other exceptions. A clone without `origin` cannot use a
  remote server.

- `list_agents` adds `waiting_for_mail` (a wake hook or bridge has a wait open on the server for the session, begun
  after the session's last end report) and `session_ended_at` (the session's SessionEnd hook reported it ended;
  the session's next send, reservation, inbox read, mail change or wait clears it).
  `release_file_reservations` takes `session_ended` and `session_id` for the hook to send; a report from a session
  that no longer holds the name is ignored. Against a remote server, `swarmail who` uses these in place of a process
  check this machine cannot make. The README lists what a remote session still lacks.

- Against a remote server, the git guard reads the hub's exclusive file reservations through the new read-only tool
  `list_file_reservations` and refuses a commit or push that touches one held by another session; a hub it cannot
  reach is reported and the commit goes ahead. The register hook adds `branch:`, `title:` (cut at 120 characters) and `worktree:` (the edit
  checkout) to the session tag, so `swarmail who` shows a remote session's branch, title and location.

- Swarmail is described as usable on one machine or across machines, not as local only: the README, the package and
  plugin descriptions, the MCP server instructions and tool text, the setup scripts' output, the banners and the social
  preview. `bun run check` now also fails when the images, the package descriptions or the public text still say
  otherwise (`scripts/check-public.ts`).

- `bun run check` checks formatting with `bun fmt --no-script --check` instead of oxfmt, and `bun run fmt` writes with
  `bun fmt --no-script`. Both read the same `.oxfmtrc.json` and check the same files with no differences. Contributors
  need Bun 1.4.4 or later.

- `swarmail wake-auto-t3` logs `received SIGTERM; stopping` (or `SIGINT`) when it receives the signal, so a
  signalled stop no longer looks like a silent exit 0 in the journal.

- The provider comparison covers T3 Code 0.1.2 and the reviewed nightly's terminal commands,
  pull-request lookup limits and automatic-notice snooze behavior.

- Automatic T3 wake supervision waits through ordinary backend outages without exhausting a restart
  budget. It resumes after verifying the returning backend, retaining quarantines and pending command
  identities. Authentication, configuration and unsafe credential-state failures still stop supervision.

- The `t3-v1-steer` wake target and support for T3 Code's older database are removed. Current T3 Code runs only its V2
  engine: it keeps its data in `statev2.sqlite` and no longer has the HTTP dispatch route or turn-start command those
  bridges sent, so a `t3-v1-steer` bridge failed its thread check and delivered nothing. A `wake-bridge`, `wake-auto-t3`
  or credential rotation configuration that still names `t3-v1-steer` now fails at startup with
  `target type t3-v1-steer was removed`; change its `target.type` to `t3-v2-queue`. The old bridge's saved state is
  bound to the `t3-v1-steer` destination, so the switched bridge refuses it with `saved mailbox binding differs`: stop
  the old bridge, reconcile its pending delivery as `docs/wake-bridges.md` describes for bridge state, then
  remove that journal before starting the `t3-v2-queue` bridge. The register hook, `who`, agent
  locations, automatic wake and `pr-sessions` read only `statev2.sqlite`. While it is missing, or T3 Code is still
  creating it, they find no T3 threads, and `pr-sessions` exits with an error.

- A wake bridge stops with an authentication failure when T3 Code rejects the token its authorization file currently
  holds (HTTP 401), instead of retrying forever; a standalone bridge whose token was revoked or expired now exits. A
  401 for a token that rotation already replaced is still retried, since rotation writes the new header before revoking
  the old token. `docs/wake-bridges.md` also corrects how notices are recognized: T3 Code records every message a client
  sends as `createdBy: "user"`, so a bridge owns only the notices whose ids it saved, plus the `agent`-labelled ones older T3 releases recorded,
  and it leaves other queued `Swarmail: ` messages alone.

- `pr-sessions` shows which conversations T3 Code is watching a pull request for. Each link now has `watchingSince`:
  when T3 started watching that pull request for the conversation, or null when it is not watching (including after a
  watch ended). A watch whose start time is not a string fails the lookup like other malformed link metadata.

- Swarmail now finds T3 Code's data where T3 Code keeps it. T3 Code reads its data directory from `T3CODE_HOME`
  (a leading `~` means the home directory) and uses `~/.t3` only when that is unset; Swarmail always read `~/.t3`, so
  with `T3CODE_HOME` set the register hook, `who`, agent locations and `pr-sessions` read the wrong database or none.
  They now resolve `T3CODE_HOME` the same way. An explicit `pr-sessions --t3-home` still wins.

- The local T3 lifecycle reader no longer stops tracking after T3 Code deletes old history. Recent T3 Code preview and
  nightly builds delete events that a newer event of the same thread supersedes, which could remove the event the reader
  saved at its last reconciliation; every later reconciliation then reported `unavailable` and held wakes for good. A missing saved
  event now counts as a deletion when its event id appears nowhere else in the table. A different event at that
  sequence, the saved event at another sequence or a watermark that moved backwards still holds the last verified state.
  `docs/wake-bridges.md` now says to use `orchestration_events` for T3 Code 0.1.0 and later,
  `docs/pr-sessions.md` says that one non-GitHub link in a project makes every lookup there exit 1, and
  `docs/provider-coverage.md` covers T3 Code's Muse and Pi providers.

- The `swarmail` binary no longer loads a `.env` or `bunfig.toml` from the directory it runs in. Hooks and the git guard run
  inside other projects, so a project's `.env` could set `SWARMAIL_DB`, `SWARMAIL_URL`, `SWARMAIL_GUARD` or `XDG_*` and point
  them at another database, server or guard setting, and a `preload` in its `bunfig.toml` ran that project's code inside
  swarmail. Settings now come only from the environment the binary is started with. `bun scripts/build.ts --if-stale`
  now also rebuilds when the build script changes, so an installed binary picks this up.

- Under T3 Code, agents are told not to retire themselves at a whole-session closeout. Where configured, closing the thread (local T3 lifecycle reconciliation) or a week idle (`SWARMAIL_RETIRE_DAYS`, default 7;
  `0` disables it) already retires the registration, and later activity under the name reactivates it. Outside T3 the closeout steps are unchanged. The
  connection instructions stay under 4096 characters: the closeout paragraph is shortened to make room, and the
  `retire_agent` description and `docs/usage.md` carry the same rule.

## 0.6.0 - 2026-10-16

- Under T3 Code, agents are told to refer to another agent by its T3 thread link,
  `[title](t3-thread://v1/<t3_thread>)`, instead of its registered name, and to use the name only when the user asks,
  no thread id is known or T3 messaging fails. `whois`, `register_agent` and `macro_start_session` now return the
  agent's `t3_thread`, `fetch_inbox` and `fetch_session_inbox` entries carry the sender's `sender_t3_thread`, and
  `swarmail inbox` prints `[t3-thread://v1/<id>]` after a T3 sender. Outside T3 these fields are null and the link instruction does not
  apply. Several sentences of the connection instructions are shortened to stay under the 4096
  characters a host shows; "Reservations are advisory" is dropped (the opening line still says "advisory file
  reservations").

- `swarmail wake-auto-t3 <config.json> [--check | --retry-thread <id>]` is a built-in command: a supervisor that starts a
  wake bridge for every eligible T3 Codex thread, and every eligible Cursor thread under T3 Orchestrator V2, so they wake on mail
  without per-thread setup. `docs/wake-bridges.md` has the configuration, how a failed bridge is quarantined and how
  to retry it. It runs on Linux only. It is experimental and opt-in (it does nothing without a configuration file): it drives T3 Code through T3's undocumented internal control plane, was written against T3 Code Orchestrator V2 in the 0.0.46 to 0.1.x releases, and a T3 Code update can break it. It may be removed if T3 Code covers waking threads natively.
- `swarmail hook wake cursor` and `swarmail hook context cursor` now return at once for a Cursor session whose settled
  automatic T3 registration belongs to a `wake-auto-t3` bridge, so the hook and the bridge do not both wait on that
  session.

- `docs/provider-coverage.md` and `CONTRIBUTING.md` state the direction toward T3 Code: Swarmail prefers T3 Code's own
  messaging, delegated tasks and queue, keeps only what T3 Code does not provide, and may leave a gap open instead of
  bridging it. The T3 Code section is refreshed to T3 Code 0.1.0 and lists what is rechecked for each T3 Code release.

- `swarmail pr-sessions <PR URL> --project <checkout>` prints, as JSON, which local T3 V2 conversations are linked to a
  GitHub pull request and which Swarmail agents carry their tags. It opens the T3 database read-only and never reads
  conversation content; `docs/pr-sessions.md` lists the arguments, the output and its limits.

- `swarmail canary` sends one message through the running server and follows it to an acknowledgement: it must wake a
  waiting receiver, appear in its inbox and show as read and acknowledged. It appends a line to
  `$XDG_STATE_HOME/swarmail-canary/results.jsonl` and exits 1 on a miss, so a timer can alert on it; `docs/canary.md`
  has the setup.

- `swarmail overdue [--dry-run]` reminds a recipient who has not acknowledged an `ack_required` message, then reports it
  to the operator once if it is still unacknowledged a deadline later, or at once when the sender has retired and no
  reminder can be sent. Run it from a timer; `docs/overdue.md` has the
  settings and a systemd example. The command prints what it does; the operator report also goes to the command
  `SWARMAIL_NOTIFY` names when it is set.

- The MCP connection instructions and `docs/usage.md` no longer use the wording of one person's offer-and-reply
  conventions ("a whole-session All done option", "an unanswered offer", "a bare option code"). They say that the
  user says everything is done, that a question can be unanswered, and that a relayed bare approval such as "B" or "go" is
  ambiguous without the source, action and owner. The meaning is unchanged.

## 0.5.3 - 2026-10-11

- `swarmail inbox --session` works in a T3 child-task session. It printed "invalid host or session identity" and left the
  mail unread, because the check refused the `%` in a child task's thread ID (`thread:delegated-task:command%3A…`).
  Ordinary T3 threads were not affected, and a plain thread ID is still checked as before.

- Mail to a session in a T3 child-task thread defaults to quiet like mail to any other T3 session, as `docs/usage.md`
  says. It defaulted to wake, because the check refused the `%` in a child task's thread ID. Set `notification_policy` to
  `wake` for a child task that must be woken. Mail to a recipient with no valid T3 thread ID still defaults to wake.

- The MCP connection instructions were 4,110 characters, and Claude Code shows only the first 4,096, so the closing
  pointer to `swarmail updates --help` was cut off. They are now 4,082 characters, and a test fails if they pass 4,096.

- The build lays the compiled bytecode out from a recorded profile (`scripts/swarmail.order`, Bun's
  `--bytecode-order`), so what a run needs sits together in the executable. On Bun 1.4.3, on one host, hook commands used
  5% to 18% less peak memory and the idle server 5% less, with no clear change in start-up time or request latency.
  `bun scripts/train-bytecode-order.ts` records the profile again; Bun before 1.4.3 ignores it.

- `docs/provider-coverage.md` lists what Claude Code, Codex, Cursor, Devin, Antigravity, OpenCode, Grok Build and T3
  Code each provide for messaging between independent sessions, what Swarmail adds, and where a host's own feature is
  enough. Each claim about a host in the per-host sections is labelled tested or documented, with the version and date
  it was checked. The README links to it.
  - Two tests are recorded there. An idle Cursor CLI session woke for five mails in a row through Swarmail's stop hook,
    and the sixth waited for the next prompt typed into the session (Cursor's default limit of five follow-ups, which
    the installer leaves in place). The Codex bridge on terminal sessions delivered to an idle session and mid-command,
    and held mail while an approval prompt was open.
  - `docs/usage.md` no longer says mail wakes idle Cursor sessions, which no test showed, and links the coverage page.

- The help text, server instructions, `docs/updates.md` and README say "confirmation" where they said "attestation":
  the caller's own confirmation that it loaded an update target's revision, not proof of provider cache replacement.
  The `attested` status value in `swarmail updates --session --json` is unchanged.

## 0.5.2 - 2026-10-09

- Require agents to record whole-session closeouts and retire their own project
  registrations, with read-only verification and task/pause boundaries.

- A prompt no longer retries a pending registration whose edit checkout has been deleted. The server refuses a
  worktree that is gone, so the hook warned on every prompt until the session ended. The pending entry is dropped;
  the session's next edit registers it again.

- The release check fails for a package that has no row in the listings section of
  `CONTRIBUTING.md`, so a new package cannot ship without a listing decision.

- `swarmail who` asks git about each running T3 thread directory once instead of once per thread. With about 800
  running threads in 149 directories it took 0.3 s instead of 1.6 s.

- `fetch_inbox` and `fetch_session_inbox` no longer read each message body from storage when `include_bodies` is off,
  which is the default. A page of 20 messages took 48 µs instead of 57 µs with 2 KB bodies and 52 µs instead of 82 µs
  with 17 KB bodies.

- The `swarmail-mcp` README lists the memory each launch command costs: about 180 MiB for `npx -y swarmail-mcp`, 82 MiB
  for `bunx swarmail-mcp` and 46 MiB for `bunx --bun swarmail-mcp`, which runs the same relay under Bun.

## 0.5.1 - 2026-10-09

- A session whose usual name is already held by another session in a project
  now registers there under a different name instead of failing. The register
  hook keeps the session's first name everywhere it is free, records the
  different name for that project only, and uses it for that project's
  registrations, `who` rows, availability checks, the session-start notice and
  reservation release. Before, the server refused the name on every prompt and
  edit and the session stayed unregistered in that project.

- The register hook's failure notice says why a registration failed. When the
  server answers and refuses it, such as when the session's reused name is held
  by another session in that project, the notice quotes the server's reason
  instead of saying the server did not answer.

- A `claude -p` run whose `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli` registers with
  Swarmail on its first file edit instead of at session start, so a read-only
  one-shot run no longer adds an agent to the roster. A child that inherited
  `sdk-ts` from an SDK-hosted session, and interactive sessions, still register
  at start.

- On Windows, a host session whose process has exited no longer reads as alive
  while another process still holds a handle to it, such as the parent that
  started it.

- The Claude Code wake mod polls for mail for 3 seconds instead of 25 when no
  person is at the prompt (`claude -p` and SDK hosts). A `claude -p` run started
  from an SDK-hosted session inherits that session's entrypoint, so the mod
  could not tell it apart and held the process open until its wait ended, about
  25 seconds after the answer. The poll still returns as soon as mail arrives.

## 0.5.0 - 2026-10-09

- A Claude Code plugin in `packages/claude-plugin/` connects Claude Code to a
  running local server through a bundled copy of the relay, which needs Node 18
  or newer. Add this repository as a marketplace with
  `claude plugin marketplace add bompus/swarmail`, then install the plugin with
  `claude plugin install swarmail@swarmail`.
- `packages/openai-plugin/` holds a skill-only package for OpenAI's plugin
  directory. Its `swarmail` skill reads and sends mail with the `swarmail`
  command on the user's computer.
- `PRIVACY.md` states what Swarmail stores, who can read it and how long it is
  kept.
- A Codex plugin in `packages/codex-plugin/` connects Codex to a running local
  server through another bundled copy of the relay, which needs Node 18 or
  newer. Add this repository as a marketplace with
  `codex plugin marketplace add bompus/swarmail`, then install the plugin with
  `codex plugin add swarmail@swarmail`.
- A Cursor plugin in `packages/cursor-plugin/` connects Cursor to a running
  local server, for people who install from the Cursor Marketplace.
- A lifecycle reconcile that changes nothing no longer rechecks every waiting
  long poll. Each recheck reconciled again and reread T3's database, so a
  client calling `/lifecycle/reconcile` every 2 seconds with five waiters made
  the server read about 26 MB per call; it now reads about 2.6 MB, measured on
  a local copy of the server against copies of live databases. A change
  found by any reconcile, including a wait status check, still wakes held
  long polls at once, and so does a T3 database that becomes readable again.
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
