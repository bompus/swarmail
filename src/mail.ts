// `swarmail inbox` and `swarmail send`: mail from a shell, as this session's agent in the current repository.
//   swarmail inbox [--all] [--peek] [--limit N] [--json] [--as NAME]   unread messages (--all: read ones too), marked
//                                                        read unless --peek; --json prints the fetch_inbox array, newest first
//   swarmail send <to[,to...]> <subject> [body] [--as NAME]    body from stdin when omitted
//   swarmail ping <agent> [--timeout S] [--as NAME]            observe a wake-hook pong, not model liveness or future delivery (wake.ts)
//   swarmail search <words...> [--limit N] [--cursor CURSOR] [--json | --json-page]  project mail matching every word, best match first
//   swarmail thread <id> [--limit N] [--json]                   a thread's messages, oldest first; needs no sender name
// The sender is --as, else SWARMAIL_AGENT, else the name the register hook recorded for the agent host above this shell.
import { swarmailUrl } from "./paths.ts";
import { compileResourceNotice } from "./resource-notice.ts";
import { pageLimit } from "./store.ts";
import { primaryCheckout } from "./checkout.ts";
import { selfNames, selfSession } from "./registry.ts";
import { PING_SUBJECT, PONG_SUBJECT } from "./wake.ts";
import type { Location } from "./location.ts";

interface Message {
  id: number;
  from: string;
  subject: string;
  created_ts: string;
  importance: string;
  ack_required: boolean;
  thread_id: string | null;
  body_md?: string;
  excerpt?: string;
  sender_location?: Location | null;
}

/** Prefer send-time labels; older views can use the current roster without changing stored mail. */
function senderLabels(env: NodeJS.ProcessEnv) {
  const rosters = new Map<string, Map<string, Location | null>>();
  return async (project: string, message: Pick<Message, "from" | "sender_location">) => {
    let location = message.sender_location;
    if (!location) {
      if (!rosters.has(project)) {
        try {
          const rows: Array<{ name: string; location: Location | null }> = await call(
            env,
            "list_agents",
            {
              project_key: project,
            },
          );
          rosters.set(project, new Map(rows.map((row) => [row.name, row.location])));
        } catch {
          // A display lookup must not prevent reading mail already fetched.
          rosters.set(project, new Map());
        }
      }
      location = rosters.get(project)!.get(message.from);
    }
    const label = [location?.title, location?.repo, location?.worktree]
      .map((value) => value?.replace(/\s+/g, " ").trim())
      .find(Boolean);
    return label ? `${message.from} (${label})` : message.from;
  };
}

export async function call(
  env: NodeJS.ProcessEnv,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const url = swarmailUrl(env);
  let body: any;
  let status: number | undefined;
  try {
    const res = await fetch(url, {
      method: "POST",
      // Every tool answers promptly; a server that does not is down or wedged.
      signal: signal ?? AbortSignal.timeout(10_000),
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    status = res.status;
    body = res.ok ? await res.json() : undefined;
  } catch (error) {
    if (signal) {
      throw error;
    }
    const problem =
      (error as Error).name === "TimeoutError"
        ? `Swarmail at ${url} did not answer within 10 s`
        : `cannot reach Swarmail at ${url}`;
    throw new Error(`${problem}; is \`swarmail serve\` running?`, {
      cause: error,
    });
  }
  if (!body) {
    throw new Error(`Swarmail at ${url} answered HTTP ${status}; check SWARMAIL_URL`);
  }
  const { result, error } = body;
  const text = result?.content?.[0]?.text;
  if (error || result?.isError) {
    throw new Error(error?.message ?? JSON.parse(text).error.message);
  }
  return JSON.parse(text);
}

/** Option values by name, and the remaining positional arguments. */
function parse(args: string[]) {
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === "--as" ||
      arg === "--limit" ||
      arg === "--timeout" ||
      arg === "--cursor" ||
      arg === "--delivery-policy" ||
      arg === "--notification-policy" ||
      arg === "--idempotency-key" ||
      arg === "--expected-revision" ||
      arg === "--recipients"
    ) {
      opts[arg.slice(2)] = args[++i] ?? "";
    } else if (arg.startsWith("--")) {
      opts[arg.slice(2)] = true;
    } else {
      rest.push(arg);
    }
  }
  return { opts, rest };
}

