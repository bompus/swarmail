import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    "https://user:token@GitHub.com/Bompus/SwarmAil",
    "git@github.com:bompus/swarmail.git",
    "ssh://git@github.com:22/bompus/swarmail/",
    "git://github.com/bompus/swarmail.git",
  ];
  for (const url of same) {
    expect(repositoryName(url)).toBe("git:github.com/bompus/swarmail");
  }
  expect(repositoryName("https://github.com/bompus/other")).toBe("git:github.com/bompus/other");
  // IPv6 hosts keep their brackets in every spelling; a one-letter host is a host, not a drive.
  expect(repositoryName("git@[2001:db8::1]:team/repo.git")).toBe("git:[2001:db8::1]/team/repo");
  expect(repositoryName("ssh://git@[2001:db8::1]/team/repo.git")).toBe(
    "git:[2001:db8::1]/team/repo",
  );
  expect(repositoryName("git@a:team/repo.git")).toBe("git:a/team/repo");
  // git sends a URL's escapes decoded, so both spellings reach one repository.
  expect(repositoryName("ssh://git@git.example.com/team/my%20repo.git")).toBe(
    repositoryName("git@git.example.com:/team/my repo.git"),
  );
  expect(repositoryName("https://git.example.com/team/100%.git")).toBe(
    "git:git.example.com/team/100%",
  );
  // A literal # or ? in an ssh path is part of the path git sends, so it keeps repositories apart.
  expect(repositoryName("ssh://git@git.example.com/acme/repo#one.git")).not.toBe(
    repositoryName("ssh://git@git.example.com/acme/repo#two.git"),
  );
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
    expect(pruneGoneProjects(db, { home: realpathSync.native(dir) })).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM project_aliases").get()).toEqual({ n: 0 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key follows the URL git uses, so a rewritten remote names the repository it reaches", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  try {
    const clone = repo(dir, "clone", "https://github.com/bompus/swarmail");
    Bun.spawnSync([
      "git",
      "-C",
      clone,
      "config",
      "url.https://git.example.com/.insteadOf",
      "https://github.com/",
    ]);
    expect(repositoryKey(clone)).toBe("git:git.example.com/bompus/swarmail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repositories whose names differ only in punctuation stay separate projects", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project",
      (a: Args) => any
    >;
    const dashed = tools.ensure_project({ human_key: "git:github.com/acme/foo-bar" });
    const underscored = tools.ensure_project({ human_key: "git:github.com/acme/foo_bar" });
    expect(underscored.id).not.toBe(dashed.id);
    expect(tools.ensure_project({ human_key: "git:github.com/acme/foo-bar" }).id).toBe(dashed.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a remembered checkout stops answering for a repository its origin no longer names", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project",
      (a: Args) => any
    >;
    const a = "git:github.com/acme/a";
    const b = "git:github.com/acme/b";
    const hub = repo(dir, "hub", "https://github.com/acme/a");
    const project = tools.ensure_project({ human_key: hub });
    expect(tools.ensure_project({ human_key: a }).id).toBe(project.id);
    Bun.spawnSync(["git", "-C", hub, "remote", "set-url", "origin", "https://github.com/acme/b"]);
    // The clone now holds b; a has no checkout here, so it gets its own project.
    expect(tools.ensure_project({ human_key: b }).id).toBe(project.id);
    const separate = tools.ensure_project({ human_key: a });
    expect(separate.id).not.toBe(project.id);
    expect(separate.human_key).toBe(a);
    // The project the checkout adopted keeps the name's slug; removing the checkout still lets the name get a project.
    rmSync(hub, { recursive: true });
    expect(tools.ensure_project({ human_key: a }).id).toBe(separate.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository's mailbox survives its hub checkout being away for a while", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project",
      (a: Args) => any
    >;
    const name = "git:github.com/acme/a";
    const hub = repo(dir, "hub", "https://github.com/acme/a");
    const project = tools.ensure_project({ human_key: hub });
    expect(tools.ensure_project({ human_key: name }).id).toBe(project.id);
    rmSync(hub, { recursive: true });
    // Another remote session arrives while the checkout is away; it joins the same mailbox, not a second one.
    expect(tools.ensure_project({ human_key: name }).id).toBe(project.id);
    repo(dir, "hub", "https://github.com/acme/a");
    expect(tools.ensure_project({ human_key: hub }).id).toBe(project.id);
    expect(tools.ensure_project({ human_key: name }).id).toBe(project.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looking a repository up reads only; registering remembers the checkout; an unreadable origin forgets nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project" | "list_agents",
      (a: Args) => any
    >;
    const name = "git:github.com/acme/a";
    const hub = repo(dir, "hub", "https://github.com/acme/a");
    const project = tools.ensure_project({ human_key: hub });
    const aliases = () => (db.query("SELECT COUNT(*) AS n FROM project_aliases").get() as any).n;
    const changes = () => (db.query("SELECT total_changes() AS n").get() as any).n;
    const before = changes();
    expect(tools.list_agents({ project_key: name })).toEqual([]);
    expect(aliases()).toBe(0);
    expect(changes()).toBe(before);
    expect(tools.ensure_project({ human_key: name }).id).toBe(project.id);
    expect(aliases()).toBe(1);
    // Git cannot read the clone's configuration for a moment: the mailbox stays where it was.
    writeFileSync(join(hub, ".git", "config"), "[broken\n");
    expect(tools.ensure_project({ human_key: name }).id).toBe(project.id);
    expect(aliases()).toBe(1);
    // Origin set to a path on this machine: the clone no longer names the repository.
    writeFileSync(
      join(hub, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = /srv/git/other.git\n',
    );
    expect(tools.ensure_project({ human_key: name }).id).not.toBe(project.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session cannot take a retired session's name by asking for it", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "register_agent" | "retire_agent",
      (a: Args) => any
    >;
    const project_key = "git:github.com/acme/a";
    const register = (tag: string, name?: string) =>
      tools.register_agent({
        project_key,
        name,
        program: "test",
        model: "test",
        task_description: `${tag} work`,
      });
    const hub = register("[codex:hub-session]");
    tools.retire_agent({ project_key, agent_name: hub.name });
    expect(() => register("[claude:laptop-session]", hub.name)).toThrow("retired session");
    // The session itself, and a request for a fresh name, still work.
    expect(register("[codex:hub-session]", hub.name).name).toBe(hub.name);
    expect(register("[claude:laptop-session]").name).not.toBe(hub.name);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name whose project a checkout adopted still gets its own project after the checkout moves on", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-key-"));
  const db = openDatabase(join(dir, "mail.sqlite"));
  try {
    const tools = createTools(db, { databasePath: join(dir, "mail.sqlite") }) as Record<
      "ensure_project",
      (a: Args) => any
    >;
    const a = "git:github.com/acme/a";
    const waiting = tools.ensure_project({ human_key: a });
    const hub = repo(dir, "hub", "https://github.com/acme/a");
    expect(tools.ensure_project({ human_key: hub }).id).toBe(waiting.id);
    Bun.spawnSync(["git", "-C", hub, "remote", "set-url", "origin", "https://github.com/acme/b"]);
    const second = tools.ensure_project({ human_key: a });
    expect(second.id).not.toBe(waiting.id);
    expect(second.human_key).toBe(a);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
