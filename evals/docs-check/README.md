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

2026-10-12, on the README and `docs/usage.md` at `6e1c65c` (the 0.5.3 text plus
the plainer wording of #140), with `tools.json` taken from that source's
`tools/list`. Seven model seats, three runs each, 84 replies: every cell
passed all required checks.

| Case       | Cells passing |
| ---------- | ------------- |
| `install`  | 21 of 21      |
| `evaluate` | 21 of 21      |
| `notify`   | 21 of 21      |
| `inbox`    | 21 of 21      |

The first grading reported 81 of 84. The three failures were `notify` replies
that read the code with `git grep` before mailing; the grader counted `git grep`
as an edit. `git grep` is now read-only in `grade.ts`, and the grades of the
138 replies recorded in the earlier runs are unchanged by that fix.

Optional checks that some replies missed, none of which fail a cell:

- `inbox`: ten replies did not pause the migration before acknowledging, seven
  did not tell SilverPine why they would not push, and three did not
  acknowledge RedOak's request.
- `evaluate`: one reply did not clone and two did not check systemd.
