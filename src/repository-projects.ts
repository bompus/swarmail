// Projects named by repository (git:host/owner/repo), the key sessions on another machine file mail under. A hub
// holding a clone of that repository answers with the project for its checkout.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { REPOSITORY_PREFIX, repositoryKey } from "./checkout.ts";
import type { Project } from "./store.ts";

/**
 * The project for a repository name: the checkout of that repository this machine holds (the earliest project when it
 * holds several), remembered once found. Null when it holds none, or `name` is not a repository name.
 */
export function projectOfRepository(db: Database, name: string): Project | null {
  if (!name.startsWith(REPOSITORY_PREFIX)) {
    return null;
  }
  const aliased = db
    .query<Project, [string]>(
      "SELECT p.* FROM project_aliases a JOIN projects p ON p.id = a.project_id WHERE a.alias = ?",
    )
    .get(name);
  if (aliased) {
    return aliased;
  }
  for (const candidate of db.query<Project, []>("SELECT * FROM projects ORDER BY id").all()) {
    if (
      isAbsolute(candidate.human_key) &&
      existsSync(candidate.human_key) &&
      repositoryKey(candidate.human_key) === name
    ) {
      db.run("INSERT OR IGNORE INTO project_aliases (alias, project_id) VALUES (?, ?)", [
        name,
        candidate.id,
      ]);
      return candidate;
    }
  }
  return null;
}

/**
 * Sessions on another machine may have filed a repository under its name before this machine met a checkout of it.
 * That project becomes the checkout's, so both machines share one; null when no project is waiting.
 */
export function claimRepositoryProject(db: Database, checkout: string): Project | null {
  const name = isAbsolute(checkout) && existsSync(checkout) ? repositoryKey(checkout) : null;
  const waiting = name
    ? db.query<Project, [string]>("SELECT * FROM projects WHERE human_key = ?").get(name)
    : null;
  if (!name || !waiting) {
    return null;
  }
  db.run("INSERT OR IGNORE INTO project_aliases (alias, project_id) VALUES (?, ?)", [
    name,
    waiting.id,
  ]);
  return db
    .query<Project, [string, number]>("UPDATE projects SET human_key = ? WHERE id = ? RETURNING *")
    .get(checkout, waiting.id);
}
