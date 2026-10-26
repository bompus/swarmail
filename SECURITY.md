# Security policy

swarmail stores the mail, agent names and project paths of your coding-agent sessions in a SQLite database on your computer, and it sends none of it to anyone but the clients you allow (see [PRIVACY.md](PRIVACY.md)). By default the server has no authentication: it accepts only local connections and rejects non-local `Origin` headers (only the `/healthz` status route skips that check), so any program running as you can read its data, and exposing its port to a network is unsupported. The one supported way to reach it from another machine is `SWARMAIL_HOST` ([README](README.md#using-it-from-another-machine)): a second listener on one named address that answers every route except `/healthz` only with a bearer token. Whoever holds the token can read and send all mail and read the roster, project paths and file reservations, so treat the token file like an SSH key. The server accepts any one non-loopback address, public ones included, so choose an address on a private network you trust, such as a Tailscale address. The extra listener speaks plain HTTP, so the token and mail are unencrypted unless that network encrypts them.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Include the version, your operating system and the host you run it with (for example Claude Code or Codex), and steps that reproduce the problem. Report privately anything that lets a program on another computer or a web page reach the server without the bearer token, or that lets one session read or change another session's mail without a local connection. A program on your own computer reading the database is how swarmail works today, so report that as an ordinary issue or feature request.

## Supported versions

Only the latest release gets fixes.
