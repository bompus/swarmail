// Shared durable wake cursor, pending command, process ownership and optional context, one database per mailbox session.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./wake-target.ts";

export interface Pending {
  eventId: number;
  command: Record<string, unknown>;
}

/**
 * Bindings saved before T3 port discovery record a URL that current bindings omit, because
 * the port moves on every T3 restart. Compare those without the URL instead of rewriting them.
 */
export function sameBinding(saved: string, binding: string): boolean {
  if (saved === binding) {
    return true;
  }
  try {
    const old = JSON.parse(saved);
    const next = JSON.parse(binding);
    // Keys bindings no longer carry; state saved while they did still matches.
    const retired: [string | null, string[]][] = [
      [null, ["url", "executable", "version", "headerPath"]],
      ["target", ["url", "authorizationFile"]],
      ["rotation", ["executable", "version"]],
    ];
    for (const [scope, keys] of retired) {
      const [from, to] = scope ? [old[scope], next[scope]] : [old, next];
      for (const key of from && to ? keys : []) {
        if (!(key in to)) {
          delete from[key];
        }
      }
    }
    return JSON.stringify(old) === binding;
  } catch {
    return false;
  }
}

/** The state database of one mailbox session, under the XDG state home. */
export function wakeStatePath(
  swarmailUrl: string,
  id: string,
  namespace = "swarmail-bridge",
): string {
  return join(wakeStateRoot(namespace), `${wakeStateKey(swarmailUrl, id)}.sqlite`);
}

const wakeStateRoot = (namespace: string) =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), namespace);
const wakeStateKey = (swarmailUrl: string, id: string) =>
  createHash("sha256").update(`${swarmailUrl}\n${id}`).digest("hex");

export function openWakeState(
  swarmailUrl: string,
  id: string,
  binding: string,
  namespace = "swarmail-bridge",
) {
  const root = wakeStateRoot(namespace);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const key = wakeStateKey(swarmailUrl, id);
  const lockPath = join(root, `${key}.lock.sqlite`);
  const lock = new Database(lockPath, { create: true });
  chmodSync(lockPath, 0o600);
  try {
    // Brief first-use SQLite contention must settle so simultaneous starters do not both lose.
    lock.exec("PRAGMA busy_timeout=250; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new BridgeError("another wake bridge owns this mailbox session");
  }
  let db: Database | undefined;
  try {
    const path = join(root, `${key}.sqlite`);
    db = new Database(path, { create: true });
    db.exec("PRAGMA busy_timeout=250");
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, pending TEXT); CREATE TABLE IF NOT EXISTS context (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    db.query("INSERT OR IGNORE INTO state(id,binding) VALUES(1,?)").run(binding);
    const row = db
      .query<{ binding: string; acknowledged: number; pending: string | null }, []>(
        "SELECT * FROM state WHERE id=1",
      )
      .get()!;
    if (!sameBinding(row.binding, binding)) {
      throw new BridgeError(
        "saved mailbox binding differs; resolve its pending delivery before changing destination",
      );
    }
    const state = db;
    // Each write updates the saved row and these fields together.
    const journal = {
      acknowledged: row.acknowledged,
      pending: row.pending ? (JSON.parse(row.pending) as Pending) : null,
      savePending: (pending: Pending) => {
        state.query("UPDATE state SET pending=? WHERE id=1").run(JSON.stringify(pending));
        journal.pending = pending;
      },
      /** Record that the destination may have received the pending command. */
      markAttempted: () => {
        const pending = journal.pending!;
        // In place: a native delivery still holds this command object.
        pending.command.phase = "attempted";
        journal.savePending(pending);
      },
      accept: (eventId: number) => {
        state.query("UPDATE state SET acknowledged=?,pending=NULL WHERE id=1").run(eventId);
        journal.acknowledged = eventId;
        journal.pending = null;
      },
      readContext: (): Record<string, unknown> | null => {
        const row = state
          .query<{ value: string }, []>("SELECT value FROM context WHERE id=1")
          .get();
        if (!row) {
          return null;
        }
        const context = JSON.parse(row.value);
        if (context === null || typeof context !== "object" || Array.isArray(context)) {
          throw new BridgeError("saved wake context is invalid; inspect retained state");
        }
        return context;
      },
      clearContext: () => state.exec("DELETE FROM context WHERE id=1"),
      saveContext: (value: Record<string, unknown>) => {
        state
          .query("INSERT OR REPLACE INTO context(id,value) VALUES(1,?)")
          .run(JSON.stringify(value));
      },
      close: () => {
        state.close();
        lock.close();
      },
    };
    return journal;
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }
}

export type WakeState = ReturnType<typeof openWakeState>;

export async function waitForOffer(
  config: { swarmailUrl: string; target: { id: string } },
  after: number,
  signal: AbortSignal,
): Promise<{ eventId: number; hint: string } | null> {
  const url = new URL("/wait", config.swarmailUrl);
  url.search = new URLSearchParams({
    session: config.target.id,
    after: String(after),
    retry: "1",
    timeout: "30",
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      redirect: "error",
    });
  } catch {
    throw new BridgeError("Swarmail connection unavailable", true);
  }
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new BridgeError(`Swarmail HTTP ${response.status}`, response.status >= 500);
  }
  const raw = response.headers.get("x-swarmail-event-id");
  const eventId = Number(raw);
  let hint: string;
  try {
    hint = (await response.text()).trim();
  } catch {
    throw new BridgeError("Swarmail response interrupted", true);
  }
  if (
    !raw ||
    !Number.isSafeInteger(eventId) ||
    eventId <= after ||
    !hint.startsWith("Swarmail: ")
  ) {
    throw new BridgeError("Swarmail server does not support explicit wake acknowledgements");
  }
  return { eventId, hint };
}

/** Read current mailbox identities without replacing the long poll or acknowledging an offer. */
export async function peekUnreadMailboxes(
  config: { swarmailUrl: string; target: { id: string } },
  signal: AbortSignal,
): Promise<{ recipient: string; project: string }[]> {
  const url = new URL("/wait/peek", config.swarmailUrl);
  url.search = new URLSearchParams({ session: config.target.id }).toString();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      redirect: "error",
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
      throw new Error("snapshot unavailable");
    }
    const result = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("mailboxes" in result) ||
      !Array.isArray(result.mailboxes) ||
      result.mailboxes.length > 1000
    ) {
      throw new Error("invalid snapshot");
    }
    const keys = new Set<string>();
    for (const mailbox of result.mailboxes) {
      if (
        typeof mailbox?.recipient !== "string" ||
        !mailbox.recipient ||
        typeof mailbox.project !== "string" ||
        !mailbox.project
      ) {
        throw new Error("invalid mailbox");
      }
      const key = JSON.stringify([mailbox.recipient, mailbox.project]);
      if (keys.has(key)) {
        throw new Error("duplicate mailbox");
      }
      keys.add(key);
    }
    return result.mailboxes.map(
      ({ recipient, project }: { recipient: string; project: string }) => ({ recipient, project }),
    );
  } catch {
    throw new BridgeError("Swarmail unread mailbox snapshot unavailable", true);
  }
}
