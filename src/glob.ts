// File-pattern semantics: `*` also matches across `/` and may match nothing, `?` matches one character, and
// `[abc]`, `[a-c]` and `[!abc]` match one character of a set. A `[` with no closing `]` is a literal `[`.
// A segment `**/` matches zero or more directories, so `src/**/x.ts` covers `src/x.ts`.
// Bun.Glob's `**` only crosses `/` as a whole segment, so `src/*.ts` would miss `src/a/b.ts`.

/** One step of a pattern: a star, or one character taken from a set. */
type Step =
  | { star: true; dirs: boolean }
  | { star: false; has: (c: string) => boolean; hints: string[] };

const literal = (c: string): Step => ({ star: false, has: (x) => x === c, hints: [c] });
const anyChar: Step = { star: false, has: () => true, hints: [] };

/** A character no pattern spells out, standing for "some other character" when two sets are compared. */
const OTHER = "\u{10ffff}";

/** The set at `chars[at]`, which is `[`, and the index after its `]`; null when it has no `]`. */
const charClass = (chars: string[], at: number): { step: Step; next: number } | null => {
  let i = at + 1;
  const negated = chars[i] === "!";
  if (negated) {
    i++;
  }
  const ranges: [string, string][] = [];
  for (let first = true; i < chars.length; first = false, i++) {
    if (chars[i] === "]" && !first) {
      const hints = ranges.flatMap(([lo, hi]) => [
        lo,
        hi,
        String.fromCodePoint(Math.max(0, lo.codePointAt(0)! - 1)),
        String.fromCodePoint(Math.min(0x10ffff, hi.codePointAt(0)! + 1)),
      ]);
      const inside = (c: string) => ranges.some(([lo, hi]) => lo <= c && c <= hi);
      return {
        step: { star: false, has: (c) => inside(c) !== negated, hints },
        next: i + 1,
      };
    }
    const lo = chars[i]!;
    const to = chars[i + 2];
    if (chars[i + 1] === "-" && to !== undefined && to !== "]") {
      ranges.push([lo, to]);
      i += 2;
    } else {
      ranges.push([lo, lo]);
    }
  }
  return null;
};

const steps = (pattern: string): Step[] => {
  const chars = Array.from(pattern);
  const out: Step[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") {
      let end = i;
      while (chars[end + 1] === "*") {
        end++;
      }
      // `**/` at the start of a segment: the star and its `/` may both be absent.
      out.push({
        star: true,
        dirs: end > i && chars[end + 1] === "/" && (i === 0 || chars[i - 1] === "/"),
      });
      i = end;
    } else if (c === "?") {
      out.push(anyChar);
    } else if (c === "[") {
      const set = charClass(chars, i);
      if (set) {
        out.push(set.step);
        i = set.next - 1;
      } else {
        out.push(literal(c));
      }
    } else {
      out.push(literal(c));
    }
  }
  return out;
};

/** Whether the two single-character steps share a character. */
const share = (a: Step & { star: false }, b: Step & { star: false }) =>
  [...a.hints, ...b.hints, OTHER].some((c) => a.has(c) && b.has(c));

/**
 * Whether some string matches both patterns: a walk over states, at most one visit per state, so its cost is
 * the product of the two lengths. A state is a position in each pattern plus, for each, whether a star that
 * stands for a directory segment has taken a character, which ends its choice to match no directories.
 */
const intersect = (a: string, b: string): boolean => {
  const x = steps(a);
  const y = steps(b);
  const seen = new Set<number>();
  const todo: [number, number, boolean, boolean][] = [[0, 0, false, false]];
  while (todo.length) {
    const [i, j, ateX, ateY] = todo.pop()!;
    const key = ((i * (y.length + 1) + j) * 2 + +ateX) * 2 + +ateY;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (i === x.length && j === y.length) {
      return true;
    }
    const p = x[i];
    const q = y[j];
    if (p?.star) {
      todo.push([i + 1, j, false, ateY]);
      if (p.dirs && !ateX) {
        todo.push([i + 2, j, false, ateY]);
      }
      if (q && !q.star) {
        todo.push([i, j + 1, true, false]);
      }
    }
    if (q?.star) {
      todo.push([i, j + 1, ateX, false]);
      if (q.dirs && !ateY) {
        todo.push([i, j + 2, ateX, false]);
      }
      if (p && !p.star) {
        todo.push([i + 1, j, false, true]);
      }
    }
    if (p && q && !p.star && !q.star && share(p, q)) {
      todo.push([i + 1, j + 1, false, false]);
    }
  }
  return false;
};

/**
 * Whether `path` lies under `dir`, a directory written with or without its trailing `/`. Compared as plain text,
 * so a directory named `app/[slug]` covers `app/[slug]/page.tsx`, and a pattern such as `*.md` is not read as one.
 */
const under = (dir: string, path: string) => path.startsWith(dir.replace(/\/+$/, "") + "/");

/**
 * Whether two reservations can name the same file. A reservation also covers everything under it as a
 * directory, so `docs` and `docs/` both cover `docs/guide.md`. An empty pattern names nothing, so it overlaps
 * only another empty one.
 */
export const overlaps = (a: string, b: string) =>
  a === "" || b === "" ? a === b : a === b || intersect(a, b) || under(a, b) || under(b, a);
