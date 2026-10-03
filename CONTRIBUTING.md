# Contributing

Issues and pull requests are welcome: a bug in the server, the `swarmail`
command or a setup script, support for another agent host, or a line in
`docs/usage.md` that agents misread.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## What fits

Swarmail stays a local server for one machine: no network transport, no
accounts. Leave out names of private projects or repositories, local paths,
home directories and credentials, including in test fixtures.

When you change `docs/usage.md` or the tool descriptions, say in the pull
request which agent behavior it changes and how you saw it, such as a quoted
reply from an agent that read the old and the new text.

## Before you open a pull request

1. Run the checks in the README's Development section. CI runs them too.
2. Add a `CHANGELOG.md` entry under `Unreleased` for any change users will
   notice.

## How changes land

The maintainer squash-merges pull requests into `main`; the squashed commit
keeps you as its author. Contributions are licensed under the MIT licence in
`LICENSE`. When you adapt someone else's work, credit it in
`THIRD_PARTY_NOTICES.md` and beside the adapted text.
