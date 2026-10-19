import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createTools } from "../src/tools.ts";
import { createWaiters } from "../src/wake.ts";

test("wake cursor preserves unread batches through bounded loss, acknowledgement and restart orderings", async () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO projects(id,slug,human_key,created_at) VALUES(1,'test','/test',1);
      INSERT INTO agents(id,project_id,name,program,model,task_description,inception_ts,last_active_ts,t3_thread,session_id)
        VALUES(1,1,'GreenCastle','test','test','[t3:order-test codex:order-native]',1,1,'order-test','order-native');
    `);
    const send = (notification_policy = "wake") =>
      tools.send_message({
        project_key: "/test",
        sender_name: "GreenCastle",
        to: ["GreenCastle"],
        subject: "private subject",
        body_md: "private body",
        notification_policy,
      }).id;
    const tools = createTools(db, { databasePath: ":memory:", mutationsEnabled: true });
    const first = send();
    const failures = [];
    let checked = 0;
    const events = [
      "new mail",
      "lose response",
      "admit response",
      "acknowledge",
      "stale wait",
      "restart",
      "read page",
      "drain inbox",
      "linked wait",
      "withdraw",
      "priority",
    ];
    const mutateBatch = (event, batches, key) => {
      const target = batches.at(-1);
      if (target === undefined) {
        return batches;
      }
      const args = {
        project_key: "/test",
        sender_name: "GreenCastle",
        message_id: target,
        idempotency_key: key,
      };
      if (event === "withdraw") {
        tools.withdraw_message(args);
        return batches.filter((id) => id !== target);
      }
      const row = db.query("SELECT revision,importance FROM messages WHERE id=?").get(target);
      tools.set_message_importance({
        ...args,
        expected_revision: row.revision,
        importance: row.importance === "urgent" ? "normal" : "urgent",
      });
      return batches;
    };
    /** @param {{ accepted: number, acknowledged: number, notice: number | null }} delivery */
    const walk = async (sequence, batches, delivery, waiters) => {
      const { accepted, acknowledged, notice } = delivery;
      if (sequence.length === 4) {
        return;
      }
      for (const event of events) {
        if (event === "new mail" && batches.length === 2) {
          continue;
        }
        if (event === "acknowledge" && accepted === acknowledged) {
          continue;
        }
        if (event === "linked wait" && notice === null) {
          continue;
        }
        const next = [...sequence, event];
        const failureCount = failures.length;
        db.exec("SAVEPOINT step");
        let nextBatches = batches,
          nextAccepted = accepted,
          nextAck = acknowledged,
          nextWaiters = waiters,
          nextNotice = notice;
        const assert = (condition, invariant) => {
          if (!condition) {
            failures.push(`${next.join(" -> ")}: ${invariant}`);
          }
        };
        try {
          if (event === "new mail") {
            send("quiet");
            nextBatches = [...batches, send()];
          } else if (event === "withdraw" || event === "priority") {
            nextBatches = mutateBatch(event, batches, next.join("/"));
            nextNotice = nextBatches.length ? notice : null;
          } else if (event === "restart") {
            // Discard process-local waiters; retain durable database state.
            nextWaiters = createWaiters(db);
          } else if (event === "read page" || event === "drain inbox") {
            const page = tools.fetch_session_inbox({
              host: "test",
              session_id: "order-test",
              t3_thread: "order-test",
              limit: event === "read page" ? 1 : 1000,
            });
            nextBatches = batches.filter((id) => !page.some((message) => message.id === id));
            if (!nextBatches.length) {
              nextNotice = null;
            }
          } else if (event === "linked wait") {
            const stop = new AbortController();
            const pending = waiters.wait("order-native", 60000, stop.signal, {
              retry: true,
              after: 0,
            });
            stop.abort();
            assert(
              (await pending) === null,
              "linked delivery paths never offer a second outstanding notice",
            );
          } else {
            const after =
              event === "stale wait" ? 0 : event === "acknowledge" ? accepted : acknowledged;
            if (event === "acknowledge") {
              nextAck = accepted;
            }
            const stop = new AbortController();
            const pending = waiters.wait("order-test", 60000, stop.signal, { retry: true, after });
            // No timing dependency: an immediately available offer wins; otherwise abort the wait.
            stop.abort();
            const offer = await pending;
            const remaining = batches.filter((id) => id > nextAck);
            const expectedEvent =
              notice === null ? remaining.at(-1) : notice > nextAck ? notice : undefined;
            assert(
              Boolean(offer) === (expectedEvent !== undefined),
              "unadmitted notices replay; admitted notices suppress duplicates until the inbox drains",
            );
            if (offer) {
              assert(
                offer.eventId === expectedEvent,
                "retries keep the original event instead of creating a newer notice",
              );
              nextNotice = offer.eventId;
              assert(
                offer.hint === "Swarmail: run swarmail inbox --session.",
                "each admitted offer directs the receiver to drain its session inbox",
              );
              assert(!offer.hint.includes("private"), "hint excludes message content");
              nextAccepted = event === "admit response" ? offer.eventId : accepted;
            }
          }
          const row = db
            .query("SELECT announced FROM wake_cursors WHERE session='order-test'")
            .get();
          assert(
            (row?.announced ?? 0) === nextAck,
            "only explicit accepted acknowledgements advance the cursor",
          );
          checked++;
          if (failures.length === failureCount) {
            await walk(
              next,
              nextBatches,
              { accepted: nextAccepted, acknowledged: nextAck, notice: nextNotice },
              nextWaiters,
            );
          }
        } finally {
          db.exec("ROLLBACK TO step; RELEASE step");
        }
      }
    };
    await walk([], [first], { accepted: 0, acknowledged: 0, notice: null }, createWaiters(db));
    console.log(`wake cursor: checked ${checked} legal event prefixes through depth 4`);
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  } finally {
    db.close();
  }
}, 30000);
