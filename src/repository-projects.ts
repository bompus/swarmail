// Projects named by repository (git:host/owner/repo), the key sessions on another machine file mail under. A hub
// holding a clone of that repository answers with the project for its checkout. Import it as a namespace, as `repositories`.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { REPOSITORY_PREFIX, repositoryKey } from "./checkout.ts";
import { nowUs } from "./db.ts";
import type { Project } from "./store.ts";

export const isName = (key: string): boolean => key.startsWith(REPOSITORY_PREFIX);

const remember = (db: Database, name: string, project: Project): void => {
  db.run("INSERT OR REPLACE INTO project_aliases (alias, project_id) VALUES (?, ?)", [
    name,
    project.id,
  ]);
};

/**
 * The project for a repository name: the checkout of that repository this machine holds (the earliest project when
 * it holds several), remembered once found. Null when it holds none. A remembered checkout counts only while its
 * origin still names the repository.
 */
export function projectOf(db: Database, name: string): Project | null {
  const holds = (project: Project): boolean =>
    isAbsolute(project.human_key) &&
    existsSync(project.human_key) &&
    repositoryKey(project.human_key) === name;
  const aliased = db
    .query<Project, [string]>(
      "SELECT p.* FROM project_aliases a JOIN projects p ON p.id = a.project_id WHERE a.alias = ?",
    )
    .get(name);
  if (aliased && holds(aliased)) {
    return aliased;
  }
  db.run("DELETE FROM project_aliases WHERE alias = ?", [name]);
  const waiting = db
    .query<Project, [string]>("SELECT * FROM projects WHERE human_key = ?")
    .get(name);
  if (waiting) {
    return waiting;
  }
  const clone = db.query<Project, []>("SELECT * FROM projects ORDER BY id").all().find(holds);
  if (clone) {
    remember(db, name, clone);
  }
  return clone ?? null;
}

/**
 * The project a key creates when no project has it yet. For a repository name, a new project whose slug cannot collide
 * with another repository's. For a checkout, the project that sessions on another machine created for its repository
 * before this machine met the checkout, which becomes the checkout's so both machines share one. Null otherwise.
 */
export function claim(db: Database, key: string): Project | null {
  if (isName(key)) {
    const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
    const slug = `${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${hash}`;
    return db
      .query<Project, [string, string, number]>(
        "INSERT INTO projects (slug, human_key, created_at) VALUES (?, ?, ?) RETURNING *",
      )
      .get(slug, key, nowUs());
  }
  const name = isAbsolute(key) && existsSync(key) ? repositoryKey(key) : null;
  const waiting = name
    ? db.query<Project, [string]>("SELECT * FROM projects WHERE human_key = ?").get(name)
    : null;
  if (!name || !waiting) {
    return null;
  }
  remember(db, name, waiting);
  return db
    .query<Project, [string, number]>("UPDATE projects SET human_key = ? WHERE id = ? RETURNING *")
    .get(key, waiting.id);
}
