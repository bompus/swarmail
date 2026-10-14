# Reminders for unacknowledged mail

`swarmail overdue` finds mail sent with `ack_required` that a live recipient has not acknowledged and, once the
deadline has passed, does two things:

1. It sends the recipient one reminder in the same thread. The reminder is sent as the original sender, so a reply goes
   back to them, and it does not ask for an acknowledgement itself. If the sender is retired, no reminder is sent.
2. If the mail is still unacknowledged one deadline after the reminder, or no reminder could be sent, it reports the
   problem to the operator once.

Retired recipients, acknowledged mail and mail older than the window are left alone. The command runs once and exits;
run it from a timer. Every 10 minutes works.

```
swarmail overdue [--dry-run]
```

`--dry-run` prints what the command would do and sends and records nothing.

## Settings

| Variable                        | Default                                | Effect                                                                                        |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SWARMAIL_OVERDUE_MINUTES`      | `30`                                   | How long mail may stay unacknowledged, and how long after a reminder the operator hears of it |
| `SWARMAIL_OVERDUE_WINDOW_HOURS` | `24`                                   | Mail older than this is no longer checked                                                     |
| `SWARMAIL_NOTIFY`               | unset                                  | Command that receives each operator report; see below                                         |
| `SWARMAIL_DB`                   | `~/.local/share/swarmail/mail.sqlite3` | The database to read                                                                          |
| `SWARMAIL_URL`                  | `http://127.0.0.1:18765/mcp/`          | The server that sends the reminders                                                           |

The command remembers what it has already sent in `$XDG_STATE_HOME/swarmail-overdue/state.json`
(`~/.local/state/swarmail-overdue/state.json` by default), so a reminder and a report each go out once per message and
recipient.

## Operator reports

With `SWARMAIL_NOTIFY` unset, the command only prints the report as a line of output (`notify the operator: ...`) and
records it as sent. Set `SWARMAIL_NOTIFY` to an executable to receive it. The command is run directly, without a shell,
with these arguments:

```
<command> --key KEY --title TITLE --body BODY --severity warn --source swarmail [--detail DETAIL]
```

`KEY` is stable for one message and recipient, so a command that deduplicates by key shows one card. `--detail` holds a
`swarmail who` command that shows the recipient's session. A command that exits with a status other than 0 is a failed report: the
command prints it to standard error, still saves everything else it did, exits 1 and sends only that report again on
the next run.

## Run it every 10 minutes with systemd

`~/.config/systemd/user/swarmail-overdue.service`:

```ini
[Unit]
Description=Swarmail deadline check

[Service]
Type=oneshot
ExecStart=%h/.local/bin/swarmail overdue
# Environment=SWARMAIL_NOTIFY=%h/.local/bin/my-notifier
```

`~/.config/systemd/user/swarmail-overdue.timer`:

```ini
[Unit]
Description=Run the Swarmail deadline check every 10 minutes

[Timer]
OnCalendar=*:0/10

[Install]
WantedBy=timers.target
```

Then `systemctl --user enable --now swarmail-overdue.timer`.
