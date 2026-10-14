// `swarmail overdue [--dry-run]`, meant to run on a timer (every 10 minutes works): finds ack_required mail that a live
// recipient has not acknowledged after the deadline. The recipient gets one automatic reminder in the thread, sent as
// the original sender so a reply goes back to them; if the deadline passes again, the operator is told through the
// command SWARMAIL_NOTIFY names, or the line is only printed when it is unset. State lives in
// $XDG_STATE_HOME/swarmail-overdue/state.json. docs/overdue.md has the setup.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { call as mcpCall } from "./mail.ts";
import { databasePath, stateHome } from "./paths.ts";

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface Note {
  key: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "critical";
  detail?: string;
}
type Notify = (note: Note) => void;

export interface Overdue {
  id: number;
  subject: string;
  project: string;
  sender: string;
  recipient: string;
  created_ts: number;
  /** 1 when the sender is retired: it could still send a reminder, but not receive the reply. */
  sender_retired: number;
}

/** ack_required mail unacknowledged by a live recipient, sent between `windowH` hours and `minutes` ago. */
export function overdueRows(
  dbPath: string,
  minutes: number,
  windowH: number,
  now = Date.now(),
): Overdue[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<Overdue, [number, number]>(
        `SELECT m.id, m.subject, p.human_key AS project, s.name AS sender, a.name AS recipient, m.created_ts,
                s.retired_at IS NOT NULL AS sender_retired
           FROM message_recipients r JOIN messages m ON m.id = r.message_id JOIN agents a ON a.id = r.agent_id
           JOIN agents s ON s.id = m.sender_id JOIN projects p ON p.id = m.project_id
          WHERE m.ack_required = 1 AND r.ack_ts IS NULL AND a.retired_at IS NULL
            AND m.created_ts < ?1 AND m.created_ts > ?2
          ORDER BY m.id`,
      )
      .all((now - minutes * 60_000) * 1000, (now - windowH * 3_600_000) * 1000);
  } finally {
    db.close();
  }
}

export interface OverdueState {
  /** `<message id>:<recipient>` → when the reminder went out (ms). */
  nudged: Record<string, number>;
  escalated: string[];
}

/** One pass of the deadline check; returns what it did (or, with dryRun, would do). */
export async function checkOverdue({
  rows,
  call,
  notify,
  state,
  minutes,
  now = Date.now(),
  dryRun = false,
}: {
  rows: Overdue[];
  call: Call;
  notify: Notify;
  state: OverdueState;
  minutes: number;
  now?: number;
  dryRun?: boolean;
}): Promise<{ actions: string[]; state: OverdueState }> {
  const actions: string[] = [];
  const live = new Set(rows.map((r) => `${r.id}:${r.recipient}`));
  // Acknowledged, retired or aged-out entries leave the state.
  const next: OverdueState = {
    nudged: Object.fromEntries(Object.entries(state.nudged).filter(([k]) => live.has(k))),
    escalated: state.escalated.filter((k) => live.has(k)),
  };
  const escalate = (r: Overdue, key: string, why: string) => {
    if (next.escalated.includes(key)) {
      return;
    }
    actions.push(`notify the operator: ${r.recipient} has not acknowledged #${r.id} ${why}`);
    if (!dryRun) {
      notify({
        key: `swarmail-overdue:${key}`,
        title: `Unacknowledged: ${r.recipient} on "${r.subject}"`,
        body: `${r.sender}'s message #${r.id} in ${basename(r.project)} is unacknowledged ${why}.`,
        severity: "warn",
        detail: `swarmail who ${r.project}`,
      });
      next.escalated.push(key);
    }
  };
  for (const r of rows) {
    const key = `${r.id}:${r.recipient}`;
    const age = Math.round((now - r.created_ts / 1000) / 60_000);
    const sent = next.nudged[key];
    if (sent === undefined && r.sender_retired) {
      if (!next.escalated.includes(key)) {
        escalate(r, key, `after ${age} min, and its sender is retired, so no reminder was sent`);
      }
    } else if (sent === undefined) {
      actions.push(
        `remind ${r.recipient} about #${r.id} from ${r.sender} (${age} min old) in ${r.project}`,
      );
      if (dryRun) {
        continue;
      }
      try {
        await call("reply_message", {
          project_key: r.project,
          message_id: r.id,
          idempotency_key: `swarmail-overdue:${key}`,
          sender_name: r.sender,
          // reply_message defaults to the original sender and copies ack_required; neither fits a reminder.
          to: [r.recipient],
          ack_required: false,
          importance: "normal",
          subject_prefix: "Reminder (automatic):",
          body_md:
            `Automatic reminder from the Swarmail deadline check, sent in ${r.sender}'s name: this thread's ` +
            `message #${r.id} asked for an acknowledgement and has none from you. Read it with ` +
            "fetch_inbox and call acknowledge_message.",
        });
        next.nudged[key] = now;
      } catch (e) {
        escalate(
          r,
          key,
          `after ${age} min, and no reminder could be sent (${(e as Error).message})`,
        );
      }
    } else if (!next.escalated.includes(key) && now - sent >= minutes * 60_000) {
      escalate(
        r,
        key,
        `${age} min after sending, ${Math.round((now - sent) / 60_000)} min after a reminder`,
      );
    }
  }
  return { actions, state: next };
}

/**
 * Runs the command SWARMAIL_NOTIFY names for each escalation, with `--key`, `--title`, `--body`, `--severity`,
 * `--source swarmail` and, when there is one, `--detail`. Unset, nothing runs: the escalation is printed and recorded.
 */
export function notifyCommand(env: NodeJS.ProcessEnv): Notify {
  const bin = env.SWARMAIL_NOTIFY;
  if (!bin) {
    return () => {};
  }
  return (note) => {
    const args = ["--key", note.key, "--title", note.title, "--body", note.body];
    args.push("--severity", note.severity, "--source", "swarmail");
    if (note.detail) {
      args.push("--detail", note.detail);
    }
    const res = spawnSync(bin, args, { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`SWARMAIL_NOTIFY command exited ${res.status}: ${res.stderr || res.error}`);
    }
  };
}

export async function overdue(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const dbPath = databasePath(env);
  const statePath = join(stateHome(env), "swarmail-overdue", "state.json");
  const minutes = Number(env.SWARMAIL_OVERDUE_MINUTES || 30);
  const dryRun = args.includes("--dry-run");
  let state: OverdueState = { nudged: {}, escalated: [] };
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    // First run.
  }
  const result = await checkOverdue({
    rows: overdueRows(dbPath, minutes, Number(env.SWARMAIL_OVERDUE_WINDOW_HOURS || 24)),
    call: (name, a) => mcpCall(env, name, a),
    notify: notifyCommand(env),
    state,
    minutes,
    dryRun,
  });
  for (const line of result.actions) {
    console.log(dryRun ? `would ${line}` : line);
  }
  if (!dryRun) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(result.state) + "\n");
  }
  return 0;
}
