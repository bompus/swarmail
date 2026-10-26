# Configured wake bridges

`swarmail wake-bridge <config.json>` delivers mail notices to one explicitly
configured local session. It runs in the foreground until stopped. Installing
swarmail does not start bridges or enroll sessions automatically.

Use the host's orchestration tools for delegation. A bridge delivers inbox
information to an existing session; it does not assign tasks or manage agents.

## Choose a target

| Target type         | Transport                   | Delivery                                                                    |
| ------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `t3-v2-queue`       | Loopback HTTP and WebSocket | Agent message with steering intent; can reconcile older queued mail notices |
| `opencode-v2-queue` | Loopback HTTP               | Prompt with steering delivery and a matching admission receipt              |
| `codex-queue`       | Unix WebSocket              | Native app-server steering with a durable command ID                        |
| `grok-queue`        | Unix socket                 | Native leader steering with a durable prompt ID                             |

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

The target `url` must be an HTTP loopback origin without a path, query, fragment
or embedded credentials. `swarmailUrl` must be one too, or the origin of a
Swarmail server on another machine (for example `http://hub:18765`); the bridge
then sends the token from `SWARMAIL_TOKEN_FILE` and refuses to start without it.
`swarmailUrl` defaults to `http://127.0.0.1:18765`.

For a native target, replace `url` and `authorizationFile` with absolute
`socket` and `cwd` paths. The socket must belong to your user and be protected
by a private parent directory or the adapter's socket permission checks.
`timeoutMs` defaults to `60000`; accepted values are `1000` through `300000`.
Codex socket paths also exclude whitespace and URL delimiter characters.

Run the bridge after its target and the swarmail server are available:

```bash
swarmail wake-bridge config.json
```

Choose a native session ID, or a T3 thread ID, matching the recipient's
registration tag. Keep one bridge per swarmail origin and target ID. A second
process for that pair is refused by the journal's owner lock. Stop the process
with SIGINT or SIGTERM. A permanent target rejection exits with status `1`;
connection failures and other retryable errors retain the offer and retry.
A native Codex or Grok delivery whose outcome is unknown after its attempt
exits with status `1` and retains the command without resending it. Restart
the bridge to reconcile admission evidence, or inspect the session.

T3 V2 holds delivery during settlement or pending operator requests. It
steers explicitly, preserves user prompts and automatic notifications, and
consolidates queued mail notices the bridge owns. T3 records every message a
client sends as `createdBy: "user"`, so ownership comes from the notice message
ids the bridge saved (and the `agent` label on notices older T3 releases
recorded); a queued `Swarmail: ` message the bridge cannot prove it sent is left
alone. A 401 for the token the authorization file currently holds stops the
bridge as an authentication failure; a 401 for a token that rotation already
replaced is retried.

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
Swarmail: run swarmail inbox --session.
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
`~/.local/state/swarmail-bridge`. Each swarmail origin and target ID has a
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

## Local T3 lifecycle

The server can bind its T3 registrations to one explicitly configured local
Orchestrator V2 profile. Set `SWARMAIL_T3_LIFECYCLE` to a JSON object:

```json
{
  "profile": "local-t3",
  "databasePath": "ABSOLUTE_PATH_TO_STATEV2_SQLITE",
  "eventTable": "orchestration_events"
}
```

The equivalent programmatic option is `createServer(..., { t3Lifecycle })`.
This is optional; standalone agents do not require T3. Configure it only when
all unbound T3 registrations in that mail database belong to the chosen profile.
The first reconciliation binds those registrations. New T3 registrations use
that binding too, regardless of provider or whether the thread is a child.
Registrations in other projects with the same exact native host/session share
that lifecycle binding. The binding remains after provider replacement.
Use separate mail databases for separate profiles.

