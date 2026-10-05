<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="Swarmail" width="100%">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/bompus/swarmail/actions/workflows/ci.yml"><img src="https://github.com/bompus/swarmail/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/bompus/swarmail/releases/latest"><img src="https://img.shields.io/github/v/release/bompus/swarmail" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bompus/swarmail" alt="MIT license"></a>
  <a href="https://glama.ai/mcp/servers/bompus/swarmail"><img src="https://glama.ai/mcp/servers/bompus/swarmail/badges/score.svg" alt="Swarmail on Glama"></a>
</p>

Swarmail lets coding-agent sessions on one machine send each other mail. Each
repository gets a roster of named agents, a threaded inbox with full-text
search, and advisory file reservations. Agents reach it as an MCP server, and
you reach it with the `swarmail` command.

It is one Bun binary with a SQLite database, listening on `127.0.0.1:18765`.
There are no runtime dependencies.

Hosts it configures: Claude Code, Codex, Cursor, Grok, Antigravity, Devin and
OpenCode. Claude Code and Cursor sessions can also wake up when mail arrives.

<p align="center"><img src="docs/assets/demo.gif" alt="Claude Code and Cursor sessions on one repository. The person asks Claude Code to hand the README install section to the other agent. Claude Code mails the Cursor session, which wakes, makes the edit and replies. Claude Code wakes on the reply and checks the change." width="100%"></p>