/** The primary checkout of the repository around `cwd`: the project key mail is filed under. */
function projectOf(cwd: string): string {
  const project = primaryCheckout(cwd);
  if (!project) {
    throw new Error(`${cwd} is not inside a git repository`);
  }
  return project;
}

function agentOf(opts: Record<string, string | true>, env: NodeJS.ProcessEnv): string {
  const names = typeof opts.as === "string" ? [opts.as] : [...selfNames(env)];
  if (names.length !== 1) {
    throw new Error(
      names.length
        ? `this session has several names (${names.join(", ")}); pick one with --as`
        : "no Swarmail name for this session; pass --as NAME or set SWARMAIL_AGENT",
    );
  }
  return names[0]!;
}

export async function mail(
  args: string[],
  stdin: () => Promise<string>,
  env = process.env,
  cwd = process.cwd(),
): Promise<number> {
  const [command, ...rest] = args;
  const { opts, rest: positional } = parse(rest);
  try {
    if (opts["resource-notice"] !== undefined && command !== "send") {
      throw new Error("--resource-notice requires send");
    }
    if (opts.session) {
      if (
        command !== "inbox" ||
        opts.as !== undefined ||
        opts.cursor !== undefined ||
        positional.length
      ) {
        throw new Error(
          "inbox --session cannot be combined with --as, --cursor or positional arguments",
        );
      }
      return await sessionInbox(env, opts);
    }
    const project = projectOf(cwd);
    if (command === "search") {
      return await search(env, project, positional.join(" "), opts);
    }
    if (command === "thread") {
      return await thread(env, project, positional[0], opts);
    }
    const agent = agentOf(opts, env);
    if (command === "inbox") {
      return await inbox(env, project, agent, opts);
    }
    if (command === "ping") {
      return await ping(env, project, agent, positional[0], Number(opts.timeout ?? 10));
    }
    if (command === "withdraw" || command === "importance") {
      return await mutate(env, project, agent, { command, positional, opts });
    }
    const [to, subject, body] = positional;
    let resourceArgs: Record<string, unknown> | undefined;
    if (opts["resource-notice"] !== undefined) {
      if (
        positional.length !== 1 ||
        Object.keys(opts).some(
          (key) => !["resource-notice", "idempotency-key", "as", "json"].includes(key),
        ) ||
        typeof opts["idempotency-key"] !== "string" ||
        opts["idempotency-key"].startsWith("--")
      ) {
        throw new Error(
          "resource notices require one recipient, JSON stdin and --idempotency-key; text and delivery options cannot be combined",
        );
      }
      resourceArgs = {
        project_key: project,
        sender_name: agent,
        to: to!.split(","),
        idempotency_key: opts["idempotency-key"],
        resource_notice: JSON.parse(await stdin()),
      };
      compileResourceNotice(resourceArgs);
    }
    if (!resourceArgs && (!to || !subject)) {
      console.error("usage: swarmail send <to[,to...]> <subject> [body] [--as NAME]");
      return 64;
    }
    const sent = await call(
      env,
      "send_message",
      resourceArgs ?? {
        project_key: project,
        sender_name: agent,
        to: to!.split(","),
        subject,
        body_md: body ?? (await stdin()),
        ...(opts["delivery-policy"] !== undefined && { delivery_policy: opts["delivery-policy"] }),
        ...(opts["notification-policy"] !== undefined && {
          notification_policy: opts["notification-policy"],
        }),
      },
    );
    if (opts.json) {
      console.log(JSON.stringify(sent));
      return 0;
    }
    console.log(`sent #${sent.id} from ${agent} to ${to}`);
    for (const warning of sent.delivery?.warnings ?? []) {
      console.error(`swarmail send: stored #${sent.id}; ${warning}`);
    }
    return 0;
  } catch (e) {
    console.error(`swarmail ${command}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

async function mutate(
  env: NodeJS.ProcessEnv,
  project: string,
  agent: string,
  input: { command: string; positional: string[]; opts: Record<string, string | true> },
): Promise<number> {
  const { command, positional, opts } = input;
  const id = positional[0];
  const key = opts["idempotency-key"];
  const expected = opts["expected-revision"];
  if (
    !id ||
    !/^[1-9]\d*$/.test(id) ||
    typeof key !== "string" ||
    !key ||
    positional.length !== (command === "withdraw" ? 1 : 2) ||
    (command === "importance" && (typeof expected !== "string" || !/^\d+$/.test(expected))) ||
    (opts.recipients !== undefined &&
      (command !== "withdraw" || typeof opts.recipients !== "string" || !opts.recipients))
  ) {
    throw new Error(
      "usage: withdraw <id> --idempotency-key KEY [--recipients A,B]; importance <id> <level> --expected-revision N --idempotency-key KEY",
    );
  }
  const result = await call(
    env,
    command === "withdraw" ? "withdraw_message" : "set_message_importance",
    {
      project_key: project,
      sender_name: agent,
      message_id: Number(id),
      idempotency_key: key,
      ...(command === "importance" && {
        importance: positional[1],
        expected_revision: Number(expected),
      }),
      ...(opts.recipients !== undefined && { recipients: String(opts.recipients).split(",") }),
    },
  );
  console.log(JSON.stringify(result, null, opts.json ? undefined : 2));
  return 0;
}

/** Drain exact session registrations without needing a repository or mailbox name. */
async function sessionInbox(
  env: NodeJS.ProcessEnv,
  opts: Record<string, string | true>,
): Promise<number> {
  const identity = selfSession(env);
  const preview = !!(opts.peek || opts.all);
  const limit = pageLimit(Number(opts.limit ?? 20), "limit", 20);
  let shown = false;
  const label = senderLabels(env);
  for (;;) {
    const messages: Array<Message & { project_key: string; agent_name: string }> = await call(
      env,
      "fetch_session_inbox",
      {
        ...identity,
        unread_only: !opts.all,
        mark_read: !opts.peek,
        include_bodies: true,
        limit,
      },
    );
    if (opts.json) {
      console.log(JSON.stringify(messages));
    } else {
      for (const message of messages.reverse()) {
        console.log(`this session in ${JSON.stringify(message.project_key)}`);
        printMessage(message, await label(message.project_key, message));
      }
    }
    if (messages.length < limit || preview) {
      if (!opts.json && !shown && !messages.length) {
        console.log(opts.all ? "no mail for this session" : "no unread mail for this session");
      }
      return 0;
    }
    shown = true;
  }
}

function printMessage(m: Message, sender: string): void {
  const flags = [m.importance !== "normal" && m.importance, m.ack_required && "ack required"]
    .filter(Boolean)
    .join(", ");
  console.log(`#${m.id} ${m.created_ts} from ${sender}${flags ? ` (${flags})` : ""}: ${m.subject}`);
  if (m.body_md) {
    console.log(m.body_md.replace(/^/gm, "    "));
  }
}

async function inbox(
  env: NodeJS.ProcessEnv,
  project: string,
  agent: string,
  opts: Record<string, string | true>,
): Promise<number> {
  const messages: Message[] = await call(env, "fetch_inbox", {
    project_key: project,
    agent_name: agent,
    unread_only: !opts.all,
    mark_read: !opts.peek,
    include_bodies: true,
    limit: Number(opts.limit ?? 20),
  });
  if (opts.json) {
    console.log(JSON.stringify(messages, null, 2));
    return 0;
  }
  if (messages.length === 0) {
    console.log(`${agent}: no ${opts.all ? "" : "unread "}messages`);
  }
  const label = senderLabels(env);
  for (const m of messages.reverse()) {
    printMessage(m, await label(project, m));
  }
  return 0;
}

/** A thread's newest messages, oldest first, with bodies. */
async function thread(
  env: NodeJS.ProcessEnv,
  project: string,
  id: string | undefined,
  opts: Record<string, string | true>,
): Promise<number> {
  if (!id) {
    console.error("usage: swarmail thread <id> [--limit N] [--json]");
    return 64;
  }
  const result: {
    summary: { participants: string[]; total_messages: number };
    messages: Message[];
  } = await call(env, "summarize_thread", {
    project_key: project,
    thread_id: id,
    per_thread_limit: Number(opts.limit ?? 50),
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const { participants, total_messages: total } = result.summary;
  if (total === 0) {
    console.log(`thread ${id}: no messages`);
    return 0;
  }
  const shown = result.messages.length < total ? `, newest ${result.messages.length} shown` : "";
  const count = `${total} message${total === 1 ? "" : "s"}`;
  const label = senderLabels(env);
  const names = [];
  for (const from of participants) {
    names.push(await label(project, { from }));
  }
  console.log(`thread ${id}: ${count}${shown} · ${names.join(", ")}`);
  for (const m of result.messages) {
    console.log(`#${m.id} ${m.created_ts} from ${await label(project, m)}: ${m.subject}`);
    if (m.body_md) {
      console.log(m.body_md.replace(/^/gm, "    "));
    }
  }
  return 0;
}

/** Mail matching every word, with short matching excerpts; MCP can also return full bodies. */
async function search(
  env: NodeJS.ProcessEnv,
  project: string,
  query: string,
  opts: Record<string, string | true>,
): Promise<number> {
  if (!query.trim()) {
    console.error(
      "usage: swarmail search <words...> [--limit N] [--cursor CURSOR] [--json | --json-page]",
    );
    return 64;
  }
  const page = (await call(env, "search_messages", {
    project_key: project,
    query,
    limit: Number(opts.limit ?? 20),
    ...(opts.cursor !== undefined && { cursor: opts.cursor }),
  })) as { result: Array<Message & { to: string[] }>; next_cursor?: string };
  if (opts["json-page"]) {
    console.log(JSON.stringify(page, null, 2));
    return 0;
  }
  const { result } = page;
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.length === 0) {
    console.log(`no mail matches "${query}"`);
  }
  const label = senderLabels(env);
  for (const m of result) {
    console.log(
      `#${m.id} ${m.created_ts} ${await label(project, m)} -> ${m.to.join(", ")}: ${m.subject}`,
    );
    if (m.excerpt) {
      console.log(m.excerpt.replace(/^/gm, "    "));
    }
  }
  if (page.next_cursor) {
    console.log(`more results: repeat this search with --cursor ${page.next_cursor}`);
  }
  return 0;
}

/** Sends a ping and waits for the pong the server returns while the target's wake hook waits. */
async function ping(
  env: NodeJS.ProcessEnv,
  project: string,
  agent: string,
  target: string | undefined,
  timeoutS: number,
): Promise<number> {
  if (!target) {
    console.error("usage: swarmail ping <agent> [--timeout S] [--as NAME]");
    return 64;
  }
  const thread = `ping-${crypto.randomUUID()}`;
  const started = Date.now();
  await call(env, "send_message", {
    project_key: project,
    sender_name: agent,
    to: [target],
    subject: PING_SUBJECT,
    body_md: "ping",
    thread_id: thread,
  });
  while (Date.now() - started < timeoutS * 1000) {
    const messages: Message[] = await call(env, "fetch_inbox", {
      project_key: project,
      agent_name: agent,
      mark_read: false,
      limit: 20,
    });
    if (messages.some((m) => m.subject === PONG_SUBJECT && m.thread_id === thread)) {
      console.log(`pong from ${target} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return 0;
    }
    await Bun.sleep(250);
  }
  console.log(
    `no pong from ${target} within ${timeoutS}s: no wake-hook response observed (mid-turn, unavailable route,` +
      " or other delay). This does not prove the session ended. Pending ping mail can be answered when the hook next waits.",
  );
  return 1;
}