Verify the installed source before activation. The reader supports
`thread-projections` metadata schema 2 and a configured event table with
stable `sequence` and `event_id` columns. For T3 Code 0.1.0 and later, use
`orchestration_events`: its projection watermark counts that table, and
`orchestration_v2_events` is only a one-time copy made by the upgrade
migration. `orchestration_v2_events` stays accepted only for T3 Code releases
before 0.1.0 that wrote their history there.
A copied, empty event table cannot establish continuity. Projection updates
and their metadata watermark must commit in the same source transaction.

Startup requires a readable initial snapshot. Later reconciliation reads
lifecycle flags, the applied watermark and the prior history anchor in one
read-only source transaction. Source cursor and changed identities commit
together in swarmail. Unrelated app events update only the cursor.

An existing supervisor can call `POST /lifecycle/reconcile` with an empty body
at its scan boundary. The response is `{ "status": "ready", "changed": 0 }`
or `{ "status": "unavailable", "changed": 0 }`; `changed` counts identities,
not project registrations. The caller cannot supply lifecycle state or paths.
This interface adds no automatic enrollment, timer or service.

Settlement, archive and deletion suppress wakes and reject new mail and
reservations. Existing messages, read/ack state, names and delivery journals
remain. Inbox reads and maintenance releases still work. A newer verified
reopen restores the same identity. Process exit, provider replacement and
idle status do not establish app closure. T3 reservations retain their
existing expiry because they lack activation provenance.

A new registration whose thread projection is missing or invalid stays
ineligible without holding healthy identities. It becomes eligible after the
source supplies a valid active projection. The reader holds its last verified
state when a previously verified row or the event at the current watermark
disappears, the schema is unknown, or source history regresses or changes.
T3 Code deletes older events that a newer event of the same thread
supersedes, so the event saved at the previous reconciliation may be gone.
That alone is not a change: tracking continues unless that sequence now holds
a different event, the event appears at another sequence, or the watermark
moved backwards. Renaming the
profile or replacing its path cannot silently rebind that history. Repair the
source history before resuming; rebinding retained data requires a separate,
explicit migration and is not exposed by this interface. Omitting configuration
also holds wakes for previously bound identities.

Wake clients check `GET /wait/status?session=...` before waiting and at the
final delivery boundary. Only `{ "eligible": true }` permits a prompt. Missing,
malformed and unavailable status responses hold mail without acknowledging
it. Upgrade the core before these clients; older cores lack this endpoint.
Held Claude hints and prepared native/T3 journals remain available after reopen.

Observation and provider admission are separate transactions. A thread can
still settle after the final check and before T3 admits the command. An atomic
T3 admission guard is required to close that gap. Standalone SessionEnd hooks
keep their current behavior; automatic retirement needs verified activation
and end-event ordering before it can be enabled.

## Automatic T3 bridge startup

`swarmail wake-auto-t3 <config.json>` is a long-running supervisor that starts one bridge for every eligible T3
Codex thread, and for every Cursor thread under T3 Orchestrator V2, so they wake on mail without per-thread setup.
Claude threads are left out: the swarmail mod, or without it their stop hook, already wakes them in T3, and a bridge
would wait on the same session ID as that hook; the server ends the older wait with a 409. It runs on Linux only,
because credential rotation needs Unix file permissions. Run it under a service manager; it has no forced shutdown
deadline, and on SIGTERM or SIGINT its bridges stop polling at once while outstanding T3 calls finish.

