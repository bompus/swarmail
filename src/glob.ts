// File-pattern semantics: `*` also matches across `/` and may match nothing, `?` matches one character, and
// `[abc]`, `[a-c]` and `[!abc]` match one character of a set. A `[` with no closing `]` is a literal `[`.
// A segment `**/` matches zero or more directories, so `src/**/x.ts` covers `src/x.ts`.
// Bun.Glob's `**` only crosses `/` as a whole segment, so `src/*.ts` would miss `src/a/b.ts`.

/** One step of a pattern: a star, or one character taken from a set. */
type Step =
  | { star: true; dirs: boolean }
  | { star: false; has: (c: string) => boolean; hints: string[]; only?: string };

// `only` is set when a step matches one character, which makes comparing it with another step a single test.
const literal = (c: string): Step => ({ star: false, has: (x) => x === c, hints: [c], only: c });
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
        step: {
          star: false,
          has: (c) => inside(c) !== negated,
          hints,
          only:
            !negated && ranges.length === 1 && ranges[0]![0] === ranges[0]![1]
              ? ranges[0]![0]
              : undefined,
        },
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
  // Once a `[` finds no `]`, no later `[` can either, so each unclosed one costs nothing to scan.
  let closes: boolean = true;
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
      const set: ReturnType<typeof charClass> = closes ? charClass(chars, i) : null;
      closes = set !== null;
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
  a.only !== undefined
    ? b.has(a.only)
    : b.only !== undefined
      ? a.has(b.only)
      : [...a.hints, ...b.hints, OTHER].some((c) => a.has(c) && b.has(c));

/**
 * Whether some string matches both patterns: a walk over states, at most one visit per state, so its cost is
 * the product of the two lengths. A state is a position in each pattern plus, for each, whether a star that
 * stands for a directory segment has taken a character, which ends its choice to match no directories.
 */
const intersect = (a: string, b: string): boolean => {
  const x = steps(a);
  const y = steps(b);
  // Both ends that no star can stretch must agree, which settles most unrelated pairs without the walk.
  for (const end of [0, -1]) {
    const p = x.at(end);
    const q = y.at(end);
    if (p && q && !p.star && !q.star && !share(p, q)) {
      return false;
    }
  }
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

/** `path` written as a pattern that matches only itself: each of `*`, `?`, `[` and `]` becomes a one-character set. */
const literally = (path: string) => path.replace(/[*?[\]]/g, (c) => `[${c}]`);

/** The longest reservation path accepted; the cost of comparing two patterns grows with the product of their lengths. */
export const MAX_PATH = 1024;

/** Whether `path` cannot be reserved: it is empty or blank, or longer than MAX_PATH. */
export const unreservable = (path: string) => path.trim() === "" || path.length > MAX_PATH;

/**
 * Whether two reservations can name the same file. Each is a pattern, and also the one file or directory it
 * spells, so `app/*slug*` and `app/[slug]` conflict. A reservation also covers everything under it as a
 * directory, so `docs` and `docs/` both cover `docs/guide.md`. An empty pattern names nothing, so it overlaps
 * only another empty one.
 */
export const overlaps = (a: string, b: string) =>
  a === "" || b === ""
    ? a === b
    : a === b ||
      intersect(a, b) ||
      (literally(b) !== b && intersect(a, literally(b))) ||
      (literally(a) !== a && intersect(literally(a), b)) ||
      under(a, b) ||
      under(b, a);

/**
 * Whether `reservation` covers `path`, a file a commit changed: unlike `overlaps`, `path` is that one name, so
 * its `[` or `*` are not pattern characters. A reservation inside `path` still counts, because a changed
 * submodule is reported as the directory it replaces.
 */
export const covers = (reservation: string, path: string) =>
  reservation !== "" &&
  (reservation === path ||
    intersect(reservation, literally(path)) ||
    under(reservation, path) ||
    under(path, reservation));
