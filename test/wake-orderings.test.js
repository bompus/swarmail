import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createWaiters } from "../src/wake.ts";

test("wake cursor preserves unread batches through bounded loss, acknowledgement and restart orderings", async () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO projects(id,slug,human_key,created_at) VALUES(1,'test','/test',1);
      INSERT INTO agents(id,project_id,name,program,model,task_description,inception_ts,last_active_ts,t3_thread)
        VALUES(1,1,'GreenCastle','test','test','[t3:order-test]',1,1,'order-test');
    `);
    const send = () => {
      const { id } = db
        .query(`INSERT INTO messages(project_id,sender_id,subject,body_md,created_ts)
        VALUES(1,1,'private subject','private body',1) RETURNING id`)
        .get();
      db.query("INSERT INTO message_recipients(message_id,agent_id,created_ts) VALUES(?,1,1)").run(
        id,
      );
      return id;
    };
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
    ];
    const walk = async (sequence, batches, accepted, acknowledged, waiters) => {
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
        const next = [...sequence, event];
        const failureCount = failures.length;
        db.exec("SAVEPOINT step");
        let nextBatches = batches,
          nextAccepted = accepted,
          nextAck = acknowledged,
          nextWaiters = waiters;
        const assert = (condition, invariant) => {
          if (!condition) {
            failures.push(`${next.join(" -> ")}: ${invariant}`);
          }
        };
        try {
          if (event === "new mail") {
            nextBatches = [...batches, send()];
          } else if (event === "restart") {
            // Discard process-local waiters; retain durable database state.
            nextWaiters = createWaiters(db);
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
            assert(
              Boolean(offer) === Boolean(remaining.length),
              "unacknowledged mail stays offerable",
            );
            if (offer) {
              assert(
                offer.eventId === remaining.at(-1),
                "offer covers exactly the remaining batches",
              );
              assert(
                offer.hint === "Swarmail: Fetch all unread mail with swarmail inbox --session.",
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
            await walk(next, nextBatches, nextAccepted, nextAck, nextWaiters);
          }
        } finally {
          db.exec("ROLLBACK TO step; RELEASE step");
        }
      }
    };
    await walk([], [first], 0, 0, createWaiters(db));
    console.log(`wake cursor: checked ${checked} legal event prefixes through depth 4`);
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  } finally {
    db.close();
  }
});
