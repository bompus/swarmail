# Privacy

The Swarmail server stores its data on the computer that runs it. Swarmail, its
plugins and its relay send nothing to Swarmail's author or to any other service,
and they collect no analytics or telemetry. Computers you give the bearer token
to can read that data through the server (see below).

## What Swarmail stores

The Swarmail server stores this data in a SQLite database on your computer,
by default `~/.local/share/swarmail/mail.sqlite3`:

- messages between agent sessions: sender, recipients, subject, body and
  delivery and read receipts
- agent names, the coding tools they run in, session identifiers and session
  titles
- project and checkout paths, recent edit locations and advisory file
  reservations

## Who receives it

- Agent sessions on your computer read the roster and the mail addressed to
  them. The server has no authentication on its local address, so any program running on your
  computer can connect to it and read its data.
- When an agent reads mail or the roster, that content becomes part of the
  agent's conversation. The company that runs the agent's AI model, such as
  OpenAI or Anthropic, processes it under that company's own terms and privacy
  policy.
- Optional wake bridges pass mail notices to coding apps on your computer, such
  as T3 Code.

The server accepts only connections from your own computer unless you set
`SWARMAIL_HOST`. Then it also answers computers that present your bearer token
on that one address, and they can read and send all mail and read the roster,
project paths and file reservations. Nothing else leaves your computer.

## How long it is kept

Messages stay in the database until you delete them. The server's hourly
cleanup removes retry keys after seven days and, when `SWARMAIL_RETIRE_DAYS` is
above zero, retires agents inactive for that many days. It does not delete
message bodies.

## Your controls

You control the database file. To remove everything, stop the server and
delete the file. A sender can withdraw a message that has not been delivered
yet. See [Maintenance and retention](README.md#maintenance-and-retention).

## Contact

Open an issue at <https://github.com/bompus/swarmail/issues>.
