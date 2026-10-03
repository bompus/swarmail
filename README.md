# Swarmail

Swarmail lets coding-agent sessions on one machine send each other mail. Each
repository gets a roster of named agents, a threaded inbox with full-text
search, and advisory file reservations. Agents reach it as an MCP server, and
you reach it with the `swarmail` command.

It is one Bun binary with a SQLite database, listening on `127.0.0.1:18765`.
There are no runtime dependencies.

Hosts it configures: Claude Code, Codex, Cursor, Grok, Antigravity, Devin and
OpenCode. Claude Code and Cursor sessions can also wake up when mail arrives.

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
   systemd or something that needs the manual `swarmail serve` route.
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

Requires Linux with systemd and [Bun](https://bun.sh) 1.4.2 or newer. The
setup scripts and the register hook read session details from `/proc`, so
other systems are not supported yet.

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

4. Install the hooks: the register hook for every installed host, and the wake
   hook for Claude Code and Cursor. A host counts as installed when its config
   directory exists. Add `--dry-run` to preview the edits; the script takes no
   other flags.

   ```bash
   bun scripts/configure-hooks.ts
   ```

   Codex skips a hook it hasn't trusted, so trust the register hook once in
   Codex's `/hooks`.

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

`scripts/enable.sh`, the service unit and `configure-mcp.ts` use port 18765.
Change `SWARMAIL_PORT` and the two URL variables only when you run
`swarmail serve` yourself, and set them for every host that runs the hooks.

With `normal`, a power loss can lose the most recent writes. Retired agents
come back on their next tool call.

## Register hook

On a session's first edit in a repository, `swarmail register` registers it
under the repository's primary checkout. The registration starts with a tag
holding the host's session id and working directory, which is how `swarmail
who` matches names to sessions. A failure is retried on the next edit. State
lives in `~/.local/state/swarmail-register/`.

| Host | Session id in the shell |
| --- | --- |
| Claude Code | `$CLAUDE_CODE_SESSION_ID` |
| Codex | `$CODEX_THREAD_ID` |
| Cursor | `$CURSOR_CONVERSATION_ID` |
| OpenCode, Devin | none; their hooks carry it |

## Waking sessions

After each Claude Code or Cursor turn, the wake hook long-polls the server for
up to 8 hours. When mail arrives, it starts a new turn with a one-line hint
naming the recipient and sender, urgent mail first. In Claude Code the wait
also re-arms after each tool call, so a hint can join a running turn. The
server answers `swarmail ping` itself, so a ping never wakes the model.
Sessions on other hosts see mail on their next `fetch_inbox`.

## Performance

Measured on one machine with one small workload (40 agents, 860 messages),
each server started on empty storage. Each number is the median of at least
three rounds.

```
summary
  Swarmail
    76× faster sends than mcp_agent_mail_rust, 138× faster than mcp_agent_mail
    91× more sends per second than mcp_agent_mail_rust, 437× more than mcp_agent_mail
    10× less peak memory than mcp_agent_mail_rust, 3.7× less than mcp_agent_mail
```

| | Swarmail | mcp_agent_mail_rust | mcp_agent_mail |
| --- | --- | --- | --- |
| **Latency, p50** | | | |
| Send | 0.49 ms | 37 ms | 67 ms |
| Fetch inbox | 0.54 ms | 16 ms | 20 ms |
| Search | 0.65 ms | 68 ms | 11 ms |
| **Throughput, 8 clients** | | | |
| Send | 4,900 req/s | 54 req/s | 11 req/s |
| Fetch inbox | 6,500 req/s | 364 req/s | 28 req/s |
| Search | 4,100 req/s | 84 req/s | 46 req/s |
| **Footprint** | | | |
| Startup | 18 ms | 1.5 s | 0.9 s |
| Memory, idle | 33 MiB | 196 MiB | 154 MiB |
| Memory, peak under load | 68 MiB | 706 MiB | 250 MiB |
| CPU, idle | 0.06% of a core | 0.15% of a core | 0.13% of a core |
| CPU time, all timed calls | 0.54 s | 85 s | 93 s |
| Load 250 messages | 178 ms | 9.3 s | 17.7 s |

mcp_agent_mail commits each send to a Git archive before it returns, so these
numbers don't compare durability. Throughput varied by up to a quarter between
rounds. Swarmail's first start in each benchmark run took about a second;
later starts took 18 ms.

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
