import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testScratch } from "./fixtures/test-scratch.js";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";

function fixture(path = ":memory:") {
  const db = openDatabase(path);
  const tools = createTools(db, { databasePath: ":memory:" });
  const projects = ["/notice/one", "/notice/two"];
  for (const project_key of projects) {
    for (const name of ["BlueLake", "GreenCastle"]) {
      tools.register_agent({
        project_key,
        name,
        program: "codex",
        model: "test",
        task_description:
          name === "GreenCastle" ? "[t3:notice-thread codex:notice-session] receiver" : "sender",
      });
    }
  }
  let waiters = createWaiters(db);
  return {
    db,
    tools,
    projects,
    send: (project_key = projects[0], importance = "normal") =>
      tools.send_message({
        project_key,
        sender_name: "BlueLake",
        to: ["GreenCastle"],
        subject: "mail",
        body_md: "info",
        importance,
        ack_required: true,
      }),
    inbox: (args = {}) =>
      tools.fetch_session_inbox({
        host: "codex",
        session_id: "notice-session",
        t3_thread: "notice-thread",
        include_bodies: true,
        ...args,
      }),
    wait: async (after = 0, session = "notice-thread") => {
      const stop = new AbortController();
      const pending = waiters.wait(session, 60000, stop.signal, { retry: true, after });
      stop.abort();
      return await pending;
    },
    restart: () => {
      waiters = createWaiters(db);
    },
  };
}

