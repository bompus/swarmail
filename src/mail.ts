// `swarmail inbox` and `swarmail send`: mail from a shell, as this session's agent in the current repository.
//   swarmail inbox [--all] [--peek] [--limit N] [--json] [--as NAME]   unread messages (--all: read ones too), marked
//                                                        read unless --peek; --json prints the fetch_inbox array, newest first
//   swarmail send <to[,to...]> <subject> [body] [--as NAME]    body from stdin when omitted
//   swarmail ping <agent> [--timeout S] [--as NAME]            whether the agent's wake hook answers (wake.ts)
//   swarmail search <words...> [--limit N] [--cursor CURSOR] [--json | --json-page]  project mail matching every word, best match first
//   swarmail thread <id> [--limit N] [--json]                   a thread's messages, oldest first; needs no sender name
// The sender is --as, else SWARMAIL_AGENT, else the name the register hook recorded for the agent host above this shell.
import { swarmailUrl } from "./paths.ts";
import { primaryCheckout } from "./checkout.ts";
import { selfNames } from "./registry.ts";
import { PING_SUBJECT, PONG_SUBJECT } from "./wake.ts";

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
    if (arg === "--as" || arg === "--limit" || arg === "--timeout" || arg === "--cursor") {
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
    const [to, subject, body] = positional;
    if (!to || !subject) {
      console.error("usage: swarmail send <to[,to...]> <subject> [body] [--as NAME]");
      return 64;
    }
    const sent = await call(env, "send_message", {
      project_key: project,
      sender_name: agent,
      to: to.split(","),
      subject,
      body_md: body ?? (await stdin()),
    });
    console.log(`sent #${sent.id} from ${agent} to ${to}`);
    return 0;
  } catch (e) {
    console.error(`swarmail ${command}: ${e instanceof Error ? e.message : e}`);
    return 1;
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
  for (const m of messages.reverse()) {
    const flags = [m.importance !== "normal" && m.importance, m.ack_required && "ack required"]
      .filter(Boolean)
      .join(", ");
    console.log(
      `#${m.id} ${m.created_ts} from ${m.from}${flags ? ` (${flags})` : ""}: ${m.subject}`,
    );
    if (m.body_md) {
      console.log(m.body_md.replace(/^/gm, "    "));
    }
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
  console.log(`thread ${id}: ${count}${shown} · ${participants.join(", ")}`);
  for (const m of result.messages) {
    console.log(`#${m.id} ${m.created_ts} from ${m.from}: ${m.subject}`);
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
  for (const m of result) {
    console.log(`#${m.id} ${m.created_ts} ${m.from} -> ${m.to.join(", ")}: ${m.subject}`);
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
    `no pong from ${target} within ${timeoutS}s: its wake hook is not waiting (mid-turn, no wake hook on its host,` +
      " or the session is gone). The ping stays unread and is answered when the hook next waits.",
  );
  return 1;
}
