// Loaded only by child-process tests. Pause at real SQLite boundaries without replacing writes.
import { Database } from "bun:sqlite";
import { readSync, writeSync } from "node:fs";

const boundary = process.env.SWARMAIL_TEST_BOUNDARY;
function pause() {
  writeSync(1, `${boundary}\n`);
  const byte = Buffer.alloc(1);
  if (readSync(0, byte, 0, 1, null) !== 1) {
    throw new Error("test barrier closed without release");
  }
}

if (boundary === "startup") {
  pause();
} else {
  const query = Database.prototype.query;
  Database.prototype.query = function (sql, ...options) {
    const statement = query.call(this, sql, ...options);
    if (!sql.startsWith("UPDATE state SET")) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property !== "run") {
          return Reflect.get(target, property);
        }
        return (...args) => {
          const attempted =
            sql.startsWith("UPDATE state SET pending=") &&
            JSON.parse(args[0]).command.phase === "attempted";
          if (
            (boundary === "before-attempt" && attempted) ||
            (boundary === "before-ack" && sql.startsWith("UPDATE state SET acknowledged="))
          ) {
            pause();
          }
          const result = target.run(...args);
          if (boundary === "after-attempt" && attempted) {
            pause();
          }
          return result;
        };
      },
    });
  };
}
