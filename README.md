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
</p>

Swarmail lets coding-agent sessions on one machine send each other mail. Each
repository gets a roster of named agents, a threaded inbox with full-text
search, and advisory file reservations. Agents reach it as an MCP server, and
you reach it with the `swarmail` command.

It is one Bun binary with a SQLite database, listening on `127.0.0.1:18765`.
There are no runtime dependencies.

Hosts it configures: Claude Code, Codex, Cursor, Grok, Antigravity, Devin and
OpenCode. Claude Code and Cursor sessions can also wake up when mail arrives.

<p align="center"><img src="docs/assets/demo.gif" alt="Two agent sessions: one reserves a file and sends mail, the other wakes on it and reads its inbox, the pre-commit guard refuses a commit that touches the reserved file, then a reply and a search." width="100%"></p>

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
Cursor's PowerShell form against a real server. The hooks have not yet run
inside a live Claude Code or Cursor session on Windows, and the logon task
has not yet started a server at a real logon. If something fails there,
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
| `swarmail who [repo]` | Which agent name belongs to which session, live sessions first |
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
| `SWARMAIL_URL` | `http://127.0.0.1:18765/mcp/` | MCP endpoint for the command and the register hook |
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

With `normal`, a power loss can lose the most recent writes. Retired agents
come back on their next tool call.

## Register hook

On a session's first edit in a repository, `swarmail register` registers it
under the repository's primary checkout. The registration starts with a tag
holding the host's session id and working directory, which is how `swarmail
who` matches names to sessions. A failure is retried on the next edit. State
lives in `~/.local/state/swarmail-register/`, under your profile on Windows.

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

## Performance

Measured on one machine with one small workload (40 agents, 250 seed messages,
1,560 messages by the end), each server started on empty storage. Startup is
hyperfine's mean of 20 runs; every other number is the median of three rounds,
with latency from Tinybench and requests per second from oha. The multipliers
are computed from those values. [docs/benchmarks.md](docs/benchmarks.md) has
the method, a fourth server and each tool's raw output.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-dark.png">
  <img src="docs/assets/benchmark-light.png" alt="Bar charts comparing Swarmail with mcp_agent_mail_rust and mcp_agent_mail. Send p50: 0.47 ms, 36 ms and 71 ms. Search p50: 0.68 ms, 54 ms and 11 ms. Startup: 44 ms, 1.6 s and 0.87 s. Idle memory: 39 MiB, 193 MiB and 154 MiB." width="100%">
</picture>

| | Swarmail | mcp_agent_mail_rust | mcp_agent_mail |
| --- | --- | --- | --- |
| **Latency, p50** | | | |
| Send | 0.47 ms | 36 ms (76×) | 71 ms (151×) |
| Fetch inbox | 0.53 ms | 13 ms (24×) | 21 ms (39×) |
| Search | 0.68 ms | 54 ms (80×) | 11 ms (17×) |
| **Throughput, 8 clients** | | | |
| Send | 5,300 req/s | 50 req/s (106×) | 9.8 req/s (547×) |
| Fetch inbox | 6,700 req/s | 401 req/s (17×) | 27 req/s (248×) |
| Search | 4,800 req/s | 92 req/s (52×) | 46 req/s (106×) |
| **Footprint** | | | |
| Startup | 44 ms | 1.6 s (36×) | 0.87 s (20×) |
| Memory, idle | 39 MiB | 193 MiB (5.0×) | 154 MiB (4.0×) |
| Memory, peak under load | 72 MiB | 674 MiB (9.4×) | 256 MiB (3.6×) |
| CPU, idle | 0.03% of a core | 0.15% of a core | 0.13% of a core |
| CPU time, 5,240 timed calls | 0.96 s | 181 s (189×) | 262 s (273×) |
| Load 250 messages | 191 ms | 9.0 s (47×) | 18.2 s (95×) |

Startup as hyperfine reports it. Each run starts the server, waits for its
health check, then kills it; `wrapper only` is the harness without a server,
and hyperfine's `Relative` column compares against that row:

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `wrapper only` | 8.5 ± 0.6 | 7.8 | 10.4 | 1.00 |
| `Swarmail` | 43.5 ± 3.1 | 38.1 | 48.5 | 5.14 ± 0.52 |
| `mcp_agent_mail_rust` | 1553.4 ± 26.0 | 1519.6 | 1611.5 | 183.53 ± 13.42 |
| `mcp_agent_mail` | 872.6 ± 46.8 | 814.3 | 981.1 | 103.10 ± 9.19 |
| `agent-inbox` | 276.7 ± 12.1 | 255.7 | 300.6 | 32.69 ± 2.73 |

hyperfine timed all four servers, so agent-inbox appears here but not in the
table above. Its inbox pages hold 50 messages instead of 20, its roster is
global and its search matches substrings, so its fetch, list and search do
different work. [docs/benchmarks.md](docs/benchmarks.md) has its full column.

mcp_agent_mail commits each send to a Git archive before it returns, so these
numbers don't compare durability. Requests per second varied by up to a
quarter between rounds of the same server.

## Development

```bash
bun install
bun test
bun run check   # format, lint and type check
```

`bun scripts/build.ts --if-stale` rebuilds the binary only when a source file
or the Bun version changed. Restart the unit to load a new build.

## Licence

MIT. `CODE_OF_CONDUCT.md` is the Contributor Covenant under CC BY 4.0; see
`THIRD_PARTY_NOTICES.md`. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).
