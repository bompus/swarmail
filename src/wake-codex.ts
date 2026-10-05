// Codex input IDs correlate admissions; resending the same client ID can create more work.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BridgeError } from "./wake-target.ts";
import { nativeAdapter, savedNative } from "./wake-native.ts";
import type { NativeTarget } from "./wake-native.ts";

export type CodexTarget = NativeTarget<"codex-queue">;

class CodexClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  private readonly signal: AbortSignal;
  private failure: Error | undefined;
  private sequence = 0;
  private pending:
    | { id: number; resolve: (value: any) => void; reject: (error: Error) => void }
    | undefined;
  private rejectReady: ((error: Error) => void) | undefined;

  constructor(target: CodexTarget, signal: AbortSignal) {
    this.signal = signal;
    // Native app-server publishes a symlink to its private daemon socket.
    const entry = lstatSync(target.socket);
    const socketPath = realpathSync(target.socket);
    const socket = lstatSync(socketPath);
    const parents = [dirname(target.socket), dirname(socketPath)].map((path) => lstatSync(path));
    if (
      entry.uid !== process.getuid!() ||
      !socket.isSocket() ||
      socket.uid !== process.getuid!() ||
      parents.some(
        (parent) =>
          !parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0,
      )
    ) {
      throw new BridgeError("Codex requires a user-owned socket in a private parent directory");
    }
    if (/[:?#%\\]/.test(socketPath) || socketPath.split("").some((c) => c.charCodeAt(0) <= 32)) {
      throw new BridgeError("Codex resolved socket path contains unsupported URL characters");
    }
    // Bun supplies Unix WebSocket framing, masking, ping/pong and fragmentation.
    this.socket = new WebSocket(`ws+unix://${socketPath}`);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.socket.onopen = () => resolve();
    });
    this.socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 8 * 1024 * 1024) {
          throw new Error("invalid frame");
        }
        const message = JSON.parse(event.data);
        // Never answer approval, tool or UI requests. The owning editor handles them.
        if (message?.method || message?.id !== this.pending?.id) {
          return;
        }
        const pending = this.pending!;
        this.pending = undefined;
        if (message.error || !("result" in message)) {
          pending.reject(new BridgeError("Codex rejected the native request"));
        } else {
          pending.resolve(message.result);
        }
      } catch {
        this.fail(new BridgeError("Codex returned an invalid protocol response"));
      }
    };
    this.socket.onerror = () => this.fail(new BridgeError("Codex connection unavailable", true));
    this.socket.onclose = () => this.fail(new BridgeError("Codex connection closed", true));
    this.timer = setTimeout(
      () => this.fail(new BridgeError("Codex delivery timed out", true)),
      target.timeoutMs,
    );
    this.abort = () => this.fail(new BridgeError("Codex delivery interrupted", true));
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) {
      this.abort();
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.rejectReady?.(error);
    this.pending?.reject(error);
    this.pending = undefined;
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.ready;
    if (this.failure) {
      throw this.failure;
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "swarmail", version: "1" },
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  async find(method: string, threadId: string, matches: (row: any) => boolean): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, {
        threadId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(method === "thread/items/list" ? { sortDirection: "desc" } : {}),
      });
      if (!Array.isArray(result?.data)) {
        throw new BridgeError("Codex returned an invalid recovery page");
      }
      if (result.data.some(matches)) {
        return true;
      }
      if (result.nextCursor == null) {
        return false;
      }
      if (
        typeof result.nextCursor !== "string" ||
        !result.nextCursor ||
        seen.has(result.nextCursor)
      ) {
        throw new BridgeError("Codex returned an invalid recovery cursor");
      }
      cursor = result.nextCursor;
      seen.add(result.nextCursor);
    }
    throw new BridgeError("Codex recovery page limit reached; pending retained");
  }

  close() {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.abort);
    this.fail(new BridgeError("Codex client stopped"));
    this.socket.terminate();
  }
}

function sameInput(input: any, text: string): boolean {
  return (
    Array.isArray(input) &&
    input.length === 1 &&
    input[0]?.type === "text" &&
    input[0].text === text &&
    (input[0].text_elements === undefined ||
      (Array.isArray(input[0].text_elements) && input[0].text_elements.length === 0))
  );
}

