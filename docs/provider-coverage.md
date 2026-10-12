# Provider coverage

What each agent host already provides for sessions that talk to each other,
where Swarmail adds to it, and where the host's own feature is enough. Checked
on 2026-10-11 against the versions in the table below. Hosts change quickly, so
recheck a limit before you depend on it.

"Independent sessions" means sessions you started yourself, in separate
terminals, windows or worktrees. A subagent that a session starts for itself
reports to its parent. It is a different feature and is not covered here.

Every claim about a host in the per-host sections carries one of two labels. The summary
table and the list of gaps condense those sections and carry no labels of their
own, so check a claim there against its host's section:

- **Tested**: observed in a live run on 2026-10-11, on the version shown.
- **Documented**: taken from the host's documentation, release notes, source
  code or `--help` output, and not run.

"No inbox" or "no receipts" means the documentation and help output for that
version show none. A test did not prove the absence.

## Summary

| Host (version checked)           | Messages another independent local session             | Starts a turn in an idle session                                        | Swarmail delivers its notice through                                                |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Claude Code 2.1.296              | Yes, to live sessions on the same machine              | Yes                                                                     | The Swarmail mod, or the wake hook                                                  |
| Codex CLI 0.162.1                | Yes, for sessions on the shared app-server daemon      | Yes, tested                                                             | An opt-in bridge on the app-server queue API                                        |
| Cursor (cursor-agent 2026.10.01) | No                                                     | No for local sessions. A cloud agent takes a follow-up                  | The wake hook, and context after tool calls                                         |
| Devin CLI 3000.11.3              | No, except cloud sessions through the API              | No                                                                      | Context after tool calls, and a continue at `Stop`                                  |
| Antigravity (agy 1.3.3)          | Yes, tested: `send_message` reaches a separate process | No for an idle interactive session, tested: delivered at next turn      | Context before each model call, and a continue at `Stop`                            |
| OpenCode 2.0.26                  | No. A client can prompt a session through the HTTP API | Yes, through the prompt API (experimental)                              | An opt-in bridge on the prompt API. Without it, mail is seen at the next inbox read |
| Grok Build 1.0.50                | No                                                     | Only in a session hosted by a leader, through an undocumented extension | An opt-in bridge on that extension. Without it, mail is seen at the next inbox read |
| T3 Code 0.0.46-nightly.20261008  | Yes, between T3 threads                                | Yes                                                                     | An opt-in bridge                                                                    |

Swarmail delivers through each host's own entry point. It does not replace the
host's messaging. Its notice is one line telling the session to read its inbox.

## What no host provides

In the versions checked, no host documents any of these. Swarmail fills them.

1. **Mail that waits.** A message to a session that is busy, closed or on
   another host stays stored, grouped in threads and searchable. Claude Code's
   same-machine messages need the recipient's live inbox socket, though a
   message held for approval waits (five minutes by default). Codex stores
   queued messages but has no inbox, thread view or search. OpenCode keeps a
   durable inbox of input not yet delivered to a session (`GET
   /api/session/{sessionID}/inbox`). Its documentation shows no thread view,
   search or receipts for it.
2. **Receipts and priority.** No host documents a read or acknowledgement
   receipt, or a priority the sender sets. Claude Code tells the sender when a
   send is refused, and a mod's `$.session.send` reports whether the message was
   queued. T3 Code returns a message ID and a delivery outcome. Antigravity
   labels a delivered message with a priority that the sender did not set.
3. **One channel across hosts.** Each host's feature reaches sessions of the
   same host. T3 Code's tools reach threads on any provider it hosts, but only
   threads inside T3 Code. It also lets Claude Code and Codex sessions in a
   terminal read and message its threads, and the documentation describes no
   feature in the other direction.
4. **One roster across hosts.** Hosts list their own sessions: `claude agents`
   and `/list-agents`, `codex agents`, `grok dashboard`. No host documents a
   list across hosts that shows each session's repository, worktree, branch and
   title.
5. **Advisory file reservations and the git guard.** Hosts that isolate edits
   do it with worktrees. Claude Code's documentation says its worktree checks
   do not track files a shell command such as `cp` writes, and that two agent
   teammates editing the same file overwrite each other.
