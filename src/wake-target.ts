// Native editor delivery, with explicit target protocols and immutable command receipts.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface WakeTarget {
  type: "t3-v1-steer" | "t3-v2-queue" | "opencode-v2-queue";
  url: string;
  id: string;
  authorizationFile: string;
  delivery?: "auto";
}

export class BridgeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

/** Authentication is shared by every thread using the configured target. */
export class TargetAuthenticationError extends BridgeError {}

/** The target types that reach a T3 thread. */
export const T3_TYPES: readonly string[] = ["t3-v1-steer", "t3-v2-queue"];

/** One wake target type: its config, the destination its state binds to, and its protocol. */
export interface TargetAdapter<T extends { type: string; id: string }> {
  /** Validate the config's target; the bridge has already checked `id`. */
  parse(target: Record<string, any>): T;
  /** Destination fields, besides type and id, that bind saved state to this target. */
  binding(target: T): Record<string, unknown>;
  /** The complete command to journal before the first attempt. */
  prepare(target: T, hint: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Deliver a journaled command; call `attempted` once the destination may have it. */
  deliver(
    target: T,
    command: Record<string, unknown>,
    attempted: () => void,
    signal: AbortSignal,
    guard?: () => Promise<void>,
  ): Promise<void>;
}

export function localUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new BridgeError("an explicit loopback URL is required");
  }
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new BridgeError("use an HTTP loopback origin without credentials, path or query");
  }
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.origin;
}

function headers(target: WakeTarget): Record<string, string> {
  const stat = statSync(target.authorizationFile);
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())
  ) {
    throw new TargetAuthenticationError(
      "authorization file must be owned by this user with mode 600",
    );
  }
  const authorization = readFileSync(target.authorizationFile, "utf8").trim();
  if (!/^(Bearer|Basic) [^\s]+$/.test(authorization)) {
    throw new TargetAuthenticationError(
      "authorization file must contain one Bearer or Basic header value",
    );
  }
  return {
    authorization,
    "content-type": "application/json",
    ...(target.type === "t3-v2-queue" ? { "x-t3-orchestration-protocol": "2" } : {}),
  };
}

async function request(target: WakeTarget, path: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(target.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(target),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError("target connection or authorization file unavailable", true);
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new TargetAuthenticationError("target HTTP 403");
    }
    throw new BridgeError(
      `target HTTP ${response.status}`,
      response.status >= 500 || response.status === 429 || response.status === 401,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new BridgeError("target response interrupted", true);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError("target returned an invalid JSON response");
  }
}

/** Shared snapshot validation for delivery and the read-only installed-target check. */
async function inspectT3Thread(target: WakeTarget) {
  const snapshot = await request(
    target,
    `/api/orchestration/threads/${encodeURIComponent(target.id)}`,
  );
  if (target.type === "t3-v2-queue") {
    if (
      snapshot?.projection?.thread?.id !== target.id ||
      !Array.isArray(snapshot.projection.runs)
    ) {
      throw new BridgeError("target does not expose the tested T3 V2 projection protocol");
    }
    return snapshot.projection.thread;
  }
  const thread = snapshot?.thread;
  if (
    thread?.id !== target.id ||
    !["full-access", "approval-required"].includes(thread.runtimeMode) ||
    !["default", "plan"].includes(thread.interactionMode)
  ) {
    throw new BridgeError("target does not expose the tested T3 V1 thread protocol");
  }
  return thread;
}

/** Shared GET-only auth check, including automatic supervisors with no eligible thread yet. */
export async function checkT3Authentication(target: WakeTarget): Promise<void> {
  let session;
  try {
    session = await request(target, "/api/auth/session");
  } catch (error) {
    if (error instanceof BridgeError && !error.retryable) {
      throw new TargetAuthenticationError(error.message);
    }
    throw error;
  }
  if (
    session?.authenticated !== true ||
    session.sessionMethod !== "bearer-access-token" ||
    !Array.isArray(session.scopes) ||
    !session.scopes.includes("orchestration:operate") ||
    !(Date.parse(session.expiresAt) > Date.now())
  ) {
    throw new TargetAuthenticationError("target authentication contract or expiry is invalid");
  }
}