async function steerCodex(
  client: CodexClient,
  thread: any,
  threadId: string,
  { promptId, text }: { promptId: string; text: string },
  markAttempted: () => void,
) {
  if (
    thread.canAcceptDirectInput !== true ||
    !["idle", "active"].includes(thread.status?.type) ||
    (thread.status.type === "active" &&
      (!Array.isArray(thread.status.activeFlags) || thread.status.activeFlags.length > 0))
  ) {
    throw new BridgeError("Codex cannot accept steering now; holding mail", true);
  }
  markAttempted();
  // Codex resolves start or steer atomically; no read-to-expected-turn-id race.
  const started = await client.request("turn/start", {
    threadId,
    clientUserMessageId: promptId,
    input: [{ type: "text", text }],
  });
  if (
    typeof started?.turn?.id !== "string" ||
    !started.turn.id ||
    !Array.isArray(started.turn.items) ||
    !["inProgress", "completed", "interrupted", "failed"].includes(started.turn.status)
  ) {
    throw new BridgeError("Codex returned no turn admission");
  }
}

export async function deliverCodex(
  target: CodexTarget,
  command: Record<string, unknown>,
  markAttempted: () => void,
  signal: AbortSignal,
): Promise<void> {
  const { promptId, text } = savedNative(command, "Codex");
  let client: CodexClient | undefined;
  const matches = (id: unknown, input: unknown) => {
    if (id !== promptId) {
      return false;
    }
    if (!sameInput(input, text)) {
      throw new BridgeError("Codex recovery payload differs from the saved command");
    }
    return true;
  };
  try {
    client = new CodexClient(target, signal);
    await client.initialize();
    // Read only: never resume a thread, create a session, or override its permissions/model.
    const result = await client.request("thread/read", {
      threadId: target.id,
      includeTurns: false,
    });
    if (
      result?.thread?.id !== target.id ||
      typeof result.thread.cwd !== "string" ||
      resolve(result.thread.cwd) !== resolve(target.cwd)
    ) {
      throw new BridgeError("Codex thread or workspace differs from the configured target");
    }
    const queued = await client.find("thread/queue/list", target.id, (row) =>
      matches(row?.clientUserMessageId, row?.input),
    );
    if (command.phase === "attempted") {
      if (
        queued ||
        (await client.find("thread/items/list", target.id, (row) =>
          row?.item?.type === "userMessage" ? matches(row.item.clientId, row.item.content) : false,
        ))
      ) {
        return; // Admission evidence, not a promise of model completion or exactly-once execution.
      }
      throw new BridgeError("Codex has no matching queue or history admission");
    }
    if (queued) {
      throw new BridgeError("Codex already contains an unattempted command ID; reconcile state");
    }
    if (signal.aborted) {
      return;
    }
    if (command.delivery === "steer") {
      await steerCodex(client, result.thread, target.id, { promptId, text }, markAttempted);
      return;
    }
    markAttempted(); // Durable before send, including the crash-before-write window.
    const added = await client.request("thread/queue/add", {
      threadId: target.id,
      clientUserMessageId: promptId,
      input: [{ type: "text", text }],
    });
    const receipt = added?.queuedSubmission;
    if (
      typeof receipt?.id !== "string" ||
      !receipt.id ||
      !matches(receipt.clientUserMessageId, receipt.input)
    ) {
      throw new BridgeError("Codex returned no matching queue admission");
    }
  } catch (error) {
    if (signal.aborted && error instanceof BridgeError && error.retryable) {
      throw error; // The delivery loop retains pending state and exits cleanly on interruption.
    }
    if (command.phase === "attempted") {
      throw new BridgeError(
        `Codex delivery ${promptId} is ambiguous; pending retained, no resend. Reconnect to reconcile queue/history; inspect the session before manual recovery`,
      );
    }
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError("Codex endpoint unavailable", true);
  } finally {
    client?.close();
  }
}

export const codexAdapter = nativeAdapter("codex-queue", deliverCodex, (socket) => {
  if (/[:?#%\\]/.test(socket) || socket.split("").some((c) => c.charCodeAt(0) <= 32)) {
    throw new BridgeError("Codex socket path contains unsupported URL characters");
  }
});
