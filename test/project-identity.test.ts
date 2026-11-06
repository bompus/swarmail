import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { MailStore } from "../src/store.ts";

const store = (db = openDatabase(":memory:")) => new MailStore(db);

test("project keys that slugify alike stay separate projects", () => {
  const s = store();
  const first = s.ensureProject("/work/my_app");
  const second = s.ensureProject("/work/my-app");
  const third = s.ensureProject("/work-my/app");
  expect(second.human_key).toBe("/work/my-app");
  expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  expect(new Set([first.slug, second.slug, third.slug]).size).toBe(3);
  // Each key keeps finding its own project, and a slug is not a key.
  expect(s.ensureProject("/work/my_app").id).toBe(first.id);
  expect(s.ensureProject("/work/my-app").id).toBe(second.id);
  expect(s.project("/work/my-app").id).toBe(second.id);
  expect(() => s.project(first.slug)).toThrow("not found");
});

test("two projects that slugify alike each register their own agent of one name", () => {
  const s = store();
  const a = s.ensureProject("/work/my_app");
  const b = s.ensureProject("/work/my-app");
  const agent = (project: typeof a) =>
    s.register(project, { program: "claude-code", model: "m", name: "BlueLake" });
  expect(agent(a).project_id).toBe(a.id);
  expect(agent(b).project_id).toBe(b.id);
});

test("a Windows drive path is one project however its case and slashes are written", () => {
  const s = store();
  const first = s.ensureProject("C:\\Work\\Repo");
  expect(s.ensureProject("c:/work/repo").id).toBe(first.id);
  expect(s.project("C:/WORK/repo").id).toBe(first.id);
  expect(s.ensureProject("C:\\Work\\Repo2").id).not.toBe(first.id);
  // Elsewhere a different case is a different directory.
  expect(s.ensureProject("/work/Repo").id).not.toBe(s.ensureProject("/work/repo").id);
});

test("a trailing separator on a project key names the same project", () => {
  const db = openDatabase(":memory:");
  const s = store(db);
  const repo = s.ensureProject("/work/repo");
  expect(s.ensureProject("/work/repo/").id).toBe(repo.id);
  expect(s.project("/work/repo//").id).toBe(repo.id);
  const win = s.ensureProject("C:\\Work\\Repo\\");
  expect(win.human_key).toBe("C:\\Work\\Repo");
  expect(s.ensureProject("c:/work/repo").id).toBe(win.id);
  // A key stored with its slash by an earlier build is still found.
  db.run("INSERT INTO projects (slug, human_key, created_at) VALUES ('old', '/old/repo/', 1)");
  expect(s.ensureProject("/old/repo").slug).toBe("old");
  expect(s.ensureProject("/old/repo/").slug).toBe("old");
  expect(s.ensureProject("/").human_key).toBe("/");
});

test("a trailing backslash is part of a POSIX name, and a Windows share compares like a drive", () => {
  const s = store();
  expect(s.ensureProject("/work/repo\\").id).not.toBe(s.ensureProject("/work/repo").id);
  const share = s.ensureProject("\\\\Server\\Share\\Repo");
  expect(s.ensureProject("\\\\server\\share\\repo\\").id).toBe(share.id);
  expect(s.ensureProject("//server/share/repo").id).not.toBe(share.id);
});

test("a Windows path compares letters beyond ASCII without regard to case", () => {
  const s = store();
  const first = s.ensureProject("C:/CAFÉ/Repo");
  expect(s.ensureProject("c:/café/repo").id).toBe(first.id);
  expect(s.ensureProject("c:/cafe/repo").id).not.toBe(first.id);
});

test("a key an earlier build stored with several trailing slashes is still found", () => {
  const db = openDatabase(":memory:");
  const s = store(db);
  db.run("INSERT INTO projects (slug, human_key, created_at) VALUES ('old', '/old/repo//', 1)");
  for (const key of ["/old/repo//", "/old/repo/", "/old/repo"]) {
    expect(s.ensureProject(key).slug).toBe("old");
  }
});
