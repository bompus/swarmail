// The session tag that leads a roster task description, e.g. `[t3:<thread> claude:<session> build:<hash> cwd:~/repo]`.
// The register hook writes it; wake routing, `who` and re-registration read it.
import { homeDir, tildePath } from "./paths.ts";
import { buildSource } from "./build.ts";

export interface Tag {
  t3: string | null;
  host: string | null;
  sessionId: string | null;
  build: string | null;
  cwd: string | null;
}

/**
 * The roster tag naming the session and where it runs, e.g.
 * `[t3:<thread id> claude:<session id> build:<hash> cwd:~/src/repo-task]`. The project key is
 * always the primary checkout, so this is the only place a peer can see which session and worktree an
 * agent is. `build` is the source hash of the swarmail binary that registered it, so `who` can name a
 * session whose binary is stale; cwd stays last because a path may hold spaces.
 */
export function sessionTag(
  {
    t3,
    host,
    sessionId,
    build = buildSource,
  }: { t3?: string | null; host: string; sessionId?: string | null; build?: string | null },
  cwd: unknown,
  home = homeDir(),
): string {
  const parts = t3 ? [`t3:${t3}`] : [];
  parts.push(sessionId ? `${host}:${sessionId}` : host);
  if (build) {
    parts.push(`build:${build}`);
  }
  if (typeof cwd === "string" && cwd) {
    parts.push(`cwd:${tildePath(home, cwd)}`);
  }
  return `[${parts.join(" ")}]`;
}

/** `[t3:<thread> <host>:<session> cwd:<path>]` at the start of a task description. */
export function parseTag(description: unknown): Tag | null {
  const tag = /^\[([^\]]*)\]/.exec(String(description ?? ""))?.[1];
  if (!tag) {
    return null;
  }
  const out: Tag = { t3: null, host: null, sessionId: null, build: null, cwd: null };
  const cwd = /(?:^| )cwd:(.*)$/s.exec(tag);
  out.cwd = cwd?.[1] ?? null;
  for (const part of (cwd ? tag.slice(0, cwd.index) : tag).split(" ")) {
    const [key, ...rest] = part.split(":");
    const value = rest.join(":");
    if (key === "t3") {
      out.t3 = value;
    } else if (key === "build") {
      out.build = value;
    } else if (!out.host) {
      Object.assign(out, { host: key, sessionId: value || null });
    }
  }
  return out;
}

/** A leading session tag; `[WIP]` and other bracketed prose have no `host:` part and are not tags. */
export const leadingTag = (text: string): string | undefined =>
  /^\[[^\]]*:[^\]]*\]/.exec(text)?.[0];

/** `text` without its leading bracket, tag or not. */
export const withoutTag = (text: unknown): string =>
  String(text ?? "").replace(/^\[[^\]]*\]\s*/, "");

/**
 * Whether two tags name one session: the same T3 thread when both have one, since a thread keeps
 * its identity when T3 starts a new provider session in it; otherwise the same `<host>:<session>`.
 */
export function sameSession(a: Tag | null, b: Tag | null): boolean {
  if (!a || !b) {
    return false;
  }
  if (a.t3 && b.t3) {
    return a.t3 === b.t3;
  }
  return !!a.sessionId && a.host === b.host && a.sessionId === b.sessionId;
}

/** The session columns of an `agents` row, parsed once from its description's leading tag; all null without one. */
export interface Identity {
  host: string | null;
  session_id: string | null;
  t3_thread: string | null;
  build: string | null;
  cwd: string | null;
}

export function identity(description: unknown): Identity {
  const tag = parseTag(leadingTag(String(description ?? "")));
  return {
    host: tag?.host ?? null,
    session_id: tag?.sessionId ?? null,
    t3_thread: tag?.t3 ?? null,
    build: tag?.build ?? null,
    cwd: tag?.cwd ?? null,
  };
}

/** The tag an `agents` row's columns describe. */
export const tagOf = (row: Identity): Tag => ({
  t3: row.t3_thread,
  host: row.host,
  sessionId: row.session_id,
  build: row.build,
  cwd: row.cwd,
});

/**
 * The row naming the same session as `tag` (sameSession), or null. A row tagged with the same T3 thread comes before
 * one matched by `<host>:<session>`; otherwise rows keep their order, which callers give most recently active first.
 * The server's re-registration and the register hook's name reuse both pick with this.
 */
export function sameSessionRow<T>(
  rows: T[],
  tag: Tag | null,
  read: (row: T) => Tag | null,
): T | null {
  const same = rows.filter((row) => sameSession(read(row), tag));
  return same.find((row) => !!tag?.t3 && read(row)?.t3 === tag.t3) ?? same[0] ?? null;
}