/** GET-only preflight; proves auth/snapshot compatibility, never dispatch or model execution. */
export async function checkT3Target(target: WakeTarget): Promise<void> {
  if (!T3_TYPES.includes(target.type)) {
    throw new BridgeError("health check requires a T3 target");
  }
  await checkT3Authentication(target);
  await inspectT3Thread(target);
}

async function dispatchV2(
  target: WakeTarget,
  command: Record<string, unknown>,
  guard?: () => Promise<void>,
): Promise<any> {
  const ticket = await request(target, "/api/auth/websocket-ticket", {});
  if (typeof ticket?.ticket !== "string") {
    throw new BridgeError("target did not issue a websocket ticket");
  }
  const url = new URL(target.url);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket.ticket);
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const done = (error?: BridgeError, value?: unknown) => {
      clearTimeout(timer);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => done(new BridgeError("T3 RPC timed out", true)), 15_000);
    socket.onopen = async () => {
      try {
        await guard?.();
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "orchestration.dispatchCommand",
            payload: command,
            headers: [],
          }),
        );
      } catch (error) {
        done(
          error instanceof BridgeError
            ? error
            : new BridgeError("lifecycle check unavailable", true),
        );
      }
    };
    socket.onerror = () => done(new BridgeError("T3 websocket failed", true));
    socket.onclose = () => done(new BridgeError("T3 websocket closed before admission", true));
    socket.onmessage = (event) => {
      try {
        for (const frame of [JSON.parse(String(event.data))].flat()) {
          if (frame._tag === "Ping") {
            socket.send(JSON.stringify({ _tag: "Pong" }));
          } else if (frame._tag === "Exit" && String(frame.requestId) === "1") {
            if (frame.exit?._tag === "Success") {
              done(undefined, frame.exit.value);
            } else {
              done(new T3CommandRejected());
            }
          }
        }
      } catch {
        done(new BridgeError("invalid T3 RPC response"));
      }
    };
  });
}

/** The server rejected the immutable command; a queued-run race can be reconciled from a fresh snapshot. */
export class T3CommandRejected extends BridgeError {
  constructor() {
    super("T3 rejected the command");
  }
}

/** Hold mail when settlement metadata is missing or the operator settled the thread. */
export function ensureT3Unsettled(thread: {
  settledAt?: unknown;
  settledOverride?: unknown;
}): void {
  if (
    (thread.settledAt !== null && typeof thread.settledAt !== "string") ||
    (thread.settledOverride !== null &&
      thread.settledOverride !== "settled" &&
      thread.settledOverride !== "active")
  ) {
    throw new BridgeError("T3 settlement state unavailable; holding mail", true);
  }
  if (thread.settledAt !== null || thread.settledOverride === "settled") {
    throw new BridgeError("T3 thread is settled; holding mail", true);
  }
}

export interface T3ControlProjection {
  thread: { id: string; settledAt?: unknown; settledOverride?: unknown };
  runs: {
    id: string;
    status: string;
    userMessageId: string | null;
    rootNodeId?: string | null;
    activeAttemptId?: string | null;
    providerThreadId?: string | null;
  }[];
  providerThreads?: { id: string; providerSessionId: string | null }[];
  providerSessions?: {
    id: string;
    capabilities: {
      turns: {
        supportsActiveSteering: boolean;
        supportsInterrupt: boolean;
        supportsSteeringByInterruptRestart: boolean;
      };
    };
  }[];
  providerTurns?: { runAttemptId: string | null; status: string }[];
  messages: {
    id: string;
    text: string;
    attachments?: unknown[];
    createdBy: string;
    creationSource: string;
    notification?: unknown;
    delegatedCompletion?: unknown;
  }[];
  runtimeRequests: { status: string; kind: string }[];
}

