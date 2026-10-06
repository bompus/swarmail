// Grok prompt IDs correlate turns; they do not make a repeated submission idempotent.
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { BridgeError } from "./wake-target.ts";
import { nativeAdapter, savedNative } from "./wake-native.ts";
import type { NativeTarget } from "./wake-native.ts";

export type GrokTarget = NativeTarget<"grok-queue">;

interface Reply {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class GrokClient {
  private readonly socket: Socket;
  private readonly target: GrokTarget;
  private readonly promptId: string;
  private readonly signal: AbortSignal;
  private readonly ready: Promise<void>;
  private readyDone: (() => void) | undefined;
  private readyFail: ((error: Error) => void) | undefined;
  private readonly replies = new Map<number, Reply>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private failure: Error | undefined;
  private completion: string | undefined;
  private interjectionSeen = false;
  private readonly text: string;
  private complete: (() => void) | undefined;
  private readonly onAbort: () => void;

  constructor(target: GrokTarget, promptId: string, signal: AbortSignal, text: string) {
    this.target = target;
    this.promptId = promptId;
    this.text = text;
    this.signal = signal;
    const socket = lstatSync(target.socket);
    const parent = lstatSync(dirname(target.socket));
    const privateParent =
      parent.isDirectory() && parent.uid === process.getuid!() && (parent.mode & 0o077) === 0;
    if (
      !socket.isSocket() ||
      socket.uid !== process.getuid!() ||
      ((socket.mode & 0o022) !== 0 && !privateParent)
    ) {
      throw new BridgeError(
        "Grok requires a user-owned socket protected by its mode or a private parent directory",
      );
    }
    this.socket = createConnection(target.socket);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new BridgeError("Grok leader timed out", true)),
        target.timeoutMs,
      );
      this.readyDone = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyFail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    this.socket.on("connect", () =>
      this.frame({ type: "register", client_type: "swarmail", mode: "stdio", capabilities: {} }),
    );
    this.socket.on("data", (chunk: Buffer) => this.read(chunk));
    this.socket.on("error", () => this.fail(new BridgeError("Grok leader unavailable", true)));
    this.socket.on("close", () => this.fail(new BridgeError("Grok connection closed", true)));
    this.onAbort = () => this.fail(new BridgeError("Grok delivery interrupted", true));
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) {
      this.onAbort();
    }
  }

  private frame(message: unknown) {
    const payload = Buffer.from(JSON.stringify(message));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    this.socket.write(Buffer.concat([length, payload]));
  }

  private send(message: unknown) {
    this.frame({ type: "acp", payload: JSON.stringify(message) });
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.readyFail?.(error);
    for (const reply of this.replies.values()) {
      clearTimeout(reply.timer);
      reply.reject(error);
    }
    this.replies.clear();
    this.complete?.();
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > 64 * 1024 * 1024) {
        this.fail(new BridgeError("Grok frame exceeds the protocol limit"));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < length + 4) {
        return;
      }
      const body = this.buffer.subarray(4, length + 4).toString("utf8");
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.envelope(JSON.parse(body));
      } catch {
        this.fail(new BridgeError("Grok returned an invalid protocol frame"));
        this.socket.destroy();
        return;
      }
    }
  }

  private envelope(message: any) {
    if (message.type === "registered") {
      if (message.leader_protocol_version !== 1) {
        throw new Error("unsupported leader protocol");
      }
      if (message.ready !== false) {
        this.readyDone?.();
      }
    } else if (message.type === "leader_ready") {
      this.readyDone?.();
    } else if (message.type === "acp" && typeof message.payload === "string") {
      this.receive(JSON.parse(message.payload));
    } else if (["shutdown", "shutting_down", "error"].includes(message.type)) {
      this.fail(new BridgeError("Grok leader stopped or refused connection", true));
    }
  }

  private receive(message: any) {
    if (message?.jsonrpc !== "2.0") {
      throw new Error("invalid frame");
    }
    if (message.method) {
      if (message.id !== undefined) {
        // Shared questions are first-answer-wins. Leave them to the attached UI.
        // Also never implement client filesystem/terminal requests or grant permissions here.
        return;
      }
      const params = message.params;
      if (params?.sessionId !== this.target.id) {
        return;
      }
      if (
        message.method === "_x.ai/session/interjection" &&
        params.interjectionId === this.promptId
      ) {
        if (params.text !== this.text) {
          throw new Error("interjection payload mismatch");
        }
        this.interjectionSeen = true;
        this.complete?.();
      }
      if (message.method === "_x.ai/session/prompt_complete" && params.promptId === this.promptId) {
        this.completion = params.stopReason;
      }
      const update = params.update;
      if (
        message.method === "_x.ai/session/update" &&
        update?.sessionUpdate === "turn_completed" &&
        update.prompt_id === this.promptId
      ) {
        this.completion = update.stop_reason;
      }
      if (this.completion !== undefined) {
        this.complete?.();
      }
      return;
    }
    const reply = this.replies.get(message.id);
    if (!reply) {
      return;
    }
    clearTimeout(reply.timer);
    this.replies.delete(message.id);
    if (message.error || !("result" in message)) {
      reply.reject(new BridgeError("Grok rejected the native request"));
    } else {
      reply.resolve(message.result);
    }
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        reject(new BridgeError("Grok request timed out", true));
      }, this.target.timeoutMs);
      this.replies.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async load() {
    await this.ready;
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (
      init?.protocolVersion !== 1 ||
      init?._meta?.grokShell !== true ||
      init?.agentCapabilities?.loadSession !== true
    ) {
      throw new BridgeError("Grok does not expose the tested ACP session-load protocol");
    }
    await this.request("authenticate", { methodId: "cached_token", _meta: { headless: true } });
    await this.request("session/load", {
      sessionId: this.target.id,
      cwd: this.target.cwd,
      mcpServers: [],
    });
  }

  private async waitForEvidence() {
    if (this.completion === undefined && !this.interjectionSeen && !this.failure) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.target.timeoutMs);
        this.complete = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  async recover() {
    await this.waitForEvidence();
    if (this.completion !== "end_turn") {
      throw new BridgeError("Grok has no matching successful completion");
    }
  }

  async confirmInterjection() {
    await this.waitForEvidence();
    if (!this.interjectionSeen) {
      throw new BridgeError("Grok has no matching interjection admission");
    }
  }

  async interject() {
    const result = await this.request("_x.ai/interject", {
      sessionId: this.target.id,
      text: this.text,
      interjectionId: this.promptId,
    });
    if (result?.status !== "queued") {
      throw new BridgeError("Grok returned no interjection receipt");
    }
    // The queue acknowledgement alone does not prove the actor handled the input.
    await this.confirmInterjection();
  }

  async prompt(text: string) {
    const result = await this.request("session/prompt", {
      sessionId: this.target.id,
      prompt: [{ type: "text", text }],
      _meta: { promptId: this.promptId },
    });
    if (
      result?.stopReason !== "end_turn" ||
      result?._meta?.promptId !== this.promptId ||
      result?._meta?.sessionId !== this.target.id
    ) {
      throw new BridgeError("Grok returned no matching successful completion");
    }
  }

  close() {
    this.signal.removeEventListener("abort", this.onAbort);
    this.fail(new BridgeError("Grok client stopped"));
    this.socket.destroy();
  }
}

