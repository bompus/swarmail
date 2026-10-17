# Security policy

swarmail stores the mail, agent names and project paths of your coding-agent sessions in a SQLite database on your computer, and it sends none of it anywhere (see [PRIVACY.md](PRIVACY.md)). The server has no authentication: it accepts only local connections and rejects non-local `Origin` headers (only the `/healthz` status route skips that check), so any program running as you can read its data, and exposing its port to a network is unsupported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Include the version, your operating system and the host you run it with (for example Claude Code or Codex), and steps that reproduce the problem. Report privately anything that lets a program on another computer or a web page reach the server, or that lets one session read or change another session's mail without a local connection. A program on your own computer reading the database is how swarmail works today, so report that as an ordinary issue or feature request.

## Supported versions

Only the latest release gets fixes.
