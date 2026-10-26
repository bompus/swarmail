import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFor, repositoryKey, repositoryName } from "../src/checkout.ts";
import { openDatabase } from "../src/db.ts";
import { pruneGoneProjects } from "../src/server.ts";
import type { Args } from "../src/store.ts";
import { createTools } from "../src/tools.ts";

test("every clone and protocol of a repository names it the same", () => {
  const same = [
    "https://github.com/bompus/swarmail.git",
    "https://user:token@GitHub.com/bompus/swarmail",
    "git@github.com:bompus/swarmail.git",
    "ssh://git@github.com:22/bompus/swarmail/",
    "git://github.com/bompus/swarmail.git",
  ];
  for (const url of same) {
    expect(repositoryName(url)).toBe("git:github.com/bompus/swarmail");
  }
  expect(repositoryName("https://github.com/bompus/other")).toBe("git:github.com/bompus/other");
  // A path on this machine names no repository that another machine could share.
  for (const url of ["/srv/git/repo.git", "file:///srv/repo.git", "C:\\work\\repo", ""]) {
    expect(repositoryName(url)).toBeNull();
  }
});

function repo(dir: string, name: string, origin?: string): string {
  const path = join(dir, name);
  Bun.spawnSync(["git", "init", "-q", path]);
  if (origin) {
    Bun.spawnSync(["git", "-C", path, "remote", "add", "origin", origin]);
  }
  return realpathSync.native(path);
}

test("a remote server files mail under the repository name; this machine's server keeps the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  try {
    const clone = repo(dir, "clone", "git@github.com:bompus/swarmail.git");
    const bare = repo(dir, "bare");
    expect(repositoryKey(clone)).toBe("git:github.com/bompus/swarmail");
    expect(repositoryKey(bare)).toBeNull();
    expect(projectFor(clone, "http://100.64.0.1:18765/mcp/")).toBe(
      "git:github.com/bompus/swarmail",
    );
    expect(projectFor(clone, "http://127.0.0.1:18765/mcp/")).toBe(clone);
    // A clone without an origin cannot be named to a remote server, and says so instead of sending a path.
    expect(projectFor(bare, "http://100.64.0.1:18765/mcp/")).toBeNull();
    expect(projectFor(dir, "http://100.64.0.1:18765/mcp/")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository name reaches the checkout this machine holds, and a checkout taken later joins the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project" | "register_agent" | "send_message" | "fetch_inbox",
      (a: Args) => any
    >;
    const name = "git:github.com/bompus/swarmail";
    const hub = repo(dir, "hub", "https://github.com/bompus/swarmail.git");
    const local = tools.register_agent({
      project_key: hub,
      name: "BlueLake",
      program: "codex",
      model: "t",
    });
    // A laptop's session files under the name and lands in the hub's project.
    const remote = tools.register_agent({
      project_key: name,
      name: "RedPine",
      program: "claude-code",
      model: "t",
    });
    expect(remote.project_id).toBe(local.project_id);
    tools.send_message({
      project_key: name,
      sender_name: "RedPine",
      to: ["BlueLake"],
      subject: "hello",
      body_md: "from the laptop",
    });
    const inbox = tools.fetch_inbox({ project_key: hub, agent_name: "BlueLake" });
    expect(inbox.map((m: { subject: string }) => m.subject)).toEqual(["hello"]);
    expect(tools.ensure_project({ human_key: name }).human_key).toBe(hub);

    // With no checkout of a repository here, the name is the project, until a checkout appears.
    const other = "git:github.com/bompus/other";
    const first = tools.register_agent({
      project_key: other,
      name: "GreenHill",
      program: "claude-code",
      model: "t",
    });
    expect(tools.ensure_project({ human_key: other }).human_key).toBe(other);
    tools.send_message({
      project_key: other,
      sender_name: "GreenHill",
      to: ["GreenHill"],
      subject: "note",
      body_md: "to self",
    });
    const checkout = repo(dir, "other", "ssh://git@github.com/bompus/other.git");
    const taken = tools.ensure_project({ human_key: checkout });
    expect(taken.id).toBe(first.project_id);
    expect(taken.human_key).toBe(checkout);
    expect(tools.ensure_project({ human_key: other }).id).toBe(first.project_id);
    expect(db.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 2 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing a project removes the names that pointed at it", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project",
      (a: Args) => any
    >;
    const hub = repo(dir, "hub", "https://github.com/bompus/swarmail.git");
    tools.ensure_project({ human_key: hub });
    tools.ensure_project({ human_key: "git:github.com/bompus/swarmail" });
    expect(db.query("SELECT count(*) AS n FROM project_aliases").get()).toEqual({ n: 1 });
    rmSync(hub, { recursive: true });
    expect(pruneGoneProjects(db, { home: dir })).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM project_aliases").get()).toEqual({ n: 0 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
