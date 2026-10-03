// The session tag that leads a roster task description, e.g. `[t3:<thread> claude:<session> build:<hash> cwd:~/repo]`.
// The register hook writes it; wake routing, `who` and re-registration read it.
import { homedir } from "node:os";
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
  home = homedir(),
): string {
  const parts = t3 ? [`t3:${t3}`] : [];
  parts.push(sessionId ? `${host}:${sessionId}` : host);
  if (build) {
    parts.push(`build:${build}`);
  }
  if (typeof cwd === "string" && cwd) {
    parts.push(
      `cwd:${cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd}`,
    );
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

/** Matches a description whose tag names `sessionId`, as `<host>:<sessionId>`. */
export const sessionMarker = (sessionId: string): RegExp =>
  new RegExp(`^\\[[^\\]]*:${sessionId}[ \\]]`);
