# Benchmarks

Swarmail compared with three other local agent-mail servers on one machine and
one small workload, measured on 2026-10-04 UTC. hyperfine times startup,
[Tinybench](https://github.com/tinylibs/tinybench) times single-client calls and
[oha](https://github.com/hatoo/oha) sends load from eight clients. The driver
measures memory and CPU from `/proc` and checks every server's answers.

The results cover this workload only. They say nothing about durability after
a crash, large archives or production load.

## Summary

Each cell is the median of three rounds; startup is hyperfine's mean of 20
runs. The multiplier shows how much worse than Swarmail each server did. It
is computed from those medians, and from the hyperfine means for startup.

| | Swarmail | mcp_agent_mail_rust | mcp_agent_mail | agent-inbox* |
| --- | --- | --- | --- | --- |
| Startup to healthy (hyperfine) | 43.5 ms | 1,553 ms (36×) | 873 ms (20×) | 277 ms (6.4×) |
| Ready, timed in-process | 24.7 ms | 1,504 ms (61×) | 995 ms (40×) | 299 ms (12×) |
| Idle memory (RSS) | 38.8 MiB | 193 MiB (5.0×) | 154 MiB (4.0×) | 63.3 MiB (1.6×) |
| Idle CPU | 20 ms/min | 90 ms/min (4.5×) | 80 ms/min (4.0×) | 90 ms/min (4.5×) |
| Load 250 seed messages | 191 ms | 9,013 ms (47×) | 18,189 ms (95×) | 932 ms (4.9×) |
| Send, p50 | 0.471 ms | 35.9 ms (76×) | 71.1 ms (151×) | 2.23 ms (4.7×) |
| Fetch inbox, p50 | 0.531 ms | 12.7 ms (24×) | 20.7 ms (39×) | 3.06 ms (5.8×) |
| List agents, p50 | 0.568 ms | 10.9 ms (19×) | 5.54 ms (9.8×) | 1.25 ms (2.2×) |
| Search, p50 | 0.682 ms | 54.4 ms (80×) | 11.3 ms (17×) | 2.79 ms (4.1×) |
| Send, 8 clients | 5,336 req/s | 50.1 req/s (106×) | 9.75 req/s (547×) | 545 req/s (9.8×) |
| Fetch inbox, 8 clients | 6,710 req/s | 401 req/s (17×) | 27.1 req/s (248×) | 206 req/s (33×) |
| List agents, 8 clients | 7,364 req/s | 546 req/s (13×) | 30.3 req/s (243×) | 860 req/s (8.6×) |
| Search, 8 clients | 4,842 req/s | 92.4 req/s (52×) | 45.7 req/s (106×) | 227 req/s (21×) |
| CPU for 5,240 timed calls | 0.96 s | 181 s (189×) | 262 s (273×) | 14.8 s (15×) |
| Peak memory (RSS) | 71.5 MiB | 674 MiB (9.4×) | 256 MiB (3.6×) | 118 MiB (1.7×) |

\* agent-inbox is only partly comparable. It returns 50-message inbox pages
instead of 20, lists a global roster that includes its own `admin` and `host`
agents, and searches by substring, so its fetch, list and search do different
work.

- mcp_agent_mail commits each send to a Git archive before it returns.
  mcp_agent_mail_rust does its archive and index work in the background, after
  the call returns. These numbers don't compare durability.
- Each server's own health check decides when it is ready.
  mcp_agent_mail_rust and mcp_agent_mail check readiness; Swarmail and
  agent-inbox only check liveness.
- Idle CPU is counted in 10 ms clock ticks, so its multipliers are coarse.
- Requests per second varied by up to a quarter between rounds of the same
  server (Swarmail fetch 6,186 to 7,731), so small differences mean little.

## Features

What each local agent-mail server offers, read on 2026-10-04 from its source
at the commit each server name links to. The benchmark on this page covers the
first four.

| Server | Runtime | Agents connect over | Server process | Storage | Roster | Platforms | Licence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Swarmail ([`eb6c730`](https://github.com/bompus/swarmail/tree/eb6c730)) | One compiled Bun binary | MCP over HTTP, or stdio through `swarmail-mcp` | Required (systemd user service) | SQLite, FTS5 index | Per repository; worktrees share it | Linux with systemd, including WSL 2; Windows preview | MIT |
| [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/tree/21a25c2bcfd20c9b31bcb109c294d17411eb5ba1) | Rust, prebuilt binaries | MCP over stdio or HTTP | Optional | FrankenSQLite, Tantivy index, Git archive | Per project path | Linux, macOS, Windows | MIT with an OpenAI/Anthropic rider |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail/tree/3fad5ec672869f81d2ca0a4c525dde004ac96f45) | Python 3.12+, 31 dependencies | MCP over HTTP or stdio | Optional; its hooks expect one | SQLite, FTS5 index, Git archive | Per project path | Linux, macOS | MIT with an OpenAI/Anthropic rider |
| [agent-inbox](https://github.com/salimfadhley/agent-inbox/tree/a86647c2d61265e9a12fbc9ea0826a27712492cb) | Python 3.14+ | A stdio MCP client per agent that calls the hub's HTTP API | Required (hub) | SQLite | One per hub | Any; declared OS independent | GPL-3.0-or-later |
| [agentbus](https://github.com/oznotes/AgentCommBus/tree/225a57c91180421bf2d698328a57f488f18bd820) | Python 3.11+ | MCP over HTTP, a stdio shim, or REST | Required | SQLite | One per server | Not stated; no OS-specific code | MIT |
| [Project Relay](https://github.com/MuhammadFarhantahirvoltic/project-relay/tree/36d9a0765e4469f667c2e09fafe745166493fa86) | Node 22.13+ | MCP over stdio on a shared SQLite file, or HTTP | Optional | SQLite | Per project | Linux, macOS (CI) | MIT |
| [Agent Wire](https://github.com/kevinmanase/agent-wire/tree/ce9f1f282d9cb07fecd5ebe6767ac7f6ba446330) | Python 3.11+ | A stdio MCP server per agent, talking to a broker over a Unix socket | Required (broker) | SQLite | One per OS user | Linux; macOS not verified | AGPL-3.0-only |
| [Durebak](https://github.com/ggujunhi247/durebak/tree/d0f1f520160d551b3ec218056f50355f26abbe24) | Node 24+ | A stdio MCP bridge to a loopback HTTP server | Required | SQLite | Per workspace | Linux, macOS | Apache-2.0 |

| Server | Sender identity | Threads and receipts | Broadcast | Search | File reservations | Wakes an idle session | For people | MCP tools |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Swarmail | Agent name in each call, not checked; local connections only | Threads; read, acknowledged and delivery receipts | No; cc and bcc | Full text (FTS5) | Advisory, with a git guard | Claude Code and Cursor | CLI | 19 |
| mcp_agent_mail_rust | Agent name; a token is optional, and unverified sends are allowed by default | Threads; read, acknowledged and delivery receipts | Rejected | Full text (Tantivy) | Advisory, with a git guard | No; Claude Code hooks check the inbox during a turn | CLI, web UI, TUI | 45 |
| mcp_agent_mail | Agent name plus that agent's token or a session bound to it | Threads; read and acknowledged | Yes | Full text (FTS5) | Advisory, with a git guard that is off by default | No; Claude Code, Codex and Factory hooks check the inbox during a turn | CLI, web UI | 50 (42 by default) |
| agent-inbox | A header, trusted unless tokens are turned on | Threads; read state | To everyone or a group | Substring, at most 25 results | None | Claude Code (opt-in hook), opencode, omp | CLI, web console | 17 |
| agentbus | A header or argument, not checked | No threads; reading moves a cursor | Yes | None | None | No; an agent waits in `recv` for up to 600 s | CLI, web dashboard | 5 |
| Project Relay | A bearer token per agent | Replies; acknowledged per recipient | Yes | None | Advisory leases | No; an inbox read waits for up to 25 s | CLI | 17 |
| Agent Wire | A bearer handle per session | Replies; acknowledged | No | None | None | Delivers into running Claude Code and Codex sessions | CLI | 7 |
| Durebak | A bearer token per session | Replies and request threads; leased receive with acknowledgement | No | None | None | No | CLI | 39 |

Agent Channel is not listed because its server is a hosted service at
channel.amkentech.com. Only its client is published, as
[agent-channel-client](https://github.com/amkentech/agent-channel-client).

## Servers

| Server | Version | Storage |
| --- | --- | --- |
| Swarmail | [`67e187a`](https://github.com/bompus/swarmail/tree/67e187a6b4beb7319c6ab30466448742297e2a01), compiled with Bun 1.4.2 | SQLite with FTS5 search |
| [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/tree/21a25c2bcfd20c9b31bcb109c294d17411eb5ba1) | upstream main `21a25c2b` (`am 0.3.36`), release profile and release feature flags | FrankenSQLite and Tantivy |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail/tree/3fad5ec672869f81d2ca0a4c525dde004ac96f45) | `3fad5ec`, locked dependencies, Python 3.14.4 | SQLite with FTS5, plus a Git archive |
| [agent-inbox](https://github.com/salimfadhley/agent-inbox) | 1.7.1, direct HTTP interface | SQLite |

The Swarmail binary also carried commands for waking sessions, which the
benchmark does not run.

## Workload

One project with 40 agents. Each server starts on empty storage, loads the same
250 seed messages, and must answer with 40 agents listed, 25 search hits and a
20-message inbox page before anything is timed. The timed operations are:

- **Send.** One message to one recipient.
- **Fetch inbox.** One agent's newest 20 messages.
- **List agents.** The project's roster.
- **Search.** A full-text query with 25 hits.

By the end each store holds 1,560 messages: the 250 seed messages, 310 from
the latency stage and 1,000 from the load stage. The driver counts them after
shutdown.

## Startup: hyperfine

hyperfine 1.19.0, `-N --warmup 3 --runs 20`. Each run starts a server on empty
storage, waits for its health check, kills it and waits until its port is
free. The `wrapper only` row loads the same wrapper and exits without a
server, so it is the wrapper's own cost; every other row includes it. The
`Summary` lines compare against that row, not against Swarmail.

```
Benchmark 1: wrapper only
  Time (mean ± σ):       8.5 ms ±   0.6 ms    [User: 5.4 ms, System: 4.0 ms]
  Range (min … max):     7.8 ms …  10.4 ms    20 runs

Benchmark 2: Swarmail
  Time (mean ± σ):      43.5 ms ±   3.1 ms    [User: 13.5 ms, System: 18.1 ms]
  Range (min … max):    38.1 ms …  48.5 ms    20 runs

Benchmark 3: mcp_agent_mail_rust
  Time (mean ± σ):      1.553 s ±  0.026 s    [User: 0.267 s, System: 0.249 s]
  Range (min … max):    1.520 s …  1.611 s    20 runs

Benchmark 4: mcp_agent_mail
  Time (mean ± σ):     872.6 ms ±  46.8 ms    [User: 745.8 ms, System: 132.0 ms]
  Range (min … max):   814.3 ms … 981.1 ms    20 runs

Benchmark 5: agent-inbox
  Time (mean ± σ):     276.7 ms ±  12.1 ms    [User: 253.8 ms, System: 56.6 ms]
  Range (min … max):   255.7 ms … 300.6 ms    20 runs

Summary
  wrapper only ran
    5.14 ± 0.52 times faster than Swarmail
   32.69 ± 2.73 times faster than agent-inbox
  103.10 ± 9.19 times faster than mcp_agent_mail
  183.53 ± 13.42 times faster than mcp_agent_mail_rust
```

## Latency: Tinybench

Tinybench 6.2.0 in each server's own measurement process, one sequential
client: ten warmup calls, then exactly 300 calls of each operation. Latency is
in nanoseconds. Each table is the round whose send median is the middle of
that server's three, a rule chosen before the run; the summary uses the median
across all three rounds.

Swarmail:

```
┌───┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 567876 ± 3.20%   │ 550165 ± 16096   │ 1799 ± 0.98%           │ 1818 ± 52              │ 300     │
│ 1 │ list      │ 594049 ± 2.45%   │ 577225 ± 23037   │ 1715 ± 1.07%           │ 1732 ± 69              │ 300     │
│ 2 │ search    │ 707463 ± 3.63%   │ 673546 ± 24344   │ 1463 ± 1.32%           │ 1485 ± 54              │ 300     │
│ 3 │ send      │ 564708 ± 12.72%  │ 470560 ± 22867   │ 2069 ± 1.89%           │ 2125 ± 104             │ 300     │
└───┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

mcp_agent_mail_rust:

```
┌───┬───────────┬──────────────────┬────────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns)   │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼────────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 11749297 ± 0.90% │ 11521894 ± 425753  │ 86 ± 0.82%             │ 87 ± 3                 │ 300     │
│ 1 │ list      │ 9927993 ± 1.38%  │ 9533559 ± 572049   │ 102 ± 1.22%            │ 105 ± 7                │ 300     │
│ 2 │ search    │ 56015886 ± 1.17% │ 54427638 ± 2592117 │ 18 ± 0.92%             │ 18 ± 1                 │ 300     │
│ 3 │ send      │ 36258452 ± 1.24% │ 35941856 ± 2080397 │ 28 ± 1.19%             │ 28 ± 2                 │ 300     │
└───┴───────────┴──────────────────┴────────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

mcp_agent_mail:

```
┌───┬───────────┬──────────────────┬────────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns)   │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼────────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 21668606 ± 2.31% │ 20671487 ± 1037744 │ 47 ± 1.32%             │ 48 ± 3                 │ 300     │
│ 1 │ list      │ 5750113 ± 1.29%  │ 5542405 ± 332729   │ 176 ± 1.16%            │ 180 ± 11               │ 300     │
│ 2 │ search    │ 11596217 ± 1.29% │ 11262649 ± 851439  │ 87 ± 1.19%             │ 89 ± 7                 │ 300     │
│ 3 │ send      │ 72315159 ± 1.24% │ 71109390 ± 3935772 │ 14 ± 1.03%             │ 14 ± 1                 │ 300     │
└───┴───────────┴──────────────────┴────────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

agent-inbox:

```
┌───┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 3112387 ± 0.75%  │ 3050238 ± 106690 │ 323 ± 0.68%            │ 328 ± 12               │ 300     │
│ 1 │ list      │ 1278301 ± 1.43%  │ 1251505 ± 41829  │ 790 ± 0.89%            │ 799 ± 27               │ 300     │
│ 2 │ search    │ 2867229 ± 0.91%  │ 2793276 ± 88142  │ 351 ± 0.81%            │ 358 ± 11               │ 300     │
│ 3 │ send      │ 2258058 ± 0.98%  │ 2229486 ± 71088  │ 445 ± 0.74%            │ 449 ± 14               │ 300     │
└───┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

## Load: oha

oha 1.16.0 sends 1,000 requests of each operation from eight oha processes at
once, each with one connection (125 requests each) and, on servers that issue
MCP sessions, its own session.
mcp_agent_mail serves one request at a time per MCP session and leaves the
rest waiting, so the clients cannot share one session. Requests per second is
1,000 divided by the slowest process's `total`. Each oha report's own
`requestsPerSec` is one client's rate, not the server's.

The driver rejects a run unless every response is a 200, has no error and has
the same byte count as one verified response.

One of the eight reports from a Swarmail send run (its `summary` block, times
in seconds):

```json
{
  "successRate": 1.0,
  "total": 0.167036888,
  "slowest": 0.009999546,
  "fastest": 0.000276731,
  "average": 0.001311329696,
  "requestsPerSec": 748.3376965212618,
  "totalData": 46326,
  "sizePerRequest": 370,
  "sizePerSec": 277339.9370323518
}
```

The slowest of that run's eight processes took 0.1828 s, so the run counts as
1,000 / 0.1828 = 5,470 requests per second. Its three rounds gave 5,046, 5,336
and 5,470, so the summary shows 5,336.

Reads are loaded before sends, so every server's fetch, list and search see the
same store.

## Memory and CPU

The driver reads RSS and CPU ticks for the server's whole process tree from
`/proc`.

- **Idle memory.** RSS ten seconds after the server reports healthy.
- **Idle CPU.** CPU time over the following minute with no requests.
- **CPU for 5,240 timed calls.** The server's CPU time across the latency stage
  (1,240 calls including warmups) and the load stage (4,000 requests).
- **Peak memory.** The RSS high-water mark over the whole run.

## Setup

WSL 2 with 16 vCPUs (AMD Ryzen 9 9950X3D) and Bun 1.4.2. Each run held a
shared lock that keeps other benchmarks off the machine, ran under a 6 GiB
memory cap at nice 10, and alternated the servers across three rounds. Swap
stayed unused and at least 34 GiB of memory stayed available.

Three stretches overlapped other work on the machine and were run again alone:
one round of mcp_agent_mail_rust, one round of agent-inbox and the startup
stage. The tables use the reruns. During the agent-inbox rerun, another job
overlapped the idle wait before the memory sample; the timed stages that
followed had the machine to themselves.

The driver and the per-run logs are not published. This page carries the tool
output the tables come from.
