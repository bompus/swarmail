// `swarmail canary`: one delivery round trip through the running server, meant to run on a timer (hourly works).
// A receiver waits on /wait the way a wake hook does, a sender mails it, and the run passes only when the wait returns
// the public inbox notice, fetch_inbox returns that exact message, and its receipt shows it read and acknowledged.
// Each run appends one JSON line to $XDG_STATE_HOME/swarmail-canary/results.jsonl; a miss exits 1, which a timer's
// failure handler can report. The two agents live in their own project (that directory), away from real rosters.
// docs/canary.md has the setup.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call as mcpCall } from "./mail.ts";
import { authHeaders, stateHome, wakeUrl } from "./paths.ts";
import { INBOX_NOTICE } from "./wake.ts";

/** The wake session the receiver is tagged with, as a wake hook's host session id would be. */
export const CANARY_SESSION = "swarmail-canary-rx";

export interface CanaryResult {
  ts: string;
  ok: boolean;
  message_id: number | null;
  wake_ms: number | null;
  total_ms: number;
  error?: string;
}

type Call = (name: string, args: Record<string, unknown>) => Promise<any>;
type Wait = (session: string, seconds: number) => Promise<string | null>;
interface Names {
  sender?: string;
  receiver?: string;
}

/** Registers both agents (reusing their names), then sends one message and follows it to acknowledged. */
export async function roundTrip(
  project: string,
  known: Names,
  call: Call,
  wait: Wait,
  { timeoutS = 10, now = () => performance.now(), clock = () => new Date() } = {},
): Promise<{ result: CanaryResult; names: Names }> {
  const started = now();
  const ts = clock().toISOString();
  const names: Names = { ...known };
  let messageId: number | null = null;
  let wakeMs: number | null = null;
  try {
    for (const role of ["sender", "receiver"] as const) {
      const session = role === "receiver" ? CANARY_SESSION : "swarmail-canary-tx";
      const agent = await call("register_agent", {
        project_key: project,
        program: "swarmail-canary",
        model: "none",
        task_description: `[canary:${session}] hourly delivery canary`,
        ...(names[role] && { name: names[role] }),
      });
      names[role] = agent.name;
    }
    const receiver = { project_key: project, agent_name: names.receiver };
    // Mail a failed run left unread would answer the wait before this run's message arrives.
    await call("fetch_inbox", { ...receiver, unread_only: true, limit: 100 });
    const woken = wait(CANARY_SESSION, timeoutS);
    woken.catch(() => {}); // Awaited below; a failed send must not leave it unhandled.
    const sentAt = now();
    const sent = await call("send_message", {
      project_key: project,
      sender_name: names.sender,
      to: [names.receiver],
      subject: `canary ${ts}`,
      body_md: "Delivery canary; acknowledged by the canary itself.",
      ack_required: true,
      idempotency_key: `canary-${ts}`,
    });
    messageId = sent.id as number;
    const hint = await woken;
    if (hint !== INBOX_NOTICE) {
      throw new Error(`no wake hint within ${timeoutS} s (got ${JSON.stringify(hint)})`);
    }
    wakeMs = Math.round(now() - sentAt);
    const inbox: { id: number }[] = await call("fetch_inbox", { ...receiver, limit: 20 });
    if (!inbox.some((m) => m.id === messageId)) {
      throw new Error(`message ${messageId} missing from the receiver's inbox`);
    }
    await call("acknowledge_message", { ...receiver, message_id: messageId });
    const receipt = await call("get_message_delivery_receipt", {
      project_key: project,
      message_id: messageId,
    });
    const row = receipt.recipients.find(
      (r: { recipient: string }) => r.recipient === names.receiver,
    );
    if (!row?.read_at || !row.acknowledged) {
      throw new Error(`receipt for ${messageId} is not read and acknowledged`);
    }
    return {
      result: {
        ts,
        ok: true,
        message_id: messageId,
        wake_ms: wakeMs,
        total_ms: Math.round(now() - started),
      },
      names,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      result: {
        ts,
        ok: false,
        message_id: messageId,
        wake_ms: wakeMs,
        total_ms: Math.round(now() - started),
        error,
      },
      names,
    };
  }
}

/** GET /wait as a wake hook does: the hint, or null on 204. A server that stops answering fails the run after the wait time plus `graceMs`. */
export function httpWait(base: string, graceMs = 5000, env: NodeJS.ProcessEnv = process.env): Wait {
  return async (session, seconds) => {
    const url = new URL("/wait", base); // As the wake hook builds it, so a trailing slash in the base does no harm.
    url.search = new URLSearchParams({ session, timeout: String(seconds) }).toString();
    const res = await fetch(url, {
      headers: authHeaders(env, base),
      signal: AbortSignal.timeout(seconds * 1000 + graceMs),
    });
    if (res.status === 204) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`/wait answered ${res.status}`);
    }
    return (await res.text()).trim();
  };
}

export async function canary(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dir = join(stateHome(env), "swarmail-canary");
  mkdirSync(dir, { recursive: true });
  const namesPath = join(dir, "agents.json");
  let known: Names = {};
  try {
    known = JSON.parse(readFileSync(namesPath, "utf8"));
  } catch {
    // First run: the server names both agents.
  }
  const { result, names } = await roundTrip(
    dir,
    known,
    (name, args) => mcpCall(env, name, args),
    httpWait(wakeUrl(env), undefined, env),
  );
  if (JSON.stringify(names) !== JSON.stringify(known)) {
    writeFileSync(namesPath, JSON.stringify(names) + "\n");
  }
  const line = JSON.stringify(result);
  appendFileSync(join(dir, "results.jsonl"), line + "\n");
  (result.ok ? console.log : console.error)(line);
  return result.ok ? 0 : 1;
}