This command is experimental and opt-in: it does nothing without a configuration file. It drives T3 Code through
T3's internal HTTP and WebSocket control plane, which T3 does not document, and it reads T3's database to find
threads. It was written against T3 Code Orchestrator V2 in the 0.0.46 to 0.1.x releases, and a T3 Code update can
break it. T3 Code now provides `t3_thread_send`, a server-side queue and webhook scheduled tasks natively, so swarmail
may remove this command if T3 Code covers waking threads (see
[Provider coverage](provider-coverage.md#tracking-t3-code)).

For a Cursor session that holds a settled automatic T3 registration, `swarmail hook wake cursor` and
`swarmail hook context cursor` return at once, because that session's bridge already waits on its mail.

The configuration is the [bridge configuration](#configure-and-run) with these differences:

- Leave out `target.id`; each thread's bridge supplies its own.
- `target.type` is `t3-v2-queue`. `target.delivery` is optional and may only be `auto`.
- `target.url` is optional. The supervisor reads the port T3 publishes in `<baseDir>/userdata/server-runtime.json` and
  uses `target.url` only when that file is missing.
- `rotation` is required: `verifyBackend` must be `true` and `baseDir` is T3's base directory. It enables the
  [credential rotation](#optional-t3-reader-primitives) the bridges send with. With `verifyBackend`, T3's own binary
  is used and any `executable` or `version` in the file is ignored.
- `enrollAfter` is required: an ISO time. Only threads whose T3 runtime record was last updated after it enroll (a
  window of recent activity also applies, whichever is later).

`swarmail wake-auto-t3 <config.json> --check` validates the supervisor-specific fields and the URL syntax, then exits 0
without starting anything; it does not check the credential file or whether T3 is available.

A thread gets a bridge when T3's runtime records show a running Codex or Cursor thread (a V2 thread counts as running
while its provider thread is idle or active; subagent threads, which V2 makes read-only, are skipped). It loses it when
the thread is settled, or its session ends, is replaced, archived or deleted. Settling keeps the mailbox and pending
journal, and reactivating the thread restores the bridge unless it is quarantined. Each bridge keeps its own mailbox
lock and journal, as a manual `wake-bridge` does.

A bridge that fails is quarantined with its reason in the supervisor state; healthy bridges continue. Restarting T3 or
the supervisor, settling or reactivating the thread, and a backend port change do not retry it. After resolving the
cause, stop the supervisor and run `swarmail wake-auto-t3 <config.json> --retry-thread <thread-id>`; this clears only
that thread's quarantine and leaves its journal and pending command intact. A malformed failure record, an invalid
shared configuration or a credential failure stops the supervisor. Ordinary T3 backend unavailability holds
supervision in the same process until verified readiness returns; it does not exhaust a restart budget. A different
program holding T3's port still stops the supervisor.

## Optional T3 reader primitives

Linux reader consumers can import `credentialService` and `wakeCredentials`
from `src/wake-credentials.ts`, backend identity checks from `src/wake-backend.ts`,
and `followT3Backend` from `src/wake-t3-backend.ts`. The normal swarmail CLI does
not enable these primitives or expose a new credential command. A consumer can
use the existing extra-command interface for its explicit credential operation.

`followT3Backend(configPath, { baseDir, url }, signal)` returns a polling
function. A ready result contains `url`, `moved` and `restarted`; `undefined`
means the backend is temporarily unavailable. The consumer owns its polling
cadence, shutdown signal and delivery behavior. A backend change requires a
fresh identity check before any credential is sent. Identity verification uses
the actual Linux listener, its executable and its open T3 database.

The follower first checks an existing credential without a CLI call or state
write. Only a clean, owned credential outside its renewal window can retry
connection refusal, connection reset or its own request timeout. Listener
absence and these transport failures keep returning `undefined` without an outage
expiry. Each retry rechecks identity. Every poll has its own five-minute operation
budget; requests and identity subprocesses retain their shorter timeouts and
respect cancellation. Verified readiness closes the outage. The automatic
supervisor polls again after its existing two-second pause and reconnects healthy
bridges when the backend URL changes. It retains quarantines and pending command
identities throughout the wait and reconnect.

Credential rejection, redirects, HTTP errors, malformed responses and identity
mismatches remain fatal. Missing or due credentials and unfinished rotation
state use the existing locked renewal path when no eligible session transport
retry has occurred. Listener absence alone does not disable that path. Once a
clean session check has a transport failure, losing retry eligibility before
verified readiness stops the follower without renewal.
It never enrolls a session, delivers mail, clears quarantine or changes a
pending delivery journal. Consumers must adopt the module explicitly;
installing swarmail does not restore a stopped reader.