6. **A way to wake hosts that other local sessions cannot wake.** Cursor and
   Devin document none. Antigravity's `send_message` did not wake an idle
   interactive session in the test below. OpenCode and Grok can be reached only
   through the OpenCode prompt API or Grok's undocumented extension. Swarmail's
   hooks for Devin and Antigravity act during a turn or when it ends, and
   cannot wake an idle session. Its Cursor hook holds the turn open and wakes
   the session up to five times between prompts. Opt-in bridges reach OpenCode, Grok and T3 Code
   threads.

## When a host's own feature is enough

- Two Claude Code sessions on one machine, both running, passing a finding:
  native messaging.
- Two Codex terminal sessions on the default daemon: `codex queue` or the
  Codex task tools.
- Two running Antigravity sessions: `send_message`, with delivery at the
  recipient's next turn.
- Two T3 Code threads: `t3_thread_send`, when the sender is in a run and its
  permission modes are at least the target's.
- A session handing work to its own subagent: always the host's delegation.

If every session you run is on one of these hosts, and a message only needs to
reach a session that is running now, you do not need Swarmail for messaging.
Swarmail starts to matter when a message has to survive, be searched or be
acknowledged, when sessions run on different hosts, or when sessions share a
checkout and need reservations.

## Claude Code

- **Messaging (documented).** `SendMessage` and `ListAgents` are on by default
  from 2.1.224 on macOS, Linux and WSL 2, and from 2.1.234 on native Windows.
  With Bedrock, Vertex, Foundry or feature-flag fetching off, same-machine
  messaging needs 2.1.248. Same-machine messages travel over a per-session Unix
  socket (a named pipe on native Windows), not through Anthropic's servers. A
  running recipient reads the message between tool calls, and an idle recipient
  starts a new turn.
- **Limits (documented).** Only sessions that bind an inbox socket receive, so
  a session started with `--bare` does not. Messages are plain text, and a
  same-machine message is refused once its serialized form passes about a
  million characters. A recipient queues at most 50 messages and throttles
  loops. When `crossSessionInbound` is unset, a recipient that bypasses
  permission prompts holds messages from senders that do not, and drops a
  default-held message after `dialogExpiry`, five minutes by default. `accept`
  delivers, `hold` holds without expiry and `refuse` drops. A recipient holds at
  most 100 messages. Reaching another machine or a cloud session needs Remote
  Control and a claude.ai sign-in, and a message to an offline Remote Control
  session arrives when it reconnects. Sessions in WSL 2 and on native Windows
  cannot reach each other, and neither can a container and its host.
- **Receipts (documented).** The sender sees a "Not sent" result for a refused
  send, and is told when a message to a `-p` session expires. `notify_when_idle`
  returns one notice when a local session next goes idle or exits, needs 2.1.236
  in both sessions and expires after 12 hours. There is no read or
  acknowledgement receipt.