const isAborted = (signal: AbortSignal) => signal.aborted;

export async function deliverGrok(
  target: GrokTarget,
  command: Record<string, unknown>,
  markAttempted: () => void,
  signal: AbortSignal,
  guard?: () => Promise<void>,
): Promise<void> {
  const { promptId, text } = savedNative(command, "Grok");
  let client: GrokClient | undefined;
  try {
    client = new GrokClient(target, promptId, signal, text);
    await client.load();
    if (command.phase === "attempted") {
      if (command.delivery === "steer") {
        await client.confirmInterjection();
      } else {
        await client.recover();
      }
    } else {
      if (signal.aborted) {
        return;
      }
      await guard?.();
      if (isAborted(signal)) {
        return;
      }
      // Commit before writing to the transport. Even a crash before write requires reconciliation.
      markAttempted();
      if (command.delivery === "steer") {
        await client.interject();
      } else {
        await client.prompt(text);
      }
    }
  } catch (error) {
    if (signal.aborted && error instanceof BridgeError && error.retryable) {
      throw error; // The delivery loop retains pending state and exits cleanly on interruption.
    }
    if (command.phase === "attempted") {
      throw new BridgeError(
        `Grok delivery ${promptId} is ambiguous or unsuccessful; pending retained, no resend. Reconnect to reconcile matching evidence; inspect the session before manual recovery`,
      );
    }
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError("Grok leader or client unavailable", true);
  } finally {
    client?.close();
  }
}

export const grokAdapter = nativeAdapter("grok-queue", deliverGrok);
