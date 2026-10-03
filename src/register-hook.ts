// `swarmail register`: PreToolUse hook for file edits in Claude Code, Cursor, Devin, Grok, Codex, Antigravity and (via a
// plugin) OpenCode: registers the session in Swarmail under the primary checkout of the repository it is about to edit, once per session
// and repository, keeping one agent name per session. Sessions that start in the home directory
// and edit through worktrees otherwise register late or never, and peers reading the repository's
// roster find nothing. Never blocks the edit, and
// prints nothing: Antigravity reads any stdout, even `{}`, as a decision and denies the call.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { primaryCheckout } from "./checkout.ts";
import { callTool, swarmailUrl } from "./client.ts";
import { hostProcess, sameHost } from "./proc.ts";
import { registryDir, withLock, type RegisterState } from "./registry.ts";
import { sessionMarker, sessionTag, withoutTag } from "./tag.ts";

/** A hook payload. Each host sends its own shape, so every field is checked before use. */
export interface HookInput {
  tool_input?: {
    command?: unknown;
    file_path?: unknown;
    notebook_path?: unknown;
    filePath?: unknown;
  };
  toolCall?: { args?: { TargetFile?: unknown } };
  cwd?: unknown;
  model?: unknown;
  modelName?: unknown;
  swarmail_host?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  conversation_id?: unknown;
  conversationId?: unknown;
  workspace_roots?: unknown[];
  workspacePaths?: unknown[];
  turn_id?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
}

export interface Session {
  host: string;
  program: string;
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
}

/** A `list_agents` roster row, as far as the hook reads it. */
export interface RosterRow {
  name?: string;
  task_description?: string;
}

type Register = (project: string, name: string | null) => string | null;

/**
 * The directory to resolve: the edited file's folder when it exists, else the session cwd. Codex
 * `apply_patch` names its files inside the patch text, relative to the cwd; Antigravity sends
 * `toolCall.args.TargetFile`.
 */
export function targetDir(input: HookInput): string | null {
  const args = input.tool_input;
  const patched =
    typeof args?.command === "string"
      ? /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(args.command)?.[1]
      : null;
  const file = [
    args?.file_path,
    args?.notebook_path,
    args?.filePath,
    input.toolCall?.args?.TargetFile,
    patched,
  ].find((value) => typeof value === "string" && value);
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  if (typeof file === "string" && (file.startsWith("/") || cwd)) {
    let dir = dirname(resolve(cwd ?? "/", file));
    while (dir !== "/" && !existsSync(dir)) {
      dir = dirname(dir);
    }
    return dir;
  }
  return cwd;
}

/**
 * Registers `session` under `project` unless its state already lists it with this `tag`. A changed
 * tag, or state from before tags were recorded, registers again under the same name so the roster
 * row carries the current tag. Returns the new state, or the old one when nothing changed or the
 * server failed; `register` returns the agent name or null.
 */
export function ensureRegistered(
  state: RegisterState,
  project: string,
  tag: string,
  register: Register,
): RegisterState {
  if (state.projects.includes(project) && state.tags?.[project] === tag) {
    return state;
  }
  const name = register(project, state.name);
  if (!name) {
    return state;
  }
  const projects = state.projects.includes(project) ? state.projects : [...state.projects, project];
  return { ...state, name, projects, tags: { ...state.tags, [project]: tag } };
}

/**
 * `ensureRegistered` that remembers a failure: when the server did not answer, the state keeps a
 * `pending` registration so the next prompt retries it, instead of the session staying
 * unregistered until an edit that may never come. Success clears it.
 */
export function settleRegistration(
  state: RegisterState,
  project: string,
  tag: string,
  register: Register,
): RegisterState {
  const next = ensureRegistered(state, project, tag, register);
  if (next.projects.includes(project) && next.tags?.[project] === tag) {
    const { pending, ...rest } = next;
    return pending?.project === project ? rest : next;
  }
  return { ...next, pending: { project, tag } };
}

/** The one line an agent sees when its registration failed. */
export function failureNotice(project: string, tag: string): string {
  return (
    `Swarmail registration for ${project} failed: the server did not answer, so other sessions cannot mail you. ` +
    `It retries on your next prompt and edit; to register now, call macro_start_session with a task that starts with ${tag}.`
  );
}

/**
 * The hook's stdout. Only Claude gets JSON (`additionalContext` reaches the model); Cursor, Devin,
 * Grok and Antigravity read this output with their own rules, and Antigravity denies the edit on any.
 */
