// How a project key finds its project. The key is the exact path, except where the file system or the writer makes
// two spellings one place: a trailing separator, and, for Windows paths, case and slash direction.
import type { Database } from "bun:sqlite";
import type { Project } from "./store.ts";

// A drive path (`C:\Repo`, `c:/repo`) or a share (`\\server\share`). Elsewhere `\` is an ordinary file name character.
const WINDOWS = /^([A-Za-z]:[\\/]|\\\\)/;

/**
 * How a Windows path is compared: Windows ignores case and slash direction, so `C:\Repo` and `c:/repo` are one
 * checkout. Any other key compares exactly (null), because on Linux `/work/Repo` and `/work/repo` are two directories.
 */
export const windowsKey = (key: string): string | null =>
  WINDOWS.test(key)
    ? key
        .replace(/\\/g, "/")
        .toLowerCase()
        .replace(/(?<=.)\/+$/, "")
    : null;

/** A project key without trailing separators (`/work/repo/` is `/work/repo`), except for a root such as `/` or `C:\`. */
export const trimKey = (key: string): string => {
  if (/^([A-Za-z]:)?[\\/]*$/.test(key)) {
    return key;
  }
  return key.replace(WINDOWS.test(key) ? /[\\/]+$/ : /\/+$/, "");
};

/**
 * The project stored under `key` (an earlier build may have stored it with trailing slashes), else, for a Windows
 * path, the earliest project stored under a spelling Windows treats as the same. The table is small, so the
 * Windows comparison runs here, where case folding covers every letter, not in SQL, where `lower()` covers ASCII.
 */
export function findProject(db: Database, key: string): Project | null {
  const exact = db
    .query<Project, [string]>(
      "SELECT * FROM projects WHERE human_key = ?1 OR rtrim(human_key, '/') = ?1 ORDER BY id LIMIT 1",
    )
    .get(key);
  const wanted = windowsKey(key);
  if (exact || wanted === null) {
    return exact;
  }
  return (
    db
      .query<Project, []>(
        "SELECT * FROM projects WHERE human_key GLOB '[A-Za-z]:*' OR human_key GLOB '\\\\*' ORDER BY id",
      )
      .all()
      .find((p) => windowsKey(p.human_key) === wanted) ?? null
  );
}
