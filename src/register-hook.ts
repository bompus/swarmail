// `swarmail register`: PreToolUse hook for file edits in Claude Code, Cursor, Devin, Grok, Codex, Antigravity and (via a
// plugin) OpenCode: registers the session in Swarmail under the primary checkout of the repository it is about to edit, once per session
// and repository, keeping one agent name per session. Sessions that start in the home directory
// and edit through worktrees otherwise register late or never, and peers reading the repository's
// roster find nothing. Claude Code and Cursor also run it at session start, which registers under the
// working directory's repository and tells the agent its name, so the agent uses that name instead of
// registering a second one. Never blocks the edit, and prints nothing for hosts whose output rules are
// unverified: Antigravity reads any stdout, even `{}`, as a decision and denies the call.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { primaryCheckout, worktreeRoot } from "./checkout.ts";
import { hostProcess, sameHost } from "./proc.ts";
import { openRegistry, serverRegister, type Session } from "./registry.ts";
import { sessionTag } from "./tag.ts";
import { t3ThreadId } from "./t3-state.ts";

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
  if (typeof file === "string" && (isAbsolute(file) || cwd)) {
    let dir = dirname(cwd ? resolve(cwd, file) : resolve(file));
    while (dirname(dir) !== dir && !existsSync(dir)) {
      dir = dirname(dir);
    }
    return dir;
  }
  return cwd;
}

/** The one line an agent sees when its registration failed. */
export function failureNotice(project: string, tag: string): string {
  return (
    `Swarmail registration for ${project} failed: the server did not answer, so other sessions cannot mail you. ` +
    `It retries on your next prompt and edit; to register now, call macro_start_session with a task that starts with ${tag}.`
  );
}

/** What a session learns at start: its name, or, outside a repository, the tag that keeps its name. */
export function startNotice(tag: string, name?: string | null, project?: string): string {
  if (!name) {
    return (
      `Swarmail: your session tag is ${tag}. When you register (macro_start_session or register_agent), ` +
      "start task_description with it so the register hook keeps the name you get."
    );
  }
  return (
    `Swarmail: you are registered as ${name} in ${project}. Use ${name} as your agent name; do not call ` +
    `macro_start_session or register_agent to get another one. In another repository, register with name ${name}.`
  );
}

/**
 * The hook's stdout. Claude gets JSON (`additionalContext` reaches the model), and Cursor's own sessionStart hook gets
 * its flat `additional_context`. Cursor's other events, Devin, Grok and Antigravity read this output with their own
 * rules, and Antigravity denies the edit on any.
 */
export function hookOutput(host: string, event: unknown, text: string): string {
  if (text && host === "cursor" && event === "sessionStart") {
    return JSON.stringify({ additional_context: text });
  }
  const events = ["PreToolUse", "UserPromptSubmit", "SessionStart"];
  if (!text || host !== "claude" || !events.includes(String(event))) {
    return "";
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** The event in Claude's spelling: Cursor's hooks.json sends `sessionStart` and `sessionEnd`. */
const eventName = (event: unknown): unknown =>
  event === "sessionStart" || event === "sessionEnd" ? `S${String(event).slice(1)}` : event;

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
  if (
    /[\\/]\.claude[\\/]projects[\\/]/.test(str(input.transcript_path) ?? "") ||
    env.CLAUDECODE === "1"
  ) {
    return {
      ...session("claude", undefined, undefined, "claude-code"),
      model: model ?? str(env.ANTHROPIC_MODEL),
    };
  }
  return session("unknown");
}

/** Registers per the hook input; returns the text for the agent, if any. */
function main(input: HookInput): string {
  const started = Date.now();
  const session = hookSession(input);
  const { sessionId } = session;
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) {
    return "";
  }
  const registry = openRegistry();
  const settle = (project: string, tag: string, worktree?: string): string => {
    const settled = registry.settle(sessionId, {
      since: started,
      project,
      tag,
      worktree,
      register: serverRegister(session, tag, undefined, worktree),
      extra: { host: hostProcess() },
    });
    if (settled?.after.pending?.project === project) {
      return failureNotice(project, tag);
    }
    if (settled?.before.pending?.project === project) {
      return `Swarmail: registered as ${settled.after.name} in ${project}.`;
    }
    return "";
  };
  const event = eventName(input.hook_event_name);
  if (event === "SessionEnd") {
    registry.end(sessionId);
    return "";
  }
  // A prompt retries a failed registration and clears `ended` after a resume.
  if (event === "UserPromptSubmit") {
    const pending = registry.resume(sessionId, started);
    return pending ? settle(pending.project, pending.tag, pending.worktree) : "";
  }
  const dir = targetDir({ ...input, cwd: session.cwd });
  const project = dir && primaryCheckout(dir);
  const t3 = t3ThreadId(sessionId);
  const tag = sessionTag({ ...session, t3 }, session.cwd);
  const starting = event === "SessionStart";
  if (!project) {
    return starting ? startNotice(tag) : "";
  }
  // Most edits after the first find the project registered under this tag and skip the lock.
  const known = registry.read(sessionId);
  // A compaction or resume announces the session again without moving its last edit checkout.
  const recorded = starting
    ? ((known?.pending?.project === project ? known.pending.worktree : undefined) ??
      known?.worktrees?.[project])
    : undefined;
  const worktree = recorded ?? (dir ? (worktreeRoot(dir) ?? undefined) : undefined);
  const text =
    known &&
    !known.ended &&
    !known.pending &&
    known.tags?.[project] === tag &&
    known.worktrees?.[project] === worktree &&
    sameHost(known.host, hostProcess())
      ? ""
      : settle(project, tag, worktree);
  // Every start names the session, registered just now or before: a compacted or resumed session has lost its name.
  const state = starting ? registry.read(sessionId) : null;
  if (!state?.name || state.pending?.project === project) {
    return text;
  }
  return startNotice(tag, state.name, project);
}

/** The variable each host sets in its shell to the session id; the README lists them. */
const SESSION_ENV: Record<string, string> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  cursor: "CURSOR_CONVERSATION_ID",
  grok: "GROK_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
};

/**
 * `swarmail register`: the hook itself, reading the host's JSON (`read`, standard input from the CLI) and always
 * exiting 0.
 * `swarmail register --tag <host> [session id]` prints the tag for a manual `register_agent` from the current directory,
 * taking the session id from the host's shell variable when omitted.
 */
export async function registerHook(args: string[], read: () => Promise<string>): Promise<void> {
  if (args[0] === "--tag") {
    const host = args[1];
    if (!host) {
      throw new Error("Usage: swarmail register --tag <host> [session id]");
    }
    const sessionId = args[2] || process.env[SESSION_ENV[host] ?? ""] || undefined;
    console.log(
      sessionTag({ host, sessionId, t3: sessionId ? t3ThreadId(sessionId) : null }, process.cwd()),
    );
    return;
  }
  try {
    const input = JSON.parse(await read()) as HookInput;
    const out = hookOutput(hookSession(input).host, input.hook_event_name, main(input));
    if (out) {
      process.stdout.write(out + "\n");
    }
  } catch {
    // A registration hook must never stop an edit.
  }
  process.exit(0);
}