export function hookOutput(host: string, event: unknown, text: string): string {
  if (!text || host !== "claude" || (event !== "PreToolUse" && event !== "UserPromptSubmit")) {
    return "";
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/**
 * The task text of a roster description without its session tag, so a re-registration keeps what
 * the agent wrote. The hook's own placeholder, current or legacy, counts as no task.
 */
export function keptTask(description: unknown): string {
  const text = withoutTag(description)
    .replace(/^(?:.* session [\w-]+ \()?registered on first edit\)?$/, "")
    .trim();
  return text || "registered on first edit";
}

/** The roster row whose tag names `sessionId`, so a session registered by hand keeps its name. */
export function rowForSession(rows: RosterRow[], sessionId: string | null): RosterRow | null {
  if (!sessionId) {
    return null;
  }
  const marker = sessionMarker(sessionId);
  return rows.find((row) => marker.test(String(row.task_description ?? ""))) ?? null;
}

/**
 * The T3 Code thread that runs provider session `sessionId`, or null outside T3. T3 passes no
 * thread id to the provider process, but its resume cursor for the thread holds the session id.
 */
export function t3ThreadId(
  sessionId: string,
  dbPath = join(homedir(), ".t3", "userdata", "state.sqlite"),
): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query<{ thread_id: string }, [string]>(
          "select thread_id from provider_session_runtime where instr(resume_cursor_json, ?) > 0 order by last_seen_at desc limit 1",
        )
        .get(JSON.stringify(sessionId));
      return row?.thread_id ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Which host sent the hook input. Cursor, Devin and Grok also run hooks from
 * ~/.claude/settings.json, each with its own payload shape; Codex runs it from ~/.codex/hooks.json
 * and adds `turn_id`; Antigravity sends camelCase `conversationId`. Plugins that build the input
 * themselves (OpenCode) name the host in `swarmail_host`.
 */
export function hookSession(input: HookInput, env: NodeJS.ProcessEnv = process.env): Session {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  const model = str(input.model) ?? str(input.modelName);
  const session = (
    host: string,
    sessionId = str(input.session_id),
    cwd = str(input.cwd),
    program = host,
  ): Session => ({ host, program, model, sessionId, cwd });
  const named = str(input.swarmail_host);
  if (named) {
    return session(named);
  }
  const grokSession = str(input.sessionId);
  if (grokSession) {
    return session("grok", grokSession);
  }
  const cursorSession = str(input.conversation_id);
  if (cursorSession) {
    return session("cursor", cursorSession, str(input.cwd) ?? str(input.workspace_roots?.[0]));
  }
  const agySession = str(input.conversationId);
  if (agySession) {
    return session("agy", agySession, str(input.workspacePaths?.[0]), "antigravity");
  }
  if (str(input.turn_id)) {
    return session("codex");
  }
  // Environment last: a hook process can inherit another host's variables.
  const grokEnv = str(env.GROK_SESSION_ID);
  if (grokEnv) {
    return session("grok", grokEnv);
  }
  const devinDir = str(env.DEVIN_PROJECT_DIR);
  if (devinDir) {
    return session("devin", undefined, str(input.cwd) ?? devinDir);
  }
  // Claude only on positive evidence: its transcript path, or the variable it sets for child processes.
  // An unrecognised host must not be taken for Claude, since only Claude gets hook output.
  if ((str(input.transcript_path) ?? "").includes("/.claude/projects/") || env.CLAUDECODE === "1") {
    return {
      ...session("claude", undefined, undefined, "claude-code"),
      model: model ?? str(env.ANTHROPIC_MODEL),
    };
  }
  return session("unknown");
}

export function serverRegister(session: Session, tag: string, url = swarmailUrl()): Register {
  return (project, name) => {
    try {
      let rows: RosterRow[] = [];
      try {
        const listed = callTool("list_agents", { project_key: project, limit: 1000 }, url);
        if (Array.isArray(listed)) {
          rows = listed;
        }
      } catch {
        // No roster read: register with the placeholder task.
      }
      const row = name ? rows.find((r) => r.name === name) : rowForSession(rows, session.sessionId);
      const reuse = name ?? row?.name;
      return (
        (
          callTool(
            "register_agent",
            {
              project_key: project,
              program: session.program,
              model: session.model || session.host,
              task_description: `${tag} ${keptTask(row?.task_description)}`,
              ...(reuse && { name: reuse }),
            },
            url,
          ) as { name?: string }
        ).name ?? null
      );
    } catch {
      return null;
    }
  };
}

/**
 * SessionEnd: records when the session ended, then releases its file reservations in every project it
 * registered in, so `who` can say it ended and its claims stop blocking peers. The name stays registered:
 * a resumed session keeps its session id, and with it its name.
 */
export function endSession(
  statePath: string,
  release: (project: string, name: string) => unknown = (project, name) =>
    callTool("release_file_reservations", { project_key: project, agent_name: name }),
  now = new Date(),
): void {
  mkdirSync(dirname(statePath), { recursive: true });
  let state: RegisterState | undefined;
  withLock(statePath + ".lock", () => {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      state = { name: null, projects: [] };
    }
    if (state) {
      // Serialize the end record with registration; release network calls run after unlocking.
      writeFileSync(statePath, JSON.stringify({ ...state, ended: now.toISOString() }) + "\n");
    }
  });
  if (!state?.name) {
    return;
  }
  for (const project of state.projects) {
    try {
      release(project, state.name);
    } catch {
      // Server down: the reservations expire on their own.
    }
  }
}

/** Registers per the hook input; returns the text for the agent, if any. */
function main(input: HookInput): string {
  const started = Date.now();
  const session = hookSession(input);
  const { sessionId } = session;
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) {
    return "";
  }
  const stateDir = registryDir();
  const statePath = join(stateDir, `${sessionId}.json`);
  const readState = (): RegisterState => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return { name: null, projects: [] }; // First edit of this session.
    }
  };
  let notice = "";
  const settle = (project: string, tag: string) =>
    withLock(`${statePath}.lock`, () => {
      const state = readState();
      if (state.ended && Date.parse(state.ended) > started) {
        return;
      }
      const { ended, ...settled } = settleRegistration(
        state,
        project,
        tag,
        serverRegister(session, tag),
      );
      const next = { ...settled, host: hostProcess() };
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        writeFileSync(statePath, JSON.stringify(next) + "\n");
      }
      if (next.pending?.project === project) {
        notice = failureNotice(project, tag);
      } else if (state.pending?.project === project) {
        notice = `Swarmail: registered as ${next.name} in ${project}.`;
      }
    });
  if (input.hook_event_name === "SessionEnd") {
    endSession(statePath);
    return "";
  }
  // A prompt retries a failed registration and clears `ended` after a resume: one file read when neither applies.
  if (input.hook_event_name === "UserPromptSubmit") {
    let pending: RegisterState["pending"];
    mkdirSync(stateDir, { recursive: true });
    withLock(`${statePath}.lock`, () => {
      const { pending: retry, ended, ...rest } = readState();
      if (ended && Date.parse(ended) > started) {
        return;
      }
      pending = retry;
      if (ended) {
        writeFileSync(
          statePath,
          JSON.stringify({ ...rest, ...(retry && { pending: retry }) }) + "\n",
        );
      }
    });
    if (pending) {
      settle(pending.project, pending.tag);
    }
    return notice;
  }
  const dir = targetDir({ ...input, cwd: session.cwd });
  const project = dir && primaryCheckout(dir);
  if (!project) {
    return "";
  }
  const t3 = t3ThreadId(sessionId);
  const tag = sessionTag({ ...session, t3 }, session.cwd);
  // Most edits after the first find the project registered under this tag and skip the lock.
  const known = readState();
  if (!known.ended && known.tags?.[project] === tag && sameHost(known.host, hostProcess())) {
    return "";
  }
  mkdirSync(stateDir, { recursive: true });
  settle(project, tag);
  return notice;
}

/**
 * `swarmail register`: the hook itself, reading the host's JSON on stdin and always exiting 0.
 * `swarmail register --tag <host> [session id]` prints the tag for a manual `register_agent` from the current directory.
 */
export function registerHook(args: string[]): void {
  if (args[0] === "--tag") {
    const [host, sessionId] = args.slice(1);
    if (!host) {
      throw new Error("Usage: swarmail register --tag <host> [session id]");
    }
    console.log(
      sessionTag({ host, sessionId, t3: sessionId ? t3ThreadId(sessionId) : null }, process.cwd()),
    );
    return;
  }
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const out = hookOutput(hookSession(input).host, input.hook_event_name, main(input));
    if (out) {
      process.stdout.write(out + "\n");
    }
  } catch {
    // A registration hook must never stop an edit.
  }
  process.exit(0);
}
