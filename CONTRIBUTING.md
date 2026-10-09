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

## Releasing

The maintainer cuts each release from `main`:

1. Open a pull request that sets `version` in `package.json`,
   `packages/mcp-relay/package.json` and both version fields in `server.json`
   to the same `X.Y.Z`. Rename the `Unreleased` heading in `CHANGELOG.md`
   to `X.Y.Z - YYYY-MM-DD`. `bun run check` rejects version drift.
2. After it merges, tag the squash commit `vX.Y.Z`, push the tag, and publish
   a GitHub release from it, marked latest, with that changelog section as its
   notes.
3. Publish the matching npm package
   [`swarmail-mcp`](https://www.npmjs.com/package/swarmail-mcp) and MCP registry
   metadata for each release. Run
   `npm publish` in `packages/mcp-relay/` and `mcp-publisher publish` in the
   repository root.
4. Check that Glama's admin Releases page lists `X.Y.Z`. With Auto-Release
   enabled, Glama builds and publishes it after the GitHub release. Its public
   listing and scores can update later. If Auto-Release is off, use the
   [admin page](https://glama.ai/mcp/servers/bompus/swarmail/admin/dockerfile)
   to Sync Server, then Deploy. When the build test passes, click Make Release
   and enter `X.Y.Z`. The saved build spec (build steps
   `["npm install -g bun@1.4.2"]`, CMD `["bun", "scripts/glama.ts"]`) needs a
   change only when the Bun version CI uses or `scripts/glama.ts` changes.
5. Check every listing in the next section that is not marked pending.
   Update by hand any that still shows an older version or outdated details.

## Listings

Swarmail is listed in these places. When you list it somewhere new, add it
here, so a release or a change to its description reaches every listing. Mark
a submission pending until it is accepted.

- [npm `swarmail-mcp`](https://www.npmjs.com/package/swarmail-mcp): details
  come from `packages/mcp-relay/package.json` and its README. `npm publish`
  updates it (step 3).
- [MCP Registry `io.github.bompus/swarmail`](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.bompus%2Fswarmail/versions/latest):
  details come from `server.json`. `mcp-publisher publish` updates it
  (step 3).
- [Glama](https://glama.ai/mcp/servers/bompus/swarmail): details come from the
  GitHub repository and `glama.json`. Auto-Release builds each release
  (step 4). Edit the build spec and details on the admin page.
- [MCPRush](https://mcprush.com/aaron-queen/swarmail-mcp): an owner-claimed
  listing of the npm package. It is not known whether it follows new npm
  releases, so check the version it shows. Edit it while signed in as its
  owner.
- [Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers)
  (pending): one line under Communication in that repository's `README.md`,
  submitted in
  [#16031](https://github.com/punkpeye/awesome-mcp-servers/pull/16031). It
  shows no version, so releases need no change. To change its description or
  tags, open a pull request there that edits that line.
