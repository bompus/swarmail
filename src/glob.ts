// File-pattern semantics: `*` also matches across `/`.
// Bun.Glob's `**` only crosses `/` as a whole segment, so `src/*.ts` would miss `src/a/b.ts`.
const fnmatch = (pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&");
  try {
    return new RegExp(
      `^${escaped.replace(/\*+/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^")}$`,
      "s",
    );
  } catch {
    // An unclosed `[`: fnmatch then matches the pattern literally.
    return new RegExp(`^${escaped.replace(/[*?[\]]/g, "\\$&")}$`, "s");
  }
};

/** Whether `path` lies under `dir`, a directory written with or without its trailing `/`. */
const under = (dir: string, path: string) => path.startsWith(dir.replace(/\/+$/, "") + "/");

/**
 * Whether two reservation patterns (or a pattern and a path) can name the same file. A pattern
 * also covers everything under it as a directory, so `docs` and `docs/` both cover `docs/guide.md`.
 */
export const overlaps = (a: string, b: string) =>
  a === b || fnmatch(a).test(b) || fnmatch(b).test(a) || under(a, b) || under(b, a);
