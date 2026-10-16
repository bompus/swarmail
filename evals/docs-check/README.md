# Docs behavior check

Do agents act as the README and `docs/usage.md` intend? Each case gives a model
the document under test, a short situation and the tool list, and asks for text
with `TOOL_CALL:` lines where it would act. `grade.ts` scores every reply with
regular expressions; no model judges.

| Case       | Document        | Required checks                                                                                                                                                   |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`  | README          | clone, `bun install` and `scripts/enable.sh` are run, in the order enable, configure-mcp, configure-hooks; no sudo, global installs or invented flags             |
| `evaluate` | README          | the README's read-only evaluation installs and edits nothing                                                                                                      |
| `notify`   | `docs/usage.md` | registers for the right project (`human_key` for `macro_start_session`), reads the roster, names a recipient, mails before editing a shared checkout              |
| `inbox`    | `docs/usage.md` | no reply to a thank-you (412), answers RedOak's `ack_required` pause request (413), no force push for SilverPine (414), never suspends the migration with SIGSTOP |

Optional checks are reported but don't fail a cell: `inbox` also records
whether the reply acknowledges 413, pauses before acknowledging and tells
SilverPine why it won't push.

Rerun it after editing the README or `docs/usage.md`, and before a release that
changed either (CONTRIBUTING.md, "Releasing").

## Running it

1. Build the prompts from a checkout of this repository. `tools.json` is the
   `tools/list` response the prompts embed; leave out `--tools` to ask a
   running server on `127.0.0.1:18765` instead. `--rules <file>` puts other
   rule text in place of `docs/usage.md`.

   ```bash
   bun evals/docs-check/build-prompts.ts --tree . --arm current --out docs-check-run/prompts --tools evals/docs-check/tools.json
   ```

2. Create `docs-check-run/replies`. Send each prompt file to the models you want to test, asking for text only,
   and save every reply as `<model>-<case>-<arm>-r<run>.txt` in `docs-check-run/replies`.
   The model and arm names take letters, digits and underscores only (no dots or
   hyphens).
   Three runs per model and case show the spread. This repository does not
   include a runner; any agent or API that returns text will do.
3. Grade the replies:

   ```bash
   bun evals/docs-check/grade.ts docs-check-run/replies
   ```

   A cell passes when every required check passes.

## Limits

The checks are regular expressions over what a model says it would run, not
over what it runs. A pass shows the document led the model to the intended
commands in one scripted situation; it does not show an agent will behave that
way in a live session. Small samples (three runs per cell) can hide a failure
that happens one time in ten. The grader reads each command as text. It does
not parse shell, so a command quoted inside `echo`, or a read chained to an
edit in one line, can be misjudged; it is a coarse screen, not a proof.

## Latest run

2026-10-16, 10:16 to 10:23 MDT, on the README and `docs/usage.md` of the 0.6.0
release as they stand in this repository, with a `tools.json` regenerated from
the release's own `tools/list` response: the descriptions of `send_message`,
`reply_message`, `whois`, `list_agents` and `fetch_inbox` differ from the 0.5.3
list. Seven model seats, three runs each, 84 replies: 82 passed all required
checks.

| Case       | Cells passing |
| ---------- | ------------- |
| `install`  | 20 of 21      |
| `evaluate` | 20 of 21      |
| `notify`   | 21 of 21      |
| `inbox`    | 21 of 21      |

Two replies failed:

- A `gpt6luna` `install` reply assumed `/home/dev` was already the checkout and
  skipped the `git clone`, which failed the clone check. This seat and case
  also failed on 2026-10-14 and in an earlier 2026-10-16 run on the same
  documents, the earlier two times on the enable step, so the seat is
  unreliable on this case.
- A `sonnet55` `evaluate` reply ended with a clone and install on a task that
  said read only. The same cell failed in 2 of 6 runs on the README of `main`
  and in 2 of 6 on a candidate that differed from this README only in one
  command-table row, against 1 of 3 here. The rates look similar, but these
  counts cannot rule out an effect of the 0.6.0 edits, and the README wording
  was not changed for it.

Optional checks are reported but don't fail a cell: `inbox` also records
whether the reply acknowledges 413, pauses before acknowledging and tells
SilverPine why it won't push.

Rerun it after editing the README or `docs/usage.md`, and before a release that
changed either (CONTRIBUTING.md, "Releasing").

## Running it

1. Build the prompts from a checkout of this repository. `tools.json` is the
   `tools/list` response the prompts embed; leave out `--tools` to ask a
   running server on `127.0.0.1:18765` instead. `--rules <file>` puts other
   rule text in place of `docs/usage.md`.

   ```bash
   bun evals/docs-check/build-prompts.ts --tree . --arm current --out docs-check-run/prompts --tools evals/docs-check/tools.json
   ```

2. Create `docs-check-run/replies`. Send each prompt file to the models you want to test, asking for text only,
   and save every reply as `<model>-<case>-<arm>-r<run>.txt` in `docs-check-run/replies`.
   The model and arm names take letters, digits and underscores only (no dots or
   hyphens).
   Three runs per model and case show the spread. This repository does not
   include a runner; any agent or API that returns text will do.
3. Grade the replies:

   ```bash
   bun evals/docs-check/grade.ts docs-check-run/replies
   ```

   A cell passes when every required check passes.

## Limits

The checks are regular expressions over what a model says it would run, not
over what it runs. A pass shows the document led the model to the intended
commands in one scripted situation; it does not show an agent will behave that
way in a live session. Small samples (three runs per cell) can hide a failure
that happens one time in ten. The grader reads each command as text. It does
not parse shell, so a command quoted inside `echo`, or a read chained to an
edit in one line, can be misjudged; it is a coarse screen, not a proof.

## Latest run

2026-10-16, 10:16 to 10:23 MDT, on the README and `docs/usage.md` of the 0.6.0
release as they stand in this repository, with a `tools.json` regenerated from
the release's own `tools/list` response: the descriptions of `send_message`,
`reply_message`, `whois`, `list_agents` and `fetch_inbox` differ from the 0.5.3
list. Seven model seats, three runs each, 84 replies: 82 passed all required
checks.

| Case       | Cells passing |
| ---------- | ------------- |
| `install`  | 20 of 21      |
| `evaluate` | 20 of 21      |
| `notify`   | 21 of 21      |
| `inbox`    | 21 of 21      |

Two replies failed:

- A `gpt6luna` `install` reply assumed `/home/dev` was already the checkout and
  skipped the `git clone`, which failed the clone check. This seat and case
  also failed on 2026-10-14 and in an earlier 2026-10-16 run on the same
  documents, each time for a different reason, so the seat is unreliable on
  this case. This reply is a one-off wording slip, not a missing instruction in
  the README.
- A `sonnet55` `evaluate` reply ended with a clone and install on a task that
  said read only. The same seat and case gave one such reply in each of three
  earlier sets of runs on the README of `main` and on a candidate that differed
  from this README only in one command-table row: 2 failures in 6 runs on
  `main`'s README, 2 in 6 on the candidate, and 1 in 3 on this one. The rates
  look similar, but these counts cannot rule out an effect of the 0.6.0 edits
  and the README wording was not changed for it.

Optional checks that some replies missed, none of which fail a cell:

- `inbox`: eight replies did not pause the migration before acknowledging and
  eight did not tell SilverPine why they would not push.
- `evaluate`: one reply did not read `docs/usage.md` and one did not check
  systemd.
