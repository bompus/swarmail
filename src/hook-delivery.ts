// Native hook invocations share an explicit wake cursor; receiving a lost HTTP offer never acknowledges it.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "./paths.ts";

export function openHookDelivery(sid: string, env: NodeJS.ProcessEnv) {
  const dir = join(stateHome(env), "swarmail-context");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, `${sid}.sqlite`), { create: true });
  try {
    db.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), announced INTEGER NOT NULL); INSERT OR IGNORE INTO cursor VALUES (1,0)",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const read = db.query<{ announced: number }, []>("SELECT announced FROM cursor WHERE id=1");
  const claim = db.query<{ announced: number }, [number]>(
    "UPDATE cursor SET announced=?1 WHERE id=1 AND announced<?1 RETURNING announced",
  );
  return {
    query: () => `&retry=1&after=${read.get()!.announced}`,
    async receive(response: Response, guard?: () => Promise<void>): Promise<string> {
      const hint = (await response.text()).trim();
      const id = Number(response.headers.get("x-swarmail-event-id"));
      if (!hint.startsWith("Swarmail: ") || !Number.isSafeInteger(id) || id <= 0) {
        throw new Error("invalid native wake offer");
      }
      await guard?.();
      // Concurrent context and Stop hooks can receive the same offer; only one claims its output.
      return claim.get(id) ? hint : "";
    },
    close: () => db.close(),
  };
}
