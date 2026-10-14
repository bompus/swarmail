# Delivery canary

`swarmail canary` sends one message through the running server and follows it to an acknowledgement, so a timer can
tell you when mail stops arriving before an agent notices. One run:

1. Registers two agents of its own, a sender and a receiver, in a project that is its state directory, away from any
   real roster. Later runs reuse the same two names.
2. Has the receiver wait on `/wait` the way a wake hook does, then mails it a message that asks for an acknowledgement.
3. Passes only when the wait returns the public inbox notice, `fetch_inbox` returns that exact message, and the
   delivery receipt shows it read and acknowledged by the receiver.

```
swarmail canary
```

Each run appends one JSON line to `$XDG_STATE_HOME/swarmail-canary/results.jsonl`
(`~/.local/state/swarmail-canary/results.jsonl` by default) and prints it: `ts`, `ok`, `message_id`, `wake_ms` (send
to wake), `total_ms` and, for a miss, `error`. A miss prints the line to standard error and exits 1. The run waits up to
10 seconds for the wake hint.

| Variable         | Default                       | Effect                       |
| ---------------- | ----------------------------- | ---------------------------- |
| `SWARMAIL_URL`   | `http://127.0.0.1:18765/mcp/` | The server to test           |
| `XDG_STATE_HOME` | `~/.local/state`              | Where the log and names live |

## Run it hourly with systemd

`~/.config/systemd/user/swarmail-canary.service`:

```ini
[Unit]
Description=Swarmail delivery canary

[Service]
Type=oneshot
ExecStart=%h/.local/bin/swarmail canary
# OnFailure=my-alert@%n.service
```

`~/.config/systemd/user/swarmail-canary.timer`:

```ini
[Unit]
Description=Run the Swarmail delivery canary hourly

[Timer]
OnCalendar=hourly

[Install]
WantedBy=timers.target
```

Then `systemctl --user enable --now swarmail-canary.timer`. Add an `OnFailure=` unit to be told when a run exits 1.