- **Hooks and mods (documented).** Hooks can add context at `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and other events. A
  command hook with `asyncRewake` that exits with code 2 wakes an idle session.
  A mod can send with `$.session.send`, observe incoming peer messages with
  `session.receive` and start a turn with `$.prompt.submit`.
- **Roster (documented).** `/list-agents`, also `/peers`, shows session names
  and, unless Remote Control is connected, working directories. The `claude
  agents` screen shows background sessions, and a session open in another
  terminal appears there after `/bg`. `claude agents --json` lists every live
  session with `cwd`, `kind`, `name` and `sessionId`. None of these shows a
  branch.
- **Isolation (documented).** `--worktree` blocks edits to the main checkout
  from an isolated session. Agent teams are experimental and off by default,
  and a session has one team that other sessions cannot join.
- **Socket access (documented).** The documentation says other sessions
  deliver to a session's socket. It describes the wire format only as far as the
  authentication line, and does not document the message format. Swarmail does
  not use the socket.
- **What Swarmail does here.** The Swarmail mod long-polls the Swarmail server
  and starts a turn with `$.prompt.submit`. It does not touch native
  messaging, so the two do not interfere. A session ends up with a Claude Code
  name (`/rename`) and a Swarmail name (such as `BlueLake`). The tag in the
  Swarmail registration links the two.

## Codex CLI

- **`codex queue` (documented since 0.149.0, tested on 0.162.1).**
  `codex queue --thread <id or exact name> --message <text>` queues a text
  message through the experimental `thread/queue/add` app-server method. The
  release notes say queued messages wake idle sessions.
  - An idle terminal session on the daemon started a turn in about 6 seconds,
    as an ordinary user turn.
  - A session in the middle of a 40-second command was not interrupted. It ran
    the queued messages in order after the command finished.
  - With the terminal closed, the daemon still held the thread and ran the
    message in about 2 seconds.
  - With the daemon stopped and nothing loaded, the command stored the message,
    and `codex resume` delivered it on load.
  - One call out of four failed while a turn was starting, with "cannot queue
    through an embedded app server while a local app-server daemon is running".
    Retrying worked. The source raises that error when attaching to the daemon
    fell back to an embedded server while the daemon socket still answers.
- **Task tools (documented since 0.150.0, tested on 0.162.1).** A terminal
  session has `codex_tui` tools to list, read, wait for, create, fork, message,
  rename and archive other tasks. `send_message_to_thread` delivered to another
  session, which showed "Sent by Codex from task …" before answering. Creating,
  forking and messaging a thread each ask for approval. A message is limited to
  1,000 UTF-8 bytes. The tools exist only in a terminal session connected to an
  external app server, normally the shared daemon. Plain `codex` attaches to the
  daemon by default for eligible interactive launches since 0.157.0, and a plain
  `codex` session started its own daemon in the test. It falls back to an
  embedded server, without the task tools, with `--no-daemon` or when attaching
  fails. `codex exec` runs an embedded server and does not have them.
- **Other apps (documented).** T3 Code spawns its own `codex app-server` child process over
  stdio, one per Codex provider instance and shared by that instance's threads.
  It is not the daemon that terminal `codex` sessions use, so the task tools do
  not apply to Codex threads inside T3 Code. Whether a terminal `codex queue`
  reaches them was not tested.
- **Not provided (documented).** No cross-session inbox, message threading,
  search, read receipt or priority. Each thread has an experimental queue API
  (`thread/queue/*`) that lists, edits and reorders its queued messages. Hooks
  can add context, and a `Stop` hook can continue the session with a new
  continuation prompt, but no documented hook output wakes an idle session or
  messages another session. `codex agents` is a dashboard of sessions on the
  daemon, with no grouping by repository or branch. `codex app-server` and the
  daemon are marked experimental. Both commands appear in `codex --help` and the
  release notes, but not on the CLI reference page.
- **What Swarmail does here.** The opt-in `codex-queue` bridge talks to the same
  app-server API: `thread/queue/add`, or `turn/start` when steering. It adds a
  stable command ID that correlates each notice with Codex's admission of it
  (Codex can run a resent ID twice, so the bridge never resends an uncertain
  one), a read-back check that Codex admitted the message, and one outstanding
  notice per session. It is the right path for Swarmail mail
  that should wake a Codex session. Messages between Codex sessions do not need
  Swarmail.

## Cursor

- **Messaging (documented).** None between independent sessions. Subagents
  return to their parent, and a Projects coordinator manages agents it starts.
  The Cloud Agents API and SDK send follow-ups to cloud or SDK-owned agents.
  `run.steer()` works on local SDK runs, and on cloud runs and detached handles
  it falls back to a follow-up. In the CLI, pressing Enter while the agent works
  steers the run. Remote control for local agents (6 October 2026) lets a
  person message a local agent from the Cursor iOS app, and no API is
  documented.
- **Hooks (tested in `cursor-agent -p`, 2026.10.01).** Output from a project
  `postToolUse` hook and a `sessionStart` hook, returned as `additional_context`,
  reached the model. With no hooks the model reported none. The IDE and SDK were
  not tested.
- **Stop hook (documented, and tested in the interactive `cursor-agent`
  2026.10.01).** `followup_message` submits a next message, capped by
  `loop_limit`, which defaults to 5; `null` removes the cap. In the test, a
  session with Swarmail's stop hook woke for each of five mails sent one after
  another, then did not wake for a sixth within three minutes, and no wake hook
  was left running. After a prompt typed into the session, its stop hook
  delivered the waiting sixth mail, and a seventh woke the session again.
  Swarmail's installer leaves `loop_limit` at its default on purpose, so two
  agents cannot wake each other without end. A session that receives more than
  five mails with no prompt from a person in between sees the rest at the next
  prompt.
- **What Swarmail does here.** A wake hook after each turn, and context after
  tool calls. It wakes an idle Cursor CLI session up to five times between
  prompts.

## Devin

- **Messaging (documented).** No channel lets another independent session
  message a local CLI session. A client that launches `devin acp` can drive the
  session it launched. The v3 API sends a message to a cloud session and resumes
  it if suspended, and needs the `ManageOrgSessions` permission. A coordinator
  Devin can message its child sessions. CLI subagents report to their parent,
  which can resume a finished one with a new prompt.
- **Hooks (documented).** `UserPromptSubmit`, `SessionStart` and `PostToolUse`
  accept `additionalContext`. A `Stop` hook can block to keep the agent going.
- **What Swarmail does here.** Context after tool calls (`PostToolUse`), and a
  continue at `Stop` when mail is already waiting.

## Antigravity

- **`send_message` (tested on agy 1.3.3).** A separate `agy -p` process sent
  `send_message` to an interactive CLI conversation it had no parent link to,
  addressed by conversation ID. The sender was told "Message sent". The
  recipient did nothing for about 45 seconds. Its next turn started with the
  message in context, with the sender's conversation ID, a timestamp and
  `MESSAGE_PRIORITY_HIGH`. The documented arguments are recipient and message,
  so Antigravity set the priority label. Delivery to a recipient in the middle
  of a turn was not tested. The CLI changelog (1.1.13) mentions sessions
  "woken by background tasks, subagents or agent messages", so some sessions do
  wake. The documentation for messaging peers is on the Antigravity 2.0 tab, not
  the CLI tab.
- **`agentapi send-message` (tested).** From a plain terminal it fails with
  "ANTIGRAVITY_LS_ADDRESS is not set". The documentation does not say where the
  variable is set. The documentation lists the command for Antigravity 2.0
  sidecars, and it also exists in the agy 1.3.3 CLI, though not in `agy --help`.
- **Hooks (documented).** `PreInvocation` and `PostInvocation` can inject steps,
  including a user message. `PostToolUse` cannot inject. `Stop` can continue.
- **What Swarmail does here.** A `PreInvocation` user message when mail is
  waiting, and a continue at `Stop`. It cannot wake an idle session.

## OpenCode

All statements here are documented. None were tested.

- **Messaging.** None between independent sessions. `POST /api/session/{id}/prompt`
  durably admits input with `delivery` set to `steer`, the default, or `queue`,
  and `GET /api/session/{id}/inbox` lists work not yet delivered. The
  `opencode run --session` command, `opencode api`, the plugin call
  `ctx.session.prompt` and the `@opencode/client` package can also send into an
  existing session. The API reference describes itself as an "Experimental
  HttpApi surface for selected instance routes" and labels the session routes
  "Experimental session routes".
- **Version.** 2.0.26 is the npm `latest` of `@opencode/cli`. The `opencode-ai`
  package is still at 1.19.0. GitHub releases carry only 1.x, with the latest
  being v1.19.0, published 2026-10-11.
- **Sessions.** By default one shared background service owns every local
  session, and `--standalone` gives a private server. T3 Code starts its own
  `opencode serve` by default, so its sessions are not on the shared service. It
  can instead be pointed at an existing server URL.
- **What Swarmail does here.** The opt-in `opencode-v2-queue` bridge posts to the
  prompt API of an OpenCode 2 HTTP server, given by loopback URL, with steering.
  The endpoint and the `delivery` field exist in 2.x only.

## Grok Build

All statements here are documented. None were tested.

- **Messaging.** None between independent sessions. `send_subagent_message` is
  off by default and works between a session's own agents (shipped guide
  `16-subagents.md`). The dashboard lets a person reply to a session. It is not
  a channel an agent can call.
- **Shared backends.** Leader mode, which is off by default, lets more than one
  client share a backend. `grok agent serve` (ACP over WebSocket) keeps state
  across client reconnects. The documentation gives no recipe for one session to
  message another. The `x.ai/interject` method that Swarmail's bridge calls
  exists in the
  [public source](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/interject.rs)
  but not in the user documentation, so Grok can change it without notice.
- **What Swarmail does here.** The opt-in `grok-queue` bridge connects to the
  leader socket and uses that extension. It needs the session to run with leader
  mode, which is refused while a sandbox profile is active, and it works only on
  Unix.

## T3 Code

- **Messaging (documented).** `t3_thread_send` reaches any thread in the
  environment with `auto`, `queue`, `steer` or `restart`. The target's runtime
  and interaction modes may not be broader than the caller's, and a thread
  caller must be in a live run. `t3_thread_read` and `t3_thread_wait` read or
  wait on other threads, and `t3_thread_list` and `t3_thread_search` cover one
  project unless `projectId` is given. The queue tools cancel, edit, reorder and
  promote queued runs. Outside agents that support OAuth, such as Claude Code
  and Codex in a terminal, can use these tools through an MCP sign-in. Read only
  is the default, and Supervised or above can message threads.
- **Not provided (documented).** No per-message read or acknowledgement receipt
  and no priority. The sender gets a message ID, a run ID and a delivery
  outcome. Search is bounded and has no exhaustive-result guarantee. The
  documentation describes no way for a thread to message a plain terminal
  session.
- **What Swarmail does here.** Between T3 threads, the T3 tools are enough.
  Swarmail mail to a T3 thread, from any sender, wakes it only through the
  opt-in T3 bridge. The optional lifecycle reader stops wakes to settled,
  archived or deleted threads.

## Not tested

- Codex sessions hosted inside T3 Code, reached from a terminal `codex queue`.
- How long a Codex daemon keeps a closed thread loaded.
- Antigravity delivery to a recipient in the middle of a turn.
- Cursor in the IDE and through the SDK.
- Everything under OpenCode and Grok Build.

## Sources

- Claude Code: [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
  [hooks](https://code.claude.com/docs/en/hooks),
  [mods API](https://code.claude.com/docs/en/plugins/mods/api),
  [agent view](https://code.claude.com/docs/en/agent-view),
  [worktrees](https://code.claude.com/docs/en/worktrees),
  [agent teams](https://code.claude.com/docs/en/agent-teams)
- Codex: release notes for
  [0.149.0](https://github.com/openai/codex/releases/tag/rust-v0.149.0),
  [0.150.0](https://github.com/openai/codex/releases/tag/rust-v0.150.0) and
  [0.157.0](https://github.com/openai/codex/releases/tag/rust-v0.157.0), and the
  [source at 0.162.1](https://github.com/openai/codex/tree/rust-v0.162.1)
- Cursor: [hooks](https://cursor.com/docs/hooks),
  [subagents](https://cursor.com/docs/subagents),
  [Projects](https://cursor.com/docs/agent/projects),
  [remote control for local agents](https://cursor.com/changelog/remote-control-local-agents)
- Devin: [hooks](https://docs.devin.ai/cli/extensibility/hooks/overview),
  [send a message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages)
- Antigravity: [subagents](https://antigravity.google/docs/subagents),
  [hooks](https://antigravity.google/docs/hooks),
  [sidecars](https://antigravity.google/docs/sidecars), and `agy changelog`
- OpenCode: [API](https://opencode.ai/v2/docs/api),
  [releases](https://github.com/anomalyco/opencode/releases)
- Grok Build: the user guide shipped with 1.0.50 in `~/.grok/docs/user-guide`,
  which is newer than the hosted [docs](https://docs.x.ai/build)
- T3 Code:
  [orchestrator tools](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md),
  [outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
