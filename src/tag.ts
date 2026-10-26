// The session tag that leads a roster task description, e.g. `[t3:<thread> claude:<session> build:<hash> cwd:~/repo]`.
// The register hook writes it; wake routing, `who` and re-registration read it.
import { homeDir, tildePath } from "./paths.ts";
import { buildSource } from "./build.ts";

export interface Tag {
  t3: string | null;
  host: string | null;
  sessionId: string | null;
  build: string | null;
  branch: string | null;
  title: string | null;
  worktree: string | null;
  cwd: string | null;
}

/** Shell variables carrying native session IDs; hosts without one use registration process identity. */
export const SESSION_ENV: Record<string, string> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  cursor: "CURSOR_CONVERSATION_ID",
  grok: "GROK_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
};

/** Longest title a tag carries, so a long one does not bloat every task description. */
const TITLE_LENGTH = 120;

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * The roster tag naming the session and where it runs, e.g.
 * `[t3:<thread id> claude:<session id> build:<hash> cwd:~/src/repo-task]`. The project key is
 * always the primary checkout; cwd names the launch directory, while the edit checkout is recorded
 * separately. `build` is the source hash of the swarmail binary that registered it, so `who` can name
 * a session whose binary is stale; cwd stays last because a path may hold spaces. A session on another machine
 * adds `branch:<name>` and `title:<percent-encoded title>`, because the server cannot read either from there.
 */
export function sessionTag(
  {
    t3,
    host,
    sessionId,
    build = buildSource,
    branch,
    title,
    worktree,
  }: {
    t3?: string | null;
    host: string;
    sessionId?: string | null;
    build?: string | null;
    branch?: string | null;
    title?: string | null;
    worktree?: string | null;
  },
  cwd: unknown,
  home = homeDir(),
): string {
  const parts = t3 ? [`t3:${t3}`] : [];
  parts.push(sessionId ? `${host}:${sessionId}` : host);
  if (build) {
    parts.push(`build:${build}`);
  }
  if (branch) {
    parts.push(`branch:${encodeURIComponent(branch)}`);
  }
  if (title) {
    // By code point, so a long title never ends in half a character, which cannot be encoded.
    const kept = Array.from(title.toWellFormed()).slice(0, TITLE_LENGTH).join("");
    parts.push(`title:${encodeURIComponent(kept)}`);
  }
  if (worktree) {
    parts.push(`worktree:${encodeURIComponent(tildePath(home, worktree))}`);
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
  const out: Tag = {
    t3: null,
    host: null,
    sessionId: null,
    build: null,
    branch: null,
    title: null,
    worktree: null,
    cwd: null,
  };
  const cwd = /(?:^| )cwd:(.*)$/s.exec(tag);
  out.cwd = cwd?.[1] ?? null;
  for (const part of (cwd ? tag.slice(0, cwd.index) : tag).split(" ")) {
    const [key, ...rest] = part.split(":");
    const value = rest.join(":");
    if (key === "t3") {
      out.t3 = value;
    } else if (key === "build") {
      out.build = value;
    } else if (key === "branch") {
      out.branch = decoded(value);
    } else if (key === "title") {
      out.title = decoded(value);
    } else if (key === "worktree") {
      out.worktree = decoded(value);
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

/**
 * Why registering as `id` may not replace the agent `row`, or null when it may: the row is bound to another lifecycle
 * identity, or `named` asks for the name of a retired session that `id` is not.
 */
export function replaceRefusal(
  row: Identity & {
    retired_at: number | null;
    lifecycle_profile: string | null;
    lifecycle_thread: string | null;
  },
  id: Identity,
  named: boolean,
): string | null {
  if (
    row.lifecycle_profile &&
    (row.t3_thread
      ? row.lifecycle_thread !== id.t3_thread
      : id.t3_thread
        ? row.lifecycle_thread !== id.t3_thread
        : row.host !== id.host || row.session_id !== id.session_id)
  ) {
    return "Registration cannot replace a bound lifecycle identity.";
  }
  const retired = row.retired_at != null && !!(row.session_id || row.t3_thread);
  return named && retired && !sameSession(tagOf(row), tagOf(id))
    ? "That name belongs to a retired session; omit the name to get a new one."
    : null;
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
  branch: null,
  title: null,
  worktree: null,
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

/** The tag without the details only a hook on the session's own machine can read, for comparing registrations. */
export const withoutDetails = (tag: string): string =>
  tag.replace(/ (?:branch|title|worktree):[^ \]]*/g, "");

/**
 * `bare`, the tag a scan of the session's own record builds, with the branch, title and edit checkout of `known`, the
 * tag a hook registered, when both name the same session; otherwise `bare`. The builds and launch directories may differ, and
 * the scan may add the T3 thread a hook could not resolve.
 */
export function withDetailsOf(bare: string, known: string | undefined): string {
  const a = parseTag(bare);
  const b = parseTag(known);
  const bareAt = bare.indexOf(" cwd:");
  const knownAt = known?.indexOf(" cwd:") ?? -1;
  if (!a || !b || bareAt < 0 || knownAt < 0 || !sameSession(a, b)) {
    return bare;
  }
  // The launch path ends the tag and may hold anything, so only what precedes it holds details.
  const details = (
    known?.slice(0, knownAt).match(/ (?:branch|title|worktree):[^ \]]*/g) ?? []
  ).join("");
  return `${bare.slice(0, bareAt)}${details}${bare.slice(bareAt)}`;
}
