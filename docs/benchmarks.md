# Benchmarks

Swarmail compared with five other local agent-mail servers on one machine and
one small workload, measured on 2026-10-04 UTC. hyperfine times startup,
[Tinybench](https://github.com/tinylibs/tinybench) times single-client calls and
[oha](https://github.com/hatoo/oha) sends load from eight clients. The driver
measures memory and CPU from `/proc` and checks every server's answers.

The results cover this workload only. They say nothing about durability after
a crash, large archives or production load.
Swarmail was measured at
[`67e187a`](https://github.com/bompus/swarmail/tree/67e187a6b4beb7319c6ab30466448742297e2a01).
These results have not been remeasured for 0.4.0, 0.5.0, 0.5.1 or 0.5.2.

## Summary

Each cell is the median of three rounds; startup is hyperfine's mean of 20
runs. The multiplier shows how much worse than Swarmail each server did. It
is computed from those medians, and from the hyperfine means for startup.

|                                | Swarmail    | mcp_agent_mail_rust | mcp_agent_mail    | agent-inbox*     | agentbus           | Project Relay      |
| ------------------------------ | ----------- | ------------------- | ----------------- | ---------------- | ------------------ | ------------------ |
| Startup to healthy (hyperfine) | 37.7 ms     | 1,530 ms (41×)      | 858 ms (23×)      | 263 ms (7.0×)    | 408 ms (11×)       | 123 ms (3.3×)      |
| Ready, timed in-process        | 25.7 ms     | 1,518 ms (59×)      | 893 ms (35×)      | 275 ms (11×)     | 392 ms (15×)       | 119 ms (4.6×)      |
| Idle memory (RSS)              | 32.2 MiB    | 190 MiB (5.9×)      | 154 MiB (4.8×)    | 63.6 MiB (2.0×)  | 80.8 MiB (2.5×)    | 121 MiB (3.8×)     |
| Idle CPU                       | 40 ms/min   | 90 ms/min (2.2×)    | 80 ms/min (2.0×)  | 90 ms/min (2.2×) | 80 ms/min (2.0×)   | 0 ms/min           |
| Load 250 seed messages         | 168 ms      | 9,507 ms (57×)      | 17,726 ms (106×)  | 905 ms (5.4×)    | 618 ms (3.7×)      | 797 ms (4.8×)      |
| Send, p50                      | 0.457 ms    | 38.6 ms (84×)       | 70.4 ms (154×)    | 2.26 ms (5.0×)   | 2.32 ms (5.1×)     | 2.52 ms (5.5×)     |
| Fetch inbox, p50               | 0.498 ms    | 12.4 ms (25×)       | 22.5 ms (45×)     | 3.24 ms (6.5×)   | 1.08 ms (2.2×)     | 1.44 ms (2.9×)     |
| List agents, p50               | 0.545 ms    | 10.6 ms (19×)       | 5.84 ms (11×)     | 1.30 ms (2.4×)   | 1.03 ms (1.9×)     | 1.35 ms (2.5×)     |
| Search, p50                    | 0.647 ms    | 56.3 ms (87×)       | 11.9 ms (18×)     | 2.89 ms (4.5×)   | no search tool     | no search tool     |
| Send, 8 clients                | 5,469 req/s | 50.1 req/s (109×)   | 9.72 req/s (563×) | 633 req/s (8.6×) | 876 req/s (6.2×)   | 482 req/s (11×)    |
| Fetch inbox, 8 clients         | 6,261 req/s | 416 req/s (15×)     | 26.7 req/s (235×) | 207 req/s (30×)  | 1,571 req/s (4.0×) | 1,060 req/s (5.9×) |
| List agents, 8 clients         | 7,589 req/s | 536 req/s (14×)     | 30.3 req/s (251×) | 975 req/s (7.8×) | 1,683 req/s (4.5×) | 994 req/s (7.6×)   |
| Search, 8 clients              | 4,263 req/s | 89.5 req/s (48×)    | 43.8 req/s (97×)  | 227 req/s (19×)  | no search tool     | no search tool     |
| CPU for the timed calls        | 1.00 s      | 183 s (183×)        | 263 s (263×)      | 14.3 s (14×)     | 2.62 s (2.6×)†     | 4.61 s (4.6×)†     |
| Peak memory (RSS)              | 66.5 MiB    | 688 MiB (10×)       | 258 MiB (3.9×)    | 118 MiB (1.8×)   | 96.2 MiB (1.4×)    | 296 MiB (4.5×)     |

\* agent-inbox is only partly comparable. It returns 50-message inbox pages
instead of 20, lists a global roster that includes its own `admin` and `host`
agents, and searches by substring, so its fetch, list and search do different
work.

† The four servers with search make 5,240 timed calls. agentbus and Project
Relay have no search tool and make 3,930, so their CPU multiplier compares
fewer calls with Swarmail's 5,240.

- mcp_agent_mail commits each send to a Git archive before it returns.
  mcp_agent_mail_rust does its archive and index work in the background, after
  the call returns. These numbers don't compare durability.
- Each server's own health check decides when it is ready.
  mcp_agent_mail_rust and mcp_agent_mail check readiness; the other four only
  check liveness.
- Idle CPU is counted in 10 ms clock ticks, so its multipliers are coarse.
  Project Relay used no ticks in any idle minute.
- Requests per second varied by up to 29% between rounds of the same server
  (Swarmail send 4,305 to 5,890), so small differences mean little.
- One mcp_agent_mail round took 2,869 ms to become ready, the first start in
  a freshly built environment. The other two took 893 and 848 ms; the median
  uses 893.

## Features

What each local agent-mail server offers, read on 2026-10-04 from its source
at the commit each server name links to. The benchmark on this page covers the
first six.

| Server                                                                                                                        | Runtime                       | Agents connect over                                                  | Server process                  | Storage                                   | Roster                             | Platforms                                            | Licence                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- | ------------------------------- | ----------------------------------------- | ---------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Swarmail ([`eb6c730`](https://github.com/bompus/swarmail/tree/eb6c730))                                                       | One compiled Bun binary       | MCP over HTTP, or stdio through `swarmail-mcp`                       | Required (systemd user service) | SQLite, FTS5 index                        | Per repository; worktrees share it | Linux with systemd, including WSL 2; Windows preview | MIT                                |
| [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/tree/21a25c2bcfd20c9b31bcb109c294d17411eb5ba1) | Rust, prebuilt binaries       | MCP over stdio or HTTP                                               | Optional                        | FrankenSQLite, Tantivy index, Git archive | Per project path                   | Linux, macOS, Windows                                | MIT with an OpenAI/Anthropic rider |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail/tree/3fad5ec672869f81d2ca0a4c525dde004ac96f45)           | Python 3.12+, 32 dependencies | MCP over HTTP or stdio                                               | Optional; its hooks expect one  | SQLite, FTS5 index, Git archive           | Per project path                   | Linux, macOS                                         | MIT with an OpenAI/Anthropic rider |
| [agent-inbox](https://github.com/salimfadhley/agent-inbox/tree/a86647c2d61265e9a12fbc9ea0826a27712492cb)                      | Python 3.14+                  | A stdio MCP client per agent that calls the hub's HTTP API           | Required (hub)                  | SQLite                                    | One per hub                        | Any; declared OS independent                         | GPL-3.0-or-later                   |
| [agentbus](https://github.com/oznotes/AgentCommBus/tree/225a57c91180421bf2d698328a57f488f18bd820)                             | Python 3.11+                  | MCP over HTTP, a stdio shim, or REST                                 | Required                        | SQLite                                    | One per server                     | Not stated; no OS-specific code                      | MIT                                |
| [Project Relay](https://github.com/MuhammadFarhantahirvoltic/project-relay/tree/36d9a0765e4469f667c2e09fafe745166493fa86)     | Node 22.13+                   | MCP over stdio on a shared SQLite file, or HTTP                      | Optional                        | SQLite                                    | Per project                        | Linux, macOS (CI)                                    | MIT                                |
| [Agent Wire](https://github.com/kevinmanase/agent-wire/tree/ce9f1f282d9cb07fecd5ebe6767ac7f6ba446330)                         | Python 3.11+                  | A stdio MCP server per agent, talking to a broker over a Unix socket | Required (broker)               | SQLite                                    | One per OS user                    | Linux; macOS not verified                            | AGPL-3.0-only                      |
| [Durebak](https://github.com/ggujunhi247/durebak/tree/d0f1f520160d551b3ec218056f50355f26abbe24)                               | Node 24+                      | A stdio MCP bridge to a loopback HTTP server                         | Required                        | SQLite                                    | Per workspace                      | Linux, macOS                                         | Apache-2.0                         |

| Server              | Sender identity                                                              | Threads and receipts                                             | Broadcast              | Search                        | File reservations                                 | Wakes an idle session                                                  | For people         | MCP tools          |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | ------------------ |
| Swarmail            | Agent name in each call, not checked; local connections only                 | Threads; read, acknowledged and delivery receipts                | No; cc and bcc         | Full text (FTS5)              | Advisory, with a git guard                        | Claude Code and Cursor                                                 | CLI                | 19                 |
| mcp_agent_mail_rust | Agent name; a token is optional, and unverified sends are allowed by default | Threads; read, acknowledged and delivery receipts                | Rejected               | Full text (Tantivy)           | Advisory, with a git guard                        | No; Claude Code hooks check the inbox during a turn                    | CLI, web UI, TUI   | 45                 |
| mcp_agent_mail      | Agent name plus that agent's token or a session bound to it                  | Threads; read and acknowledged                                   | Yes                    | Full text (FTS5)              | Advisory, with a git guard that is off by default | No; Claude Code, Codex and Factory hooks check the inbox during a turn | CLI, web UI        | 50 (42 by default) |
| agent-inbox         | A header, trusted unless tokens are turned on                                | Threads; read state                                              | To everyone or a group | Substring, at most 25 results | None                                              | Claude Code (opt-in hook), opencode, omp                               | CLI, web console   | 17                 |
| agentbus            | A header or argument, not checked                                            | No threads; reading moves a cursor                               | Yes                    | None                          | None                                              | No; an agent waits in `recv` for up to 600 s                           | CLI, web dashboard | 5                  |
| Project Relay       | A bearer token per agent                                                     | Replies; acknowledged per recipient                              | Yes                    | None                          | Advisory leases                                   | No; an inbox read waits for up to 25 s                                 | CLI                | 17                 |
| Agent Wire          | A bearer handle per session                                                  | Replies; acknowledged                                            | No                     | None                          | None                                              | Delivers into running Claude Code and Codex sessions                   | CLI                | 7                  |
| Durebak             | A bearer token per session                                                   | Replies and request threads; leased receive with acknowledgement | No                     | None                          | None                                              | No                                                                     | CLI                | 39                 |

Agent Channel is not listed because its server is a hosted service at
channel.amkentech.com. Only its client is published, as
[agent-channel-client](https://github.com/amkentech/agent-channel-client).

## Servers

| Server                                                                                                                        | Version                                                                                                                | Storage                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Swarmail                                                                                                                      | [`67e187a`](https://github.com/bompus/swarmail/tree/67e187a6b4beb7319c6ab30466448742297e2a01), compiled with Bun 1.4.2 | SQLite with FTS5 search              |
| [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/tree/21a25c2bcfd20c9b31bcb109c294d17411eb5ba1) | upstream main `21a25c2b` (`am 0.3.36`), release profile and release feature flags                                      | FrankenSQLite and Tantivy            |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail/tree/3fad5ec672869f81d2ca0a4c525dde004ac96f45)           | `3fad5ec`, locked dependencies, Python 3.14.4                                                                          | SQLite with FTS5, plus a Git archive |
| [agent-inbox](https://github.com/salimfadhley/agent-inbox)                                                                    | 1.7.1, direct HTTP interface                                                                                           | SQLite                               |
| [agentbus](https://github.com/oznotes/AgentCommBus/tree/225a57c91180421bf2d698328a57f488f18bd820)                             | `225a57c` (package 0.1.0), Python 3.14.4, MCP over HTTP                                                                | SQLite                               |
| [Project Relay](https://github.com/MuhammadFarhantahirvoltic/project-relay/tree/36d9a0765e4469f667c2e09fafe745166493fa86)     | `36d9a07` (0.3.1), Node 26.10.0, MCP over HTTP                                                                         | SQLite                               |

The Swarmail binary also carried commands for waking sessions, which the
benchmark does not run.

agentbus and Project Relay needed small adaptations to do the same work as the
others:

- agentbus caps each sender at 60 sends a minute, which would refuse the
  measured sends. Its command line has no option for the cap, so the launcher
  raises the default before starting the server. Its `recv` returns every
  message after a sequence number and stores a read cursor, so its fetch asks
  for the newest 20 and includes a write.
- Project Relay issues one bearer credential per agent when a project is set
  up. The project and its 40 agents are set up before the server starts,
  outside every timed stage. Its MCP endpoint keeps no sessions. Its fetch
  asks for the newest 20 messages with acknowledged ones included, and the
  load clients stay under its limit of 16 requests in flight per credential.

## Workload

One project with 40 agents. Each server starts on empty storage, loads the same
250 seed messages, and must answer with 40 agents listed, 25 search hits and a
20-message inbox page before anything is timed. The timed operations are:

- **Send.** One message to one recipient.
- **Fetch inbox.** One agent's newest 20 messages.
- **List agents.** The project's roster.
- **Search.** A full-text query with 25 hits. agentbus and Project Relay have
  no search tool, so they run the other three.

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
  Time (mean ± σ):       7.2 ms ±   0.6 ms    [User: 4.6 ms, System: 3.4 ms]
  Range (min … max):     6.6 ms …   8.5 ms    20 runs

Benchmark 2: Swarmail
  Time (mean ± σ):      37.7 ms ±   0.7 ms    [User: 13.3 ms, System: 16.2 ms]
  Range (min … max):    37.1 ms …  39.3 ms    20 runs

Benchmark 3: mcp_agent_mail_rust
  Time (mean ± σ):      1.530 s ±  0.015 s    [User: 0.276 s, System: 0.251 s]
  Range (min … max):    1.510 s …  1.563 s    20 runs

Benchmark 4: mcp_agent_mail
  Time (mean ± σ):     857.7 ms ±  38.7 ms    [User: 728.6 ms, System: 127.2 ms]
  Range (min … max):   803.5 ms … 925.7 ms    20 runs

Benchmark 5: agent-inbox
  Time (mean ± σ):     263.0 ms ±  11.4 ms    [User: 245.8 ms, System: 52.4 ms]
  Range (min … max):   252.0 ms … 297.9 ms    20 runs

Benchmark 6: agentbus
  Time (mean ± σ):     408.2 ms ±  15.6 ms    [User: 348.1 ms, System: 48.8 ms]
  Range (min … max):   385.1 ms … 443.3 ms    20 runs

Benchmark 7: Project Relay
  Time (mean ± σ):     122.9 ms ±   5.3 ms    [User: 125.6 ms, System: 32.9 ms]
  Range (min … max):   113.8 ms … 132.7 ms    20 runs

Summary
  wrapper only ran
    5.27 ± 0.43 times faster than Swarmail
   17.17 ± 1.56 times faster than Project Relay
   36.75 ± 3.35 times faster than agent-inbox
   57.03 ± 5.06 times faster than agentbus
  119.84 ± 11.03 times faster than mcp_agent_mail
  213.82 ± 17.27 times faster than mcp_agent_mail_rust
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
│ 0 │ fetch     │ 498996 ± 2.81%   │ 489063 ± 16717   │ 2034 ± 0.86%           │ 2045 ± 69              │ 300     │
│ 1 │ list      │ 543945 ± 3.10%   │ 524798 ± 20486   │ 1885 ± 1.16%           │ 1905 ± 74              │ 300     │
│ 2 │ search    │ 682162 ± 4.31%   │ 647065 ± 29128   │ 1526 ± 1.36%           │ 1545 ± 72              │ 300     │
│ 3 │ send      │ 557180 ± 12.78%  │ 457475 ± 21601   │ 2106 ± 1.96%           │ 2186 ± 105             │ 300     │
└───┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

mcp_agent_mail_rust:

```
┌───┬───────────┬──────────────────┬────────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns)   │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼────────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 12322473 ± 0.90% │ 12351619 ± 362423  │ 82 ± 0.89%             │ 81 ± 2                 │ 300     │
│ 1 │ list      │ 10504843 ± 0.96% │ 10544073 ± 365664  │ 96 ± 0.94%             │ 95 ± 3                 │ 300     │
│ 2 │ search    │ 57333216 ± 0.73% │ 57431197 ± 870117  │ 18 ± 0.63%             │ 17 ± 0                 │ 300     │
│ 3 │ send      │ 38470411 ± 0.96% │ 38562295 ± 1651417 │ 26 ± 1.01%             │ 26 ± 1                 │ 300     │
└───┴───────────┴──────────────────┴────────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

mcp_agent_mail:

```
┌───┬───────────┬──────────────────┬────────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns)   │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼────────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 23254663 ± 2.36% │ 22639412 ± 519156  │ 44 ± 1.32%             │ 44 ± 1                 │ 300     │
│ 1 │ list      │ 5819404 ± 0.81%  │ 5843695 ± 194133   │ 173 ± 0.82%            │ 171 ± 6                │ 300     │
│ 2 │ search    │ 11969524 ± 0.99% │ 11961941 ± 362799  │ 84 ± 0.95%             │ 84 ± 2                 │ 300     │
│ 3 │ send      │ 71468451 ± 1.15% │ 70449180 ± 1713367 │ 14 ± 0.82%             │ 14 ± 0                 │ 300     │
└───┴───────────┴──────────────────┴────────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

agent-inbox:

```
┌───┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 3268702 ± 0.65%  │ 3240166 ± 90777  │ 307 ± 0.60%            │ 309 ± 9                │ 300     │
│ 1 │ list      │ 1311950 ± 1.30%  │ 1299266 ± 67939  │ 769 ± 0.93%            │ 770 ± 40               │ 300     │
│ 2 │ search    │ 2920461 ± 0.65%  │ 2892747 ± 86644  │ 343 ± 0.60%            │ 346 ± 11               │ 300     │
│ 3 │ send      │ 2306506 ± 1.76%  │ 2264625 ± 87775  │ 438 ± 0.94%            │ 442 ± 18               │ 300     │
└───┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

agentbus:

```
┌───┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 1110378 ± 1.91%  │ 1083120 ± 75757  │ 916 ± 1.23%            │ 923 ± 65               │ 300     │
│ 1 │ list      │ 1251344 ± 29.36% │ 1041369 ± 61323  │ 946 ± 1.29%            │ 960 ± 55               │ 300     │
│ 2 │ send      │ 2289056 ± 9.68%  │ 2316761 ± 148400 │ 480 ± 2.73%            │ 432 ± 27               │ 300     │
└───┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

Project Relay:

```
┌───┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│   │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├───┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0 │ fetch     │ 1529263 ± 3.44%  │ 1443291 ± 79862  │ 682 ± 1.67%            │ 693 ± 37               │ 300     │
│ 1 │ list      │ 1461175 ± 4.11%  │ 1348669 ± 62658  │ 719 ± 1.71%            │ 741 ± 35               │ 300     │
│ 2 │ send      │ 2611477 ± 1.86%  │ 2517165 ± 98574  │ 390 ± 1.30%            │ 397 ± 15               │ 300     │
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
  "total": 0.166301761,
  "slowest": 0.007077641,
  "fastest": 0.000375627,
  "average": 0.0013092635279999996,
  "requestsPerSec": 751.6456786046903,
  "totalData": 46314,
  "sizePerRequest": 370,
  "sizePerSec": 278493.743671181
}
```

The slowest of that run's eight processes took 0.18284 s, so the run counts as
1,000 / 0.18284 = 5,469 requests per second. Its three rounds gave 5,469, 5,890
and 4,305, so the summary shows 5,469.

Reads are loaded before sends, so every server's fetch, list and search see the
same store.

## Memory and CPU

The driver reads RSS and CPU ticks for the server's whole process tree from
`/proc`.

- **Idle memory.** RSS ten seconds after the server reports healthy.
- **Idle CPU.** CPU time over the following minute with no requests.
- **CPU for the timed calls.** The server's CPU time across the latency stage
  (1,240 calls including warmups) and the load stage (4,000 requests); 930 and
  3,000 for the two servers without search.
- **Peak memory.** The RSS high-water mark over the whole run.

## Setup

WSL 2 with 16 vCPUs (AMD Ryzen 9 9950X3D) and Bun 1.4.2. The run held a
shared lock that keeps other benchmarks off the machine, ran under a 6 GiB
memory cap at nice 10, and alternated the six servers across three rounds.
Swap was cleared first and stayed unused, at least 38.9 GiB of memory stayed
available, and no other heavy job ran during it, so no round was rerun.

The driver and the per-run logs are not published. This page carries the tool
output the tables come from.