If you are an AI agent reading this for your user, the prompt under
[Evaluate it with your agent](#evaluate-it-with-your-agent) is the evaluation
they would ask for. Summarize how it fits their setup and let them choose;
don't install or configure anything on your own.

## Evaluate it with your agent

Paste this into a session with the agent you use. It checks whether Swarmail
fits how you run agents and changes nothing until you choose.

```text
I'm considering Swarmail (https://github.com/bompus/swarmail), local mail
between coding-agent sessions on one machine, served over MCP. Read its
README and docs/usage.md, then look at how I run agents here: which hosts I
use, their MCP and hook settings, and my OS. Tell me:
1. Whether I run several agent sessions on this machine at once, and where
   they could step on each other (shared checkouts, branches, services).
2. Whether my hosts support MCP and hooks, and whether this is Linux with
   systemd, Windows, or something that needs the manual `swarmail serve`
   route.
3. What installing it would change: the files the install scripts write,
   the user service, and the hooks each host would run.
4. Whether to install it, or only borrow ideas such as wake-on-mail or
   advisory file reservations.
For rules that tell agents when to send mail, also look at house-rules
(https://github.com/bompus/house-rules) and its opt-in swarmail modifier.
Read only: don't install, configure or edit anything until I choose. When I
adopt an idea from it, add a one-line credit beside it, such as
"Adapted from Swarmail (https://github.com/bompus/swarmail)".
```

Taking individual ideas is welcome. If you adopt any, we'd appreciate a
credit line linking to this repository. Copying substantial code or text also
needs the MIT notice kept (see `LICENSE`).

## Install

Requires [Bun](https://bun.sh) 1.4.2 or newer on Linux with systemd or on
Windows 10 or 11. WSL 2 with systemd enabled counts as Linux, and step 3 can
register Windows-side hosts against the server running in WSL. Run Swarmail
either in WSL or natively on Windows, not both: both servers use port 18765,
which mirrored WSL networking shares with Windows. macOS is not supported
yet.

Native Windows is a preview. The test suite runs on Windows in CI, and the
hooks have been run through Git Bash, PowerShell 5.1, pwsh 7, cmd and
Cursor's PowerShell form against a real server. On Windows 11, headless
`claude -p` and `cursor-agent -p` sessions have registered through the
hooks and used the MCP tools. An idle interactive Claude Code session on
Windows 11 woke when mail arrived and replied with no prompt, with its hooks
talking to a server that ran in WSL. Not yet verified on Windows: that wake
against a server running natively on Windows, Cursor waking on mail, and the
logon task starting a server at a real logon. If something fails there,
please open an issue.

1. Clone and install the dev tools:

   ```bash
   git clone https://github.com/bompus/swarmail.git
   cd swarmail
   bun install
   ```

2. Build `~/.local/bin/swarmail` and start the `swarmail.service` user unit:

   ```bash
   scripts/enable.sh
   ```

   On Windows, build `~\.local\bin\swarmail.exe` and start the server in a
   scheduled task named `Swarmail`, which runs it hidden at each logon and
   needs no administrator:

   ```powershell
   bun scripts/enable-windows.ts
   ```

   Rerun either script after pulling; it stops the running server and starts
   the new build.

   The database is `~/.local/share/swarmail/mail.sqlite3`. The server has no
   authentication. It accepts only local connections and rejects non-local
   `Origin` headers, so never expose the port.

3. Register the server as `swarmail` in each supported host installed under
   your home directory. A host counts as installed when its config file or
   config directory exists; others are skipped. Add `--dry-run` to preview
   the edits:

   ```bash
   bun scripts/configure-mcp.ts
   ```

   On WSL, `--windows-home[=DIR]` registers the Windows-side hosts against
   the same server.

   An MCP client that installs servers from a registry, or speaks only stdio,
   can run `npx -y swarmail-mcp` instead. That
   [relay](packages/mcp-relay/README.md) forwards each request to the server
   from step 2 and installs nothing itself.

4. Install the hooks: the register hook for every installed host, the wake
   hook for Claude Code and Cursor, and the Swarmail mod for Claude Code. A
   host counts as installed when its config directory exists. Add `--dry-run`
   to preview the edits. With `--no-claude-mod`, new Claude Code sessions don't
   load the mod (one installed before included) and use the wake hook.

   ```bash
   bun scripts/configure-hooks.ts
   ```

   Codex skips a hook it hasn't trusted, so trust the register hook once in
   Codex's `/hooks`.

   On Windows, hosts run each hook through Git Bash, PowerShell or cmd, so
   the hooks name the binary as one unquoted path with forward slashes. If
   your profile path has a space or a non-ASCII letter, the hooks use its 8.3
   short name, and the installer stops with an error on a volume that has
   short names turned off. Cursor passes hook input through Windows
   PowerShell 5.1, which turns non-ASCII characters into `?`, so a repository
   path with such characters reaches the Cursor register hook mangled.

5. Optional: `bun scripts/install-guard.ts [repo...]` refuses a commit or push
   that touches another agent's exclusive reservation. It installs into
   `hooks.d/pre-commit/` and `hooks.d/pre-push/` under the repository's
   hooks directory, so it needs a `pre-commit` and `pre-push` hook that run
   every script in those directories.

Start a new agent session and edit a file in a repository. The register hook
gives the session a name such as `BlueLake`. Run `swarmail who` in that
repository to see it.

## How agents use it

Agents call the MCP tools: `macro_start_session` to register and read the
inbox in one call, then `send_message`, `reply_message`, `fetch_inbox`,
`acknowledge_message`, `search_messages` and `file_reservation_paths`, among
others. [docs/usage.md](docs/usage.md) has the conventions worth putting in
your agent rules.

Each repository is one project, keyed by its primary checkout. A path inside
a worktree or subdirectory maps to that checkout, so sessions in different
worktrees of one repository share a roster and can mail each other. A session
keeps one name across repositories.

## Commands

| Command | What it does |
| --- | --- |
| `swarmail serve` | Run the server |
| `swarmail who [repo]` | Agent names, session titles and edit checkouts, live sessions first |
| `swarmail inbox`, `send`, `search` | Read, send or search mail as this session |
| `swarmail thread <id>` | One thread's messages, oldest first |
| `swarmail ping <agent>` | Exit 0 if that agent's wake hook is waiting |
| `swarmail register` | The register hook; `--tag` prints the tag for a manual registration |
| `swarmail hook wake <host>` | The Claude Code and Cursor wake hook |
| `swarmail hook rearm` | The Claude Code re-arm on Windows, which has no POSIX shell to run the Linux one |
| `swarmail guard` | The git guard |
| `swarmail version` | The source hash the binary was built from |

`swarmail --help` lists every subcommand and flag. A `--help` or `-h`
anywhere prints usage and runs nothing.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `SWARMAIL_DB` | `~/.local/share/swarmail/mail.sqlite3` | Database path |
| `SWARMAIL_PORT` | `18765` | Server port |
| `SWARMAIL_URL` | `http://127.0.0.1:18765/mcp/` | MCP endpoint for the command, the register hook and the `swarmail-mcp` relay |
| `SWARMAIL_WAKE_URL` | `http://127.0.0.1:18765` | Server base URL for the wake hook |
| `SWARMAIL_SYNCHRONOUS` | `normal` | `full` syncs every commit, at about 3 ms per send instead of 0.5 ms |
| `SWARMAIL_RETIRE_DAYS` | `7` | Retire idle agents and drop projects whose checkout is gone; `0` keeps both |
| `SWARMAIL_GUARD` | `block` | `warn` only reports, `off` skips |
| `SWARMAIL_AGENT` | from hook state | Name used by `inbox`, `send`, `ping`, `guard` and `who` |
| `SWARMAIL_LIVE_ROOM` | unset | A JSON heartbeat file (`heartbeatAt`, plus `agentName`, `hostSessionId` or `t3Thread`); while its heartbeat is under 5 minutes old, `who` flags the session it names |

`scripts/enable.sh`, `scripts/enable-windows.ts`, the service unit and
`configure-mcp.ts` use port 18765. Change `SWARMAIL_PORT` and the two URL
variables only when you run `swarmail serve` yourself, and set them for every
host that runs the hooks. On Windows the scheduled task reads them from your
user environment (`setx SWARMAIL_PORT 18865`) at the next logon.

On Windows, `Stop-ScheduledTask Swarmail` ends only the task's console
host, and the server keeps running. To stop the server for good, run
`Unregister-ScheduledTask Swarmail` and end `swarmail.exe` in Task Manager.

With `normal`, a power loss can lose the most recent writes. A retired agent
comes back when it registers again or sends, reads mail or reserves files as
itself.

## Register hook

On a session's first edit in a repository, `swarmail register` registers it
under the repository's primary checkout. Claude Code and Cursor also run it
when a session starts. It registers the session under its working directory's
repository and tells the agent its name, so the agent uses that name instead of
registering a second one. The registration starts with a tag
holding the host's session id and working directory, which is how `swarmail
who` matches names to sessions. A failure is retried on the next prompt or edit. State
lives in `~/.local/state/swarmail-register/`, under your profile on Windows.
After upgrading, run `bun scripts/configure-hooks.ts` again to add the
session-start hook.

| Host | Session id in the shell |
| --- | --- |
| Claude Code | `$CLAUDE_CODE_SESSION_ID` |
| Codex | `$CODEX_THREAD_ID` |
| Cursor | `$CURSOR_CONVERSATION_ID` |
| OpenCode, Devin | none; their hooks carry it |

## Waking sessions

Claude Code sessions wake through the Swarmail mod (`src/claude-wake-mod.js`),
which waits for mail for as long as the session runs. The installer copies it to
`~/.local/share/swarmail/claude-plugin` and adds that directory to
`env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, so every Claude
Code session loads it, including ones an app starts through the Agent SDK.
When mail arrives at an idle session, the mod starts a turn with a one-line
hint naming the recipient and sender, urgent mail first. During a turn the
hint goes with the next tool result, or starts the next turn if the turn ends
first. The mod sets `SWARMAIL_WAKE_MOD=1`, and the wake hooks exit at once
where they see it. It was tested with Claude Code 2.1.288. A Claude Code
without mods never sets the variable, so the hooks keep waking it.

Cursor, and Claude Code without the mod, wake through the wake hook, which
long-polls the server after each turn: about 23 days in Claude Code, 8 hours
in Cursor. When mail arrives, it starts a new turn with the hint. In Claude
Code the wait also re-arms after each tool call, so a hint can join a running
turn. The server answers `swarmail ping` itself, so a ping never wakes the
model. Sessions on other hosts see mail on their next `fetch_inbox`.

## Feature comparison

These are the six servers measured below. Features describe the pinned source
versions in the [detailed comparison](docs/benchmarks.md#features), which also
covers runtimes, platforms, licences and two additional servers.

| Server | Roster scope | Search | Threads and receipts | File reservations | Wakes an idle session |
| --- | --- | --- | --- | --- | --- |
| Swarmail | Per repository; worktrees share it | Full text (FTS5) | Threads; read, acknowledged and delivery receipts | Advisory, with a git guard | Claude Code and Cursor |
| [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/tree/21a25c2bcfd20c9b31bcb109c294d17411eb5ba1) | Per project path | Full text (Tantivy) | Threads; read, acknowledged and delivery receipts | Advisory, with a git guard | No; Claude Code hooks check the inbox during a turn |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail/tree/3fad5ec672869f81d2ca0a4c525dde004ac96f45) | Per project path | Full text (FTS5) | Threads; read and acknowledged | Advisory, with a git guard that is off by default | No; Claude Code, Codex and Factory hooks check the inbox during a turn |
| [agent-inbox](https://github.com/salimfadhley/agent-inbox/tree/a86647c2d61265e9a12fbc9ea0826a27712492cb) | One per hub | Substring, at most 25 results | Threads; read state | None | Claude Code (opt-in hook), opencode, omp |
| [agentbus](https://github.com/oznotes/AgentCommBus/tree/225a57c91180421bf2d698328a57f488f18bd820) | One per server | None | No threads; reading moves a cursor | None | No; an agent waits in `recv` for up to 600 s |
| [Project Relay](https://github.com/MuhammadFarhantahirvoltic/project-relay/tree/36d9a0765e4469f667c2e09fafe745166493fa86) | Per project | None | Replies; acknowledged per recipient | Advisory leases | No; an inbox read waits for up to 25 s |

An inbox read that waits for mail needs an agent already running. It does not
wake an idle session.

## Performance

Measured on one machine with one small workload (40 agents, 250 seed messages,
1,560 messages by the end), each server started on empty storage. Startup is
hyperfine's mean of 20 runs; every other number is the median of three rounds,
with latency from Tinybench and requests per second from oha. [docs/benchmarks.md](docs/benchmarks.md) has
the method, a sixth server, each tool's raw output and a feature comparison
with seven other local agent-mail servers.

<a href="docs/assets/benchmark-light.png"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-dark.png">
  <img src="docs/assets/benchmark-light.png" alt="Bar charts sorted from best to worst for each metric. Send p50: Swarmail 0.46 ms, agentbus 2.3 ms, Project Relay 2.5 ms, Rust Agent Mail 39 ms, Python Agent Mail 70 ms. Search p50: Swarmail 0.65 ms, Python Agent Mail 12 ms, Rust Agent Mail 56 ms; agentbus and Project Relay have no search tool. Startup: Swarmail 38 ms, Project Relay 123 ms, agentbus 408 ms, Python Agent Mail 0.86 s, Rust Agent Mail 1.5 s. Idle memory: Swarmail 32 MiB, agentbus 81 MiB, Project Relay 121 MiB, Python Agent Mail 154 MiB, Rust Agent Mail 190 MiB." width="100%">
</picture></a>

Each chart ranks its metric from best to worst. Lower values are better in
all four charts. The tables below put servers in rows and units in headings.
Rust Agent Mail and Python Agent Mail are
`mcp_agent_mail_rust` and `mcp_agent_mail`.

### Latency

Median latency in milliseconds; lower is better. Rows are sorted by send
latency. Search has a different ranking. A dash means no search tool.

| Server | Send ↓ | Inbox ↓ | Search ↓ |
| :--- | ---: | ---: | ---: |
| **Swarmail** | **0.46** | **0.50** | **0.65** |
| agentbus | 2.3 | 1.1 | — |
| Project Relay | 2.5 | 1.4 | — |
| Rust Agent Mail | 39 | 12 | 56 |
| Python Agent Mail | 70 | 23 | 12 |

### Throughput

Requests per second with eight clients; higher is better. Rows are sorted by
send throughput. Search has a different ranking.

| Server | Send ↑ | Inbox ↑ | Search ↑ |
| :--- | ---: | ---: | ---: |
| **Swarmail** | **5,500** | **6,300** | **4,300** |
| agentbus | 876 | 1,600 | — |
| Project Relay | 482 | 1,100 | — |
| Rust Agent Mail | 50 | 416 | 90 |
| Python Agent Mail | 9.7 | 27 | 44 |

### Memory

Resident memory in MiB; lower is better. Rows are sorted by idle memory.
Peak memory has a different ranking.

| Server | Idle ↓ | Peak under load ↓ |
| :--- | ---: | ---: |
| **Swarmail** | **32** | **67** |
| agentbus | 81 | 96 |
| Project Relay | 121 | 296 |
| Python Agent Mail | 154 | 258 |
| Rust Agent Mail | 190 | 688 |

CPU usage, seed-loading times and the full ratios are in the
[detailed results](docs/benchmarks.md#summary).

### Startup

Mean startup time in milliseconds across 20 hyperfine runs; lower is better.
Rows are sorted by mean time. Each run starts the server, waits for its health
check, then stops it.

| Server | Mean ± SD ↓ | Min | Max |
| :--- | ---: | ---: | ---: |
| **Swarmail** | **37.7 ± 0.7** | **37.1** | **39.3** |
| Project Relay | 122.9 ± 5.3 | 113.8 | 132.7 |
| agent-inbox* | 263.0 ± 11.4 | 252.0 | 297.9 |
| agentbus | 408.2 ± 15.6 | 385.1 | 443.3 |
| Python Agent Mail | 857.7 ± 38.7 | 803.5 | 925.7 |
| Rust Agent Mail | 1530.3 ± 14.9 | 1509.6 | 1562.8 |

The harness without a server takes 7.2 ± 0.6 ms (min 6.6, max 8.5).
Hyperfine's raw `Relative` column compares against that harness, not Swarmail;
see the [startup output](docs/benchmarks.md#startup-hyperfine).

\* agent-inbox appears only in startup here. Its inbox pages hold 50 messages
instead of 20, its roster is global and its search matches substrings, so its
fetch, list and search do different work. The
[detailed comparison](docs/benchmarks.md) has its full column.

mcp_agent_mail commits each send to a Git archive before it returns, so these
numbers don't compare durability. Requests per second varied by up to 29%
between rounds of the same server.

## Development

```bash
bun install
bun test
bun run check   # format, lint and type check
```

`bun scripts/build.ts --if-stale` rebuilds the binary only when a source file
or the Bun version changed. Restart the unit to load a new build.

## Sponsoring

Swarmail is built and maintained by one person. If it saves you time, you can
sponsor it monthly or once through
[GitHub Sponsors](https://github.com/sponsors/bompus), or leave a tip on
[Ko-fi](https://ko-fi.com/bompus).

## Licence

MIT. `CODE_OF_CONDUCT.md` is the Contributor Covenant under CC BY 4.0; see
`THIRD_PARTY_NOTICES.md`. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).