export const T3_HUMAN_REQUEST_KINDS = new Set<unknown>([
  "user_input",
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
const requestKinds = new Set([...T3_HUMAN_REQUEST_KINDS, "dynamic_tool_call", "auth_refresh"]);
const requestStatuses = new Set<unknown>(["pending", "resolved", "expired", "cancelled"]);
const runStatuses = new Set<unknown>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const actors = new Set<unknown>(["user", "agent", "system"]);
const sources = new Set<unknown>(["web", "mobile", "mcp", "provider", "server"]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The control-plane snapshot includes live/queued messages even when history is bounded. */
export async function t3Projection(target: WakeTarget): Promise<T3ControlProjection> {
  const result = await request(
    target,
    `/api/orchestration/threads/${encodeURIComponent(target.id)}/bounded`,
  );
  const p = result?.projection;
  if (
    p?.thread?.id !== target.id ||
    !Array.isArray(p.runs) ||
    !Array.isArray(p.messages) ||
    !Array.isArray(p.runtimeRequests) ||
    !p.runtimeRequests.every(
      (row: unknown) =>
        record(row) && requestStatuses.has(row.status) && requestKinds.has(row.kind),
    ) ||
    !p.messages.every(
      (row: unknown) =>
        record(row) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.text === "string" &&
        actors.has(row.createdBy) &&
        sources.has(row.creationSource) &&
        (row.notification === undefined || record(row.notification)) &&
        (row.delegatedCompletion === undefined || record(row.delegatedCompletion)),
    ) ||
    !p.runs.every(
      (row: unknown) =>
        record(row) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        runStatuses.has(row.status) &&
        (row.userMessageId === null || typeof row.userMessageId === "string") &&
        (row.status !== "queued" ||
          p.messages.some((message: { id: string }) => message.id === row.userMessageId)),
    )
  ) {
    throw new BridgeError("target does not expose the tested T3 V2 control projection");
  }
  const shapes = [
    [
      p.providerThreads,
      (row: Record<string, any>) =>
        typeof row.id === "string" &&
        (row.providerSessionId === null || typeof row.providerSessionId === "string"),
    ],
    [
      p.providerTurns,
      (row: Record<string, any>) =>
        (row.runAttemptId === null || typeof row.runAttemptId === "string") &&
        ["pending", "running", "completed", "interrupted", "failed", "cancelled"].includes(
          row.status,
        ),
    ],
    [
      p.providerSessions,
      (row: Record<string, any>) =>
        typeof row.id === "string" &&
        record(row.capabilities) &&
        record(row.capabilities.turns) &&
        ["supportsActiveSteering", "supportsInterrupt", "supportsSteeringByInterruptRestart"].every(
          (key) => typeof row.capabilities.turns[key] === "boolean",
        ),
    ],
  ] as const;
  for (const [rows, valid] of shapes) {
    if (
      rows !== undefined &&
      (!Array.isArray(rows) || !rows.every((row: unknown) => record(row) && valid(row)))
    ) {
      throw new BridgeError("T3 steering metadata unavailable; holding mail", true);
    }
  }
  return p;
}

/** Hold transitions before journaling an operation that T3 would permanently reject. */
export function t3SteeringRun(projection: T3ControlProjection) {
  const active = projection.runs.filter((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  if (!active.length) {
    return null;
  }
  const run = active[0]!;
  const message = projection.messages.find((message) => message.id === run.userMessageId);
  if (
    message &&
    (!Array.isArray(message.attachments) || message.attachments.length === 0) &&
    ["/compact", "/logout"].includes(message.text.trim().toLowerCase())
  ) {
    throw new BridgeError("T3 provider maintenance is active; holding mail", true);
  }
  const thread = Array.isArray(projection.providerThreads)
    ? projection.providerThreads.find((thread) => thread.id === run.providerThreadId)
    : undefined;
  const session = Array.isArray(projection.providerSessions)
    ? projection.providerSessions.find((session) => session.id === thread?.providerSessionId)
    : undefined;
  const turns = session?.capabilities.turns;
  if (
    active.length !== 1 ||
    run.status !== "running" ||
    typeof run.rootNodeId !== "string" ||
    !run.rootNodeId ||
    typeof run.activeAttemptId !== "string" ||
    !run.activeAttemptId ||
    typeof run.providerThreadId !== "string" ||
    !thread ||
    typeof thread.providerSessionId !== "string" ||
    !session ||
    !turns ||
    ![
      turns.supportsActiveSteering,
      turns.supportsInterrupt,
      turns.supportsSteeringByInterruptRestart,
    ].every((flag) => typeof flag === "boolean") ||
    !(
      turns.supportsActiveSteering ||
      (turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart)
    ) ||
    !Array.isArray(projection.providerTurns) ||
    !projection.providerTurns.some(
      (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
    )
  ) {
    throw new BridgeError("T3 cannot accept steering now; holding mail", true);
  }
  return run;
}

export async function sendT3Command(
  target: WakeTarget,
  command: Record<string, unknown>,
  guard?: () => Promise<void>,
) {
  admitted(await dispatchV2(target, command, guard));
}

function parseHttp<T extends WakeTarget["type"]>(type: T) {
  return (target: Record<string, any>) => {
    if (typeof target.authorizationFile !== "string" || !isAbsolute(target.authorizationFile)) {
      throw new BridgeError("config requires target type and absolute authorizationFile");
    }
    if (target.delivery !== undefined && (type !== "t3-v2-queue" || target.delivery !== "auto")) {
      throw new BridgeError("automatic delivery requires a T3 V2 target");
    }
    return {
      type,
      ...(target.delivery === "auto" ? { delivery: "auto" as const } : {}),
      id: target.id as string,
      url: localUrl(target.url),
      authorizationFile: target.authorizationFile,
    };
  };
}

function admitted(result: any) {
  if (!Number.isSafeInteger(result?.sequence) || result.sequence < 0) {
    throw new BridgeError("T3 returned no command admission receipt");
  }
}

// Each prepared command is journaled whole, so a retry never rereads mutable thread settings.

/** T3 V1: start a turn that steers the active one, with the thread's current modes. */
export const t3V1Adapter: TargetAdapter<WakeTarget> = {
  parse: parseHttp("t3-v1-steer"),
  // The port moves on T3 restart; the authorization file ties the bridge to one T3 database.
  binding: () => ({}),
  prepare: async (target, text) => {
    const thread = await inspectT3Thread(target);
    return {
      type: "thread.turn.start",
      commandId: crypto.randomUUID(),
      threadId: target.id,
      message: { messageId: crypto.randomUUID(), role: "user", text, attachments: [] },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    };
  },
  deliver: async (target, command, _attempted, _signal, guard) => {
    ensureT3Unsettled(await inspectT3Thread(target));
    await guard?.();
    admitted(await request(target, "/api/orchestration/dispatch", command));
  },
};

/** T3 V2: steer the active run, or start an idle thread. */
export const t3V2Adapter: TargetAdapter<WakeTarget> = {
  parse: parseHttp("t3-v2-queue"),
  binding: () => ({}),
  prepare: () => {
    throw new BridgeError("T3 V2 notices require the notice adapter");
  },
  deliver: async (target, command, _attempted, _signal, guard) =>
    admitted(await dispatchV2(target, command, guard)),
};

/** OpenCode 2: add a prompt to the active conversation with steering delivery. */
export const openCodeAdapter: TargetAdapter<WakeTarget> = {
  parse: parseHttp("opencode-v2-queue"),
  binding: (target) => ({ url: target.url }),
  prepare: (_target, text) => ({
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    text,
    delivery: "steer",
  }),
  deliver: async (target, command, _attempted, _signal, guard) => {
    await guard?.();
    const result = await request(
      target,
      `/api/session/${encodeURIComponent(target.id)}/prompt`,
      command,
    );
    if (
      result?.data?.id !== command.id ||
      result.data.sessionID !== target.id ||
      result.data.payload?.text !== command.text ||
      result.data.delivery !== command.delivery
    ) {
      throw new BridgeError("OpenCode admission does not match the saved request");
    }
  },
};
