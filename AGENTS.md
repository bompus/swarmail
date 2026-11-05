# Agent notes

Swarmail is a Bun and TypeScript MCP server. The README says what it does and
`CONTRIBUTING.md` says how changes land; this file lists only what an agent
working in this repository needs on top of those.

## Checks

```bash
bun install
bun run check   # release, public-text, format, lint, type and shell checks
bun test
```

`bun run check` also runs `shellcheck` and `shfmt` on the shell scripts, so both
must be installed. Run the checks bare or redirected to a log you read after they
exit. CI runs the same checks on Linux and Windows; on Windows it runs
`bun test --timeout 60000`, because several tests approach Bun's five-second
default there, so use that command on Windows.

## Rules that no lint states

- Keep names of private projects or repositories, local paths, home directories
  and credentials out of every file, test fixtures included. The repository is
  public.
- `scripts/check-public.ts` fails on wording from when Swarmail served one machine
  only. When a change alters where Swarmail runs, who can reach it or what it
  stores, add the phrases it makes stale to `scripts/lib/brand.ts`.
- A change to `docs/usage.md` or a tool description changes what agents do. Say in
  the pull request which behavior changed and how you saw it.
- After a change to the README or `docs/usage.md`, rerun `evals/docs-check` (its
  README says how) and read the failures.
- A change users will notice gets a `CHANGELOG.md` entry under `Unreleased`.
- Release steps (tag, publish, listings, announcement) follow `CONTRIBUTING.md`
  and need the maintainer's go-ahead.
- Run JavaScript and TypeScript with Bun. `scripts/build.ts` builds the server
  binary; restarting a running Swarmail unit to load it is the owner's step.
- Dependency versions are exact. Dependabot opens the updates, and the lockfile
  changes with them.
