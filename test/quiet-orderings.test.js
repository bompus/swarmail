import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";

test("independent quiet arrivals never extend wake episodes through read, withdrawal and restart orderings", async () => {
  const db = openDatabase(":memory:");
  try {
    const tools = createTools(db, { databasePath: ":memory:", mutationsEnabled: true });
    const common = { project_key: "/ordering", sender_name: "GreenCastle" };
    tools.register_agent({
      project_key: "/ordering",
      name: "GreenCastle",
      program: "codex",
      model: "test",
      task_description: "[t3:quiet-order codex:quiet-native]",
    });
    const events = ["quiet", "wake", "wait", "read", "withdraw", "restart"];
    let checked = 0;
    const failures = [];
    const walk = async (sequence, mail, notice, waiters) => {
      if (sequence.length === 3) {
        return;
      }
      for (const event of events) {
        const next = [...sequence, event];
        db.exec("SAVEPOINT ordering");
        let messages = [...mail],
          active = notice,
          runtime = waiters;
        try {
          if (event === "quiet" || event === "wake") {
            const sent = tools.send_message({
              ...common,
              to: ["GreenCastle"],
              subject: "mail",
              body_md: "content",
              notification_policy: event,
            });
            messages.push({ id: sent.id, wake: event === "wake" });
          } else if ((event === "read" || event === "withdraw") && messages.length) {
            const last = messages.at(-1);
            tools[event === "read" ? "mark_message_read" : "withdraw_message"]({
              ...common,
              agent_name: "GreenCastle",
              message_id: last.id,
              idempotency_key: next.join("/"),
            });
            messages = messages.filter((m) => m.id !== last.id);
            active = messages.some((m) => m.wake) ? active : null;
          } else if (event === "restart") {
            runtime = createWaiters(db);
          } else if (event === "wait") {
            const stop = new AbortController();
            const pending = runtime.wait("quiet-order", 60000, stop.signal, {
              retry: true,
              after: active ?? 0,
            });
            stop.abort();
            const offer = await pending;
            const expected =
              active === null ? messages.filter((m) => m.wake).at(-1)?.id : undefined;
            if (offer?.eventId !== expected) {
              failures.push(`${next.join(" -> ")}: expected ${expected}, got ${offer?.eventId}`);
            }
            if (offer) {
              active = offer.eventId;
            }
          }
          const snapshot = runtime.peek("quiet-order");
          if (Boolean(snapshot.mailboxes.length) !== messages.some((m) => m.wake)) {
            failures.push(`${next.join(" -> ")}: quiet snapshot leak`);
          }
          checked++;
          await walk(next, messages, active, runtime);
        } finally {
          db.exec("ROLLBACK TO ordering; RELEASE ordering");
        }
      }
    };
    await walk([], [], null, createWaiters(db));
    expect(checked).toBe(258);
    expect(failures).toEqual([]);
  } finally {
    db.close();
  }
});
