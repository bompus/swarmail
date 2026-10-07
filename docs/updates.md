# Session updates

The MCP connection briefing and `swarmail --help` point to
`swarmail updates --help` for the caller workflow below.

An optional local manifest names approved installed or deployed targets.
Swarmail checks it at supported context hooks without sending mail, starting
idle turns, installing software or restarting a provider. New upstream commits
are not approved targets. The host publishing the manifest owns deployment
qualification and refresh instructions.

Set `SWARMAIL_UPDATE_TARGETS` to an absolute JSON file path for the processes
running Swarmail hooks and commands. Publish complete files atomically. Without
this variable, checks emit nothing and create no update state.

```json
{
  "version": 1,
  "targets": {
    "guidance": {
      "revision": "guidance-content-hash",
      "instruction": "Reread the repository instruction root and its changed references.",
      "context": true
    },
    "tools": {
      "revision": "protocol-qualified-catalog-hash",
      "instruction": "Use the provider's supported MCP refresh and verify its catalog."
    }
  },
  "heldSessions": []
}
```

Components have distinct identities. A Git commit, compiled CLI/server build
and MCP catalog fingerprint are different revisions. Keep them under separate
keys. The manifest allows at most 32 components, each with a nonempty revision
and an instruction of at most 1,000 characters; the file limit is 64 KiB.
Component keys support dotted namespaces such as `guidance.codex`. Optional
`hosts: ["codex"]` restricts a target to that provider; generic targets apply to
every provider. Hooks and the session command supply the native host identity.
An unknown host cannot qualify scoped targets. Provider-scoped state uses both
host and native session ID, so matching IDs in different providers stay separate.

`swarmail updates --session --json` resolves the current session and returns
the latest targets, installed CLI build, loaded attestations and pending/held
states. A source invocation reports a null CLI build. Reading status does not
claim a hint or mark anything loaded. Missing or invalid configured manifests
fail the command; hooks stay quiet so they cannot block a tool.

Follow only refresh instructions within your authorization. After actually
rereading guidance or completing a supported tool refresh, record the exact
component revision with:

```sh
swarmail updates --session --ack guidance --revision guidance-content-hash
```

This is an **attestation by the caller**, not independent proof that a provider
replaced its cached catalog or obeys newly read guidance. File equality, an
HTTP catalog read, hint delivery and mail acknowledgment never produce that
attestation. A changed or unknown target rejects an old acknowledgment.
Provider-specific verification remains the host's responsibility.

Claude and Devin registration context, Cursor session start and Cursor/Devin
active context hooks can carry one short hint. Pending hints cover subsequent
target revisions until every target is attested. They never request a Stop
continuation. Antigravity's user-message injection and unqualified Codex,
Grok/OpenCode output paths receive no new hint. Their host can inspect status
at its own supported boundary. None of these paths guarantees MCP hot reload.

Session-start checks invalidate loaded components marked `context: true`.
A reset recorded while another hook holds the state lock is consumed at the
next check. Context metadata also invalidates targets temporarily omitted from
the manifest. Hosts with another context-reset boundary can explicitly run
`swarmail updates --session --reset-context`. Repeated resets without intervening
attestations preserve the pending hint. Attestations for non-context components
remain. Mark any component whose loading depends on the conversation context
with `context: true`.

`SWARMAIL_UPDATE_HOLD=1` or a matching `heldSessions` entry suppresses hints,
preserves loaded evidence and rejects acknowledgment. After releasing a frozen
context, reset its context evidence before using it. Offline sessions are
checked at their next supported hook, not woken for routine updates.

Local state lives under `XDG_STATE_HOME/swarmail-updates/`, or
`~/.local/state/swarmail-updates/`. It is separate from mail and registration.
Concurrent hooks claim at most one pending hint. A crash after claim can lose
the hint; pending status remains visible to an explicit check. There is no
exactly-once delivery guarantee or recurring reminder.

`GET /versions?protocolVersion=2025-11-25` reports `server_build`,
`tools_revision` and `protocol_version`. The tool revision is the SHA-256 of
`JSON.stringify(tools)` from the corresponding `tools/list` response. The
default protocol is 2025-11-25; unsupported versions fail with HTTP 400. This
read-only endpoint identifies running code and definitions, not the catalog
already loaded by an agent. Swarmail still advertises `tools.listChanged:false`.
