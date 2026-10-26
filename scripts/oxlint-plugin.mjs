// Shared oxlint rules for this owner's repositories. Load it from .oxlintrc.json with
// `"jsPlugins": ["./scripts/oxlint-plugin.mjs"]`.
// The reason rule follows the idea of require-description-when-disabling in cloudflare/workers-sdk
// (MIT OR Apache-2.0).

/** @typedef {{ line: number; column: number }} Position */
/** @typedef {{ start: Position; end: Position }} Location */
/** @typedef {{ value: string; loc: Location }} Comment */
/**
 * @typedef {object} Context
 * @property {{ getAllComments(): Comment[] }} sourceCode
 * @property {(report: { loc: Location; message: string }) => void} report
 */

// `enable` comments are left out: they end a suppression instead of starting one.
const DISABLE_DIRECTIVE = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=\s|$)/u;

/**
 * A reason is any non-blank text after the first `--`.
 * @param {string} text
 */
function hasReason(text) {
  const separator = text.indexOf("--");
  return separator !== -1 && text.slice(separator + 2).trim() !== "";
}

export default {
  meta: { name: "bompus" },
  rules: {
    "require-disable-reason": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Require a reason after `--` in every eslint-disable and oxlint-disable comment",
        },
        schema: [],
      },
      /** @param {Context} context */
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (DISABLE_DIRECTIVE.test(comment.value) && !hasReason(comment.value)) {
                context.report({
                  loc: comment.loc,
                  message:
                    "Add the reason this rule is disabled after ` -- `, as in `oxlint-disable-next-line rule-name -- reason`.",
                });
              }
            }
          },
        };
      },
    },
  },
};
