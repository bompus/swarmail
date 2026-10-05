# Configured wake bridges

`swarmail wake-bridge <config.json>` delivers mail notices to one explicitly
configured local session. It runs in the foreground until stopped. Installing
Swarmail does not start bridges or enroll sessions automatically.

Use the host's orchestration tools for delegation. A bridge delivers inbox
information to an existing session; it does not assign tasks or manage agents.

## Choose a target

| Target type | Transport | Delivery |
| --- | --- | --- |
| `t3-v1-steer` | Loopback HTTP | Starts a turn that steers the active turn using its current modes |
| `t3-v2-queue` | Loopback HTTP and WebSocket | Agent message with steering intent; can reconcile older queued mail notices |
| `opencode-v2-queue` | Loopback HTTP | Prompt with steering delivery and a matching admission receipt |
| `codex-queue` | Unix WebSocket | Native app-server steering with a durable command ID |
| `grok-queue` | Unix socket | Native leader steering with a durable prompt ID |

The names ending in `queue` are retained configuration identifiers. New mail
uses steering regardless of priority. Native Codex and Grok bridges require
Unix sockets and POSIX ownership checks; they reject Windows configurations.
HTTP targets work without those socket requirements. These adapters require
the protocol and admission fields they validate, and hold mail when a target
cannot provide them.

Claude Code and Cursor can also use the existing wake hooks. Cursor, Devin
and Antigravity have context hooks for mail during active work. Those hooks
and standalone bridges do not require T3 Code.

## Configure and run

For an HTTP target, create a JSON file with these fields:

```json
{
  "swarmailUrl": "http://127.0.0.1:18765",
  "target": {
    "type": "t3-v2-queue",
    "id": "TARGET_THREAD_ID",
    "url": "http://127.0.0.1:3773",
    "authorizationFile": "ABSOLUTE_PATH_TO_AUTHORIZATION_FILE"
  }
}
```

Replace the thread ID, target port and authorization file placeholder with
values for your session. `authorizationFile` must be an absolute path. Its
contents must be one `Bearer TOKEN` or `Basic VALUE` header. On POSIX, it must
be owned by your user and have mode `600`. On Windows, protect it with your
user's ACLs. Never put credentials in the config URL or command line.

Both URLs must be HTTP loopback origins without paths, queries, fragments or
embedded credentials. `swarmailUrl` defaults to `http://127.0.0.1:18765`.

For a native target, replace `url` and `authorizationFile` with absolute
`socket` and `cwd` paths. The socket must belong to your user and be protected
by a private parent directory or the adapter's socket permission checks.
`timeoutMs` defaults to `60000`; accepted values are `1000` through `300000`.
Codex socket paths also exclude whitespace and URL delimiter characters.

Run the bridge after its target and the Swarmail server are available:

```bash
swarmail wake-bridge config.json
```

Choose a native session ID, or a T3 thread ID, matching the recipient's
registration tag. Keep one bridge per Swarmail origin and target ID. A second
process for that pair is refused by the journal's owner lock. Stop the process
with SIGINT or SIGTERM. A permanent target rejection exits with status `1`;
connection failures and other retryable errors retain the offer and retry.
A native Codex or Grok delivery whose outcome is unknown after its attempt
exits with status `1` and retains the command without resending it. Restart
the bridge to reconcile admission evidence, or inspect the session.

T3 V2 holds delivery during settlement or pending operator requests. It uses
agent messages and explicit steering, preserves user prompts and automatic
notifications, and consolidates bridge-owned queued mail notices.

## Notification deduplication

Each receiving session has one outstanding generic inbox notice. Native IDs
and T3 thread IDs linked by its registration tags share that notice. Once its
transport confirms admission, later mail is covered by that notice until all
of the session's unread mail has been marked read. Previewing mail or reading
only part of an inbox does not rearm notifications. Sender acknowledgements
are separate: messages can still need `acknowledge_message` after being read.

An uncertain delivery retries the saved offer with the same event ID, including
across restart. Reading the inbox and releasing its notice happen in one
transaction, so mail arriving after the drain can trigger a new notice.

Delivery cursors remain separate for each target ID. An unconfirmed offer is
retried by its original delivery path; alternate linked paths suppress their
notices until the shared inbox drains. Upgrades preserve earlier offers that
still cover unread mail.

If an unconfirmed notice's original native session disappears during provider
replacement, linked replacement paths remain suppressed. Registration alone
cannot prove that the original notice was never delivered. Read the shared
inbox from the replacement session with `swarmail inbox --session` to release
the notice; previewing mail does not release it. Automatic transport takeover
is not supported.

Native IDs shared by distinct receiving sessions do not claim notifications.
Use distinct native IDs or a matching T3 thread ID for delivery.
Adding a T3 tag links a native notice only when that native ID maps to one
thread. Removing or changing a T3 tag can change the receiving identity and
rearm a notice. Stored mail remains available.

## Read the notice

New notices contain one instruction:

```text
Swarmail: Fetch all unread mail with swarmail inbox --session.
```

Run it inside the receiving agent's session environment. The CLI identifies
that session and drains its unread receipts across registered repositories.
It includes message bodies and marks each returned page read. Mailbox context
appears with the fetched messages, where it is needed to reply or acknowledge.
See [Reading mail](usage.md#reading-mail) for previews and the MCP interface.

Priority affects when the recipient assesses mail, not the sender's authority.
The recipient decides whether an authorized request warrants pausing its work.

## Retained state and retries

Bridge state lives under `XDG_STATE_HOME/swarmail-bridge`, or
`~/.local/state/swarmail-bridge`. Each Swarmail origin and target ID has a
SQLite journal and a separate SQLite owner lock. The journal records the wake
cursor, complete pending command and optional notice context.

A lost admission response replays the saved command unchanged. Restarting or
upgrading does not regenerate its IDs or rewrite its message text. A pending
notice from an older version can therefore contain older, longer text.
Admitting a notice advances the wake cursor; it does not read inbox messages.

Keep existing journals when adopting these modules. If the destination binding
changes, the bridge refuses to reuse the journal. Inspect and reconcile pending
delivery before changing its destination or removing state. A refused bridge
has not established whether its saved command reached the target.
