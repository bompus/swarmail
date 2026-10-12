# Docs behavior check

Do agents act as the README and `docs/usage.md` intend? Each case gives a model
the document under test, a short situation and the tool list, and asks for text
with `TOOL_CALL:` lines where it would act. `grade.ts` scores every reply with
regular expressions; no model judges.

| Case       | Document        | Required checks                                                                                                                                                   |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`  | README          | clone, `bun install`, `scripts/enable.sh`, then configure-mcp, then configure-hooks; no sudo, global installs or invented flags                                   |
| `evaluate` | README          | the README's read-only evaluation installs and edits nothing                                                                                                      |
| `notify`   | `docs/usage.md` | registers with `human_key` for the right project, reads the roster, names a recipient, mails before editing a shared checkout                                     |
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
   bun evals/docs-check/build-prompts.ts --tree . --arm current --out <dir>/prompts --tools evals/docs-check/tools.json
   ```

2. Send each prompt file to the models you want to test, asking for text only,
   and save every reply as `<model>-<case>-<arm>-r<run>.txt` in one directory.
   Three runs per model and case show the spread. This repository does not
   include a runner; any agent or API that returns text will do.
3. Grade the replies:

   ```bash
   bun evals/docs-check/grade.ts <dir>/replies
   ```

   A cell passes when every required check passes.

## Limits

The checks are regular expressions over what a model says it would run, not
over what it runs. A pass shows the document led the model to the intended
commands in one scripted situation; it does not show an agent will behave that
way in a live session. Small samples (three runs per cell) can hide a failure
that happens one time in ten.