test("one admitted notice covers later mail across repositories until the inbox drains", async () => {
  const f = fixture();
  try {
    f.send();
    const first = await f.wait();
    expect(first).not.toBeNull();
    f.send(f.projects[1], "urgent");
    expect(await f.wait(first.eventId)).toBeNull();
    expect(f.inbox({ mark_read: false })).toHaveLength(2);
    expect(await f.wait(first.eventId)).toBeNull();
    expect(f.inbox({ limit: 1 })).toHaveLength(1);
    f.restart();
    f.send(f.projects[1]);
    expect(await f.wait(first.eventId)).toBeNull();
    expect(f.inbox()).toHaveLength(2);
    expect(
      f.db.query("SELECT count(*) AS n FROM message_recipients WHERE ack_ts IS NOT NULL").get().n,
    ).toBe(0);
    const next = f.send();
    expect((await f.wait(first.eventId)).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

test("a lost offer retries its original event across restart even after newer mail", async () => {
  const f = fixture();
  try {
    const sent = f.send();
    expect((await f.wait()).eventId).toBe(sent.id);
    f.send(f.projects[1]);
    f.restart();
    expect((await f.wait()).eventId).toBe(sent.id);
    expect(await f.wait(sent.id)).toBeNull();
    expect(f.inbox({ mark_read: false })).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("late admission after a drain does not suppress the next unread episode", async () => {
  const f = fixture();
  try {
    f.send();
    const first = await f.wait();
    expect(f.inbox()).toHaveLength(1);
    const newer = f.send();
    const second = await f.wait();
    expect(second.eventId).toBe(newer.id);
    expect((await f.wait(first.eventId)).eventId).toBe(second.eventId);
    expect(await f.wait(second.eventId)).toBeNull();
    expect(f.inbox()).toHaveLength(1);
    expect(f.inbox()).toEqual([]);
    const latest = f.send();
    expect((await f.wait(second.eventId)).eventId).toBe(latest.id);
  } finally {
    f.db.close();
  }
});

for (const method of ["mark_message_read", "acknowledge_message", "fetch_inbox"]) {
  test(`${method} rearms only after every mailbox receipt is read`, async () => {
    const f = fixture();
    try {
      const first = f.send();
      const other = f.send(f.projects[1]);
      const offer = await f.wait();
      const read = (project_key, message_id) =>
        f.tools[method]({ project_key, agent_name: "GreenCastle", message_id, unread_only: true });
      read(f.projects[0], first.id);
      f.send();
      expect(await f.wait(offer.eventId)).toBeNull();
      read(f.projects[1], other.id);
      expect(await f.wait(offer.eventId)).toBeNull();
      f.inbox();
      const next = f.send();
      expect((await f.wait(offer.eventId)).eventId).toBe(next.id);
    } finally {
      f.db.close();
    }
  });
}

test("retirement preserves the unread episode and ping-only remainder does not keep it armed", async () => {
  const f = fixture();
  try {
    const original = f.send();
    const first = await f.wait();
    f.tools.retire_agent({ project_key: f.projects[0], agent_name: "GreenCastle" });
    const other = f.send(f.projects[1]);
    expect(await f.wait(first.eventId)).toBeNull();
    f.tools.send_message({
      project_key: f.projects[1],
      sender_name: "BlueLake",
      to: ["GreenCastle"],
      subject: "swarmail ping",
      body_md: "ping",
    });
    f.tools.mark_message_read({
      project_key: f.projects[0],
      agent_name: "GreenCastle",
      message_id: original.id,
    });
    f.tools.mark_message_read({
      project_key: f.projects[1],
      agent_name: "GreenCastle",
      message_id: other.id,
    });
    expect(f.inbox({ mark_read: false })).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS n FROM wake_notices").get().n).toBe(0);
    const next = f.send();
    expect((await f.wait(first.eventId)).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

for (const owner of ["notice-session", "notice-thread"]) {
  test(`linked identities share the notice first offered to ${owner}`, async () => {
    const f = fixture();
    const alternate = owner === "notice-session" ? "notice-thread" : "notice-session";
    try {
      f.send();
      const first = await f.wait(0, owner);
      expect(await f.wait(0, alternate)).toBeNull();
      expect(await f.wait(first.eventId, owner)).toBeNull();
      f.send(f.projects[1]);
      f.restart();
      expect(await f.wait(0, alternate)).toBeNull();
      expect(f.inbox({ limit: 1 })).toHaveLength(1);
      expect(await f.wait(0, alternate)).toBeNull();
      expect(f.inbox()).toHaveLength(1);
      const next = f.send();
      expect((await f.wait(0, alternate)).eventId).toBe(next.id);
      expect(await f.wait(first.eventId, owner)).toBeNull();
    } finally {
      f.db.close();
    }
  });
}

for (const admitted of [false, true]) {
  test(`released-v2 upgrade preserves an ${admitted ? "admitted" : "unconfirmed"} notice`, async () => {
    const dir = mkdtempSync(join(testScratch(), "case-"));
    const path = join(dir, "mail.sqlite");
    let f = fixture(path);
    try {
      const first = f.send();
      await f.wait();
      if (admitted) {
        await f.wait(first.id);
      }
      f.send(f.projects[1]);
      f.db.exec(`DROP TABLE wake_notices; DROP TABLE wake_notice_offers;
      DROP TABLE lifecycle_sources; DROP TABLE session_lifecycle;
      ALTER TABLE agents DROP COLUMN lifecycle_profile;
      ALTER TABLE agents DROP COLUMN lifecycle_thread;
      PRAGMA user_version = 2;`);
      f.db.close();
      f = fixture(path);
      const retry = await f.wait();
      if (admitted) {
        expect(retry).toBeNull();
      } else {
        expect(retry.eventId).toBe(first.id);
      }
      expect(await f.wait(0, "notice-session")).toBeNull();
      expect(f.inbox()).toHaveLength(2);
      const next = f.send();
      expect((await f.wait(first.id)).eventId).toBe(next.id);
    } finally {
      f.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a linked native mailbox keeps the original notice outstanding after its own mailbox drains", async () => {
  const f = fixture();
  try {
    f.tools.register_agent({
      project_key: f.projects[1],
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[t3:notice-thread codex:other-session] receiver",
    });
    const first = f.send();
    f.send(f.projects[1]);
    const notice = await f.wait(0, "notice-session");
    f.tools.mark_message_read({
      project_key: f.projects[0],
      agent_name: "GreenCastle",
      message_id: first.id,
    });
    expect(await f.wait(notice.eventId, "notice-session")).toBeNull();
    expect(await f.wait(0, "other-session")).toBeNull();
    expect(f.inbox()).toHaveLength(1);
    const next = f.send(f.projects[1]);
    expect((await f.wait(0, "other-session")).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

test("a released-v2 read notice does not suppress mail that arrived afterward", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    const first = f.send();
    await f.wait();
    await f.wait(first.id);
    f.inbox();
    const next = f.send();
    f.db.exec(`DROP TABLE wake_notices; DROP TABLE wake_notice_offers;
      DROP TABLE lifecycle_sources; DROP TABLE session_lifecycle;
      ALTER TABLE agents DROP COLUMN lifecycle_profile;
      ALTER TABLE agents DROP COLUMN lifecycle_thread;
      PRAGMA user_version = 2;`);
    f.db.close();
    f = fixture(path);
    expect((await f.wait(first.id)).eventId).toBe(next.id);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different providers with the same native ID keep their T3 notices independent", async () => {
  const f = fixture();
  try {
    for (const [project_key, program, thread] of [
      [f.projects[0], "codex", "first-thread"],
      [f.projects[1], "claude", "second-thread"],
    ]) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program,
        model: "test",
        task_description: `[t3:${thread} ${program}:shared-id] receiver`,
      });
    }
    const first = f.send();
    const second = f.send(f.projects[1]);
    expect(await f.wait(0, "shared-id")).toBeNull();
    expect((await f.wait(0, "first-thread")).eventId).toBe(first.id);
    expect((await f.wait(0, "second-thread")).eventId).toBe(second.id);
  } finally {
    f.db.close();
  }
});

test("adding a T3 tag in another repository preserves a standalone notice and its unread mailboxes", async () => {
  const f = fixture();
  try {
    for (const project_key of f.projects) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[codex:notice-session] receiver",
      });
    }
    const first = f.send();
    const notice = await f.wait(0, "notice-session");
    await f.wait(notice.eventId, "notice-session");
    const linkedProject = "/notice/three";
    for (const name of ["BlueLake", "GreenCastle"]) {
      f.tools.register_agent({
        project_key: linkedProject,
        name,
        program: "codex",
        model: "test",
        task_description:
          name === "GreenCastle" ? "[t3:notice-thread codex:notice-session] receiver" : "sender",
      });
    }
    const linked = f.send(linkedProject);
    f.tools.mark_message_read({
      project_key: linkedProject,
      agent_name: "GreenCastle",
      message_id: linked.id,
    });
    expect(await f.wait()).toBeNull();
    expect(f.inbox().map((message) => message.id)).toEqual([first.id]);
    const next = f.send(linkedProject);
    expect((await f.wait()).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

test("an admitted native notice survives provider replacement in the same T3 thread", async () => {
  const f = fixture();
  try {
    f.send();
    const first = await f.wait(0, "notice-session");
    expect(await f.wait(first.eventId, "notice-session")).toBeNull();
    for (const project_key of f.projects) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "claude",
        model: "test",
        task_description: "[t3:notice-thread claude:replacement-session] receiver",
      });
    }
    expect(await f.wait()).toBeNull();
    f.send(f.projects[1]);
    expect(await f.wait(0, "replacement-session")).toBeNull();
    expect(f.inbox()).toHaveLength(2);
    const next = f.send();
    expect((await f.wait()).eventId).toBe(next.id);
  } finally {
    f.db.close();
  }
});

test("reads and new mail written by a rolled-back binary do not retain a stale notice", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    const first = f.send();
    await f.wait();
    await f.wait(first.id);
    // Released builds update receipts and insert mail without maintaining wake_notices or lowering user_version.
    f.db.exec(`UPDATE message_recipients SET read_ts = created_ts + 1;
      INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts) SELECT project_id,sender_id,'new mail','info',created_ts+2 FROM messages WHERE id=${first.id};
      INSERT INTO message_recipients(message_id,agent_id,created_ts) SELECT last_insert_rowid(),agent_id,created_ts+2 FROM message_recipients WHERE message_id=${first.id};`);
    const next = f.db.query("SELECT max(id) AS id FROM messages").get();
    expect(f.db.query("PRAGMA user_version").get().user_version).toBe(4);
    f.db.close();
    f = fixture(path);
    const offer = await f.wait(first.id);
    expect(offer).not.toBeNull();
    expect(offer.eventId).toBe(next.id);
    expect(f.inbox()).toHaveLength(1);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unread mail written during rollback extends the original notice before a partial read", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    const first = f.send();
    await f.wait();
    await f.wait(first.id);
    f.db
      .exec(`INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts) SELECT project_id,sender_id,'new mail','info',created_ts+2 FROM messages WHERE id=${first.id};
      INSERT INTO message_recipients(message_id,agent_id,created_ts) SELECT last_insert_rowid(),agent_id,created_ts+2 FROM message_recipients WHERE message_id=${first.id};`);
    f.db.close();
    f = fixture(path);
    f.tools.mark_message_read({
      project_key: f.projects[0],
      agent_name: "GreenCastle",
      message_id: first.id,
    });
    expect(await f.wait(first.id)).toBeNull();
    expect(f.inbox()).toHaveLength(1);
    const next = f.send();
    expect((await f.wait(first.id)).eventId).toBe(next.id);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening repairs a standalone notice whose T3 tag was added by an older binary", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    for (const project_key of f.projects) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[codex:notice-session] receiver",
      });
    }
    f.send();
    const first = await f.wait(0, "notice-session");
    await f.wait(first.eventId, "notice-session");
    f.db
      .query("UPDATE agents SET task_description = ? WHERE name = 'GreenCastle'")
      .run("[t3:notice-thread codex:notice-session] receiver");
    f.db.close();
    f = fixture(path);
    expect(await f.wait()).toBeNull();
    expect(f.inbox()).toHaveLength(1);
    const next = f.send();
    expect((await f.wait()).eventId).toBe(next.id);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening the database retains an admitted notice until its unread mail is drained", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    f.send();
    const first = await f.wait();
    expect(await f.wait(first.eventId)).toBeNull();
    f.db.close();
    f = fixture(path);
    f.send(f.projects[1]);
    expect(await f.wait(first.eventId)).toBeNull();
    expect(f.inbox()).toHaveLength(2);
    const next = f.send();
    expect((await f.wait(first.eventId)).eventId).toBe(next.id);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding distinct T3 threads does not transfer an admitted native notice between them", async () => {
  const f = fixture();
  try {
    for (const project_key of f.projects) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[codex:notice-session] receiver",
      });
    }
    const first = f.send();
    const second = f.send(f.projects[1]);
    const notice = await f.wait(0, "notice-session");
    await f.wait(notice.eventId, "notice-session");
    for (const [project_key, thread] of [
      [f.projects[0], "first-thread"],
      [f.projects[1], "second-thread"],
    ]) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: `[t3:${thread} codex:notice-session] receiver`,
      });
    }
    expect(await f.wait(0, "notice-session")).toBeNull();
    expect(await f.wait(0, "first-thread")).toBeNull();
    expect((await f.wait(0, "second-thread")).eventId).toBe(second.id);
    expect(f.inbox({ t3_thread: "first-thread" }).map((message) => message.id)).toEqual([first.id]);
  } finally {
    f.db.close();
  }
});

for (const admitted of [false, true]) {
  test(`reopening v3 recovers a cursor-only ${admitted ? "admitted" : "uncertain"} older-build notice`, async () => {
    const dir = mkdtempSync(join(testScratch(), "case-"));
    const path = join(dir, "mail.sqlite");
    let f = fixture(path);
    try {
      const first = f.send();
      // Older binaries retain the current user_version and write only their released cursor fields.
      f.db
        .query("INSERT INTO wake_cursors(session, announced, offered) VALUES (?, ?, ?)")
        .run("notice-thread", admitted ? first.id : 0, admitted ? null : first.id);
      f.send(f.projects[1]);
      expect(f.db.query("SELECT count(*) AS n FROM wake_notices").get().n).toBe(0);
      f.db.close();
      f = fixture(path);
      const offer = await f.wait();
      if (admitted) {
        expect(offer).toBeNull();
      } else {
        expect(offer.eventId).toBe(first.id);
      }
      expect(await f.wait(0, "notice-session")).toBeNull();
      expect(f.inbox()).toHaveLength(2);
      const next = f.send();
      expect((await f.wait(first.id)).eventId).toBe(next.id);
    } finally {
      f.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("removing the final T3 tags lets the standalone identity receive unread mail", async () => {
  const f = fixture();
  try {
    const first = f.send();
    await f.wait();
    for (const project_key of f.projects) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[codex:notice-session] receiver",
      });
    }
    expect((await f.wait(0, "notice-session")).eventId).toBe(first.id);
    expect(f.inbox({ t3_thread: undefined }).map((message) => message.id)).toEqual([first.id]);
  } finally {
    f.db.close();
  }
});

test("removing a T3 tag does not move its notice into a competing thread", async () => {
  const f = fixture();
  try {
    f.send();
    const notice = await f.wait();
    await f.wait(notice.eventId);
    const second = f.send(f.projects[1]);
    f.tools.register_agent({
      project_key: f.projects[1],
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[t3:second-thread codex:notice-session] receiver",
    });
    f.tools.register_agent({
      project_key: f.projects[0],
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[codex:notice-session] receiver",
    });
    expect((await f.wait(0, "second-thread")).eventId).toBe(second.id);
    expect(f.inbox({ t3_thread: "second-thread" })).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("removing a T3 tag does not claim an ambiguous native owner", async () => {
  const f = fixture();
  try {
    f.send();
    const notice = await f.wait();
    await f.wait(notice.eventId);
    for (const [project_key, thread] of [
      [f.projects[1], "second-thread"],
      ["/notice/three", "third-thread"],
    ]) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: `[t3:${thread} codex:notice-session] receiver`,
      });
    }
    f.tools.register_agent({
      project_key: f.projects[0],
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[codex:notice-session] receiver",
    });
    expect(await f.wait(0, "notice-session")).toBeNull();
    expect(f.db.query("SELECT count(*) AS n FROM wake_notices").get().n).toBe(0);
    expect(f.inbox({ t3_thread: undefined })).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

for (const olderOffer of [false, true]) {
  test(`reopening ${olderOffer ? "recovers a new older-build offer after" : "does not transfer a known offer during"} a receiver change`, async () => {
    const dir = mkdtempSync(join(testScratch(), "case-"));
    const path = join(dir, "mail.sqlite");
    const f = fixture(path);
    let reopened;
    try {
      f.send();
      const notice = await f.wait(0, "notice-session");
      await f.wait(notice.eventId, "notice-session");
      f.tools.register_agent({
        project_key: f.projects[1],
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[t3:second-thread codex:notice-session] receiver",
      });
      f.tools.register_agent({
        project_key: f.projects[0],
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: "[codex:notice-session] receiver",
      });
      const second = f.send(f.projects[1]);
      if (olderOffer) {
        f.db
          .query("UPDATE wake_cursors SET offered = ? WHERE session = 'notice-session'")
          .run(second.id);
        f.send(f.projects[1]);
      }
      f.db.close();
      reopened = openDatabase(path);
      const waiters = createWaiters(reopened);
      const stop = new AbortController();
      const pending = waiters.wait(
        olderOffer ? "notice-session" : "second-thread",
        60000,
        stop.signal,
        { retry: true, after: 0 },
      );
      stop.abort();
      expect((await pending).eventId).toBe(second.id);
    } finally {
      (reopened ?? f.db).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("reopening clears a drained older notice before recovering a newer cursor-only offer", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  let f = fixture(path);
  try {
    const first = f.send();
    await f.wait();
    await f.wait(first.id);
    f.db.exec(`UPDATE message_recipients SET read_ts = created_ts + 1;
      INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts)
        SELECT project_id,sender_id,'new mail','info',created_ts+2 FROM messages WHERE id=${first.id};
      INSERT INTO message_recipients(message_id,agent_id,created_ts)
        SELECT last_insert_rowid(),agent_id,created_ts+2 FROM message_recipients WHERE message_id=${first.id};`);
    const second = f.db.query("SELECT max(id) AS id FROM messages").get();
    f.db
      .query("UPDATE wake_cursors SET offered = ? WHERE session = 'notice-thread'")
      .run(second.id);
    f.db.exec(`INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts)
        SELECT project_id,sender_id,'later mail','info',created_ts+3 FROM messages WHERE id=${first.id};
      INSERT INTO message_recipients(message_id,agent_id,created_ts)
        SELECT last_insert_rowid(),agent_id,created_ts+3 FROM message_recipients WHERE message_id=${first.id};`);
    f.db.close();
    f = fixture(path);
    expect((await f.wait(first.id)).eventId).toBe(second.id);
    expect(f.inbox()).toHaveLength(2);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening an ambiguous native cursor does not claim either T3 thread", async () => {
  const dir = mkdtempSync(join(testScratch(), "case-"));
  const path = join(dir, "mail.sqlite");
  const f = fixture(path);
  let reopened;
  try {
    for (const [project_key, thread] of [
      [f.projects[0], "first-thread"],
      [f.projects[1], "second-thread"],
    ]) {
      f.tools.register_agent({
        project_key,
        name: "GreenCastle",
        program: "codex",
        model: "test",
        task_description: `[t3:${thread} codex:notice-session] receiver`,
      });
    }
    const first = f.send();
    const second = f.send(f.projects[1]);
    f.db
      .query("INSERT INTO wake_cursors(session, announced, offered) VALUES (?, 0, ?)")
      .run("notice-session", second.id);
    f.db.close();
    reopened = openDatabase(path);
    const waiters = createWaiters(reopened);
    const wait = async (session) => {
      const stop = new AbortController();
      const pending = waiters.wait(session, 60000, stop.signal, { retry: true, after: 0 });
      stop.abort();
      return await pending;
    };
    expect(await wait("notice-session")).toBeNull();
    expect((await wait("first-thread")).eventId).toBe(first.id);
    expect((await wait("second-thread")).eventId).toBe(second.id);
  } finally {
    (reopened ?? f.db).close();
    rmSync(dir, { recursive: true, force: true });
  }
});
