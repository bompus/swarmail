// Shared parts of the Grok and Codex native adapters: Unix socket config, prompt IDs, saved phases.
import { isAbsolute } from "node:path";
import { BridgeError } from "./wake-target.ts";
import type { TargetAdapter } from "./wake-target.ts";

export interface NativeTarget<T extends string> {
  type: T;
  id: string;
  socket: string;
  cwd: string;
  timeoutMs: number;
}

export interface SavedNative {
  promptId: string;
  text: string;
  phase: "prepared" | "attempted";
  delivery?: "steer";
}

/** The saved command, or an error naming `host` when local state is not a native delivery. */
export function savedNative(command: Record<string, unknown>, host: string): SavedNative {
  if (
    typeof command.promptId !== "string" ||
    !/^[\w-]+$/.test(command.promptId) ||
    typeof command.text !== "string" ||
    (command.delivery !== undefined && command.delivery !== "steer") ||
    !["prepared", "attempted"].includes(String(command.phase))
  ) {
    throw new BridgeError(`invalid saved ${host} delivery; reconcile the local state`);
  }
  return command as unknown as SavedNative;
}

/**
 * One native delivery adapter. `deliver` receives the saved command object itself: marking it
 * attempted changes its phase in place, which its error handling reads.
 */
export function nativeAdapter<T extends string>(
  type: T,
  deliver: (
    target: NativeTarget<T>,
    command: Record<string, unknown>,
    markAttempted: () => void,
    signal: AbortSignal,
  ) => Promise<void>,
  checkSocket: (socket: string) => void = () => {},
): TargetAdapter<NativeTarget<T>> {
  return {
    parse: (target) => {
      if (
        process.platform === "win32" ||
        ![target.socket, target.cwd].every((path) => typeof path === "string" && isAbsolute(path))
      ) {
        throw new BridgeError(
          "native queue targets require Unix and absolute socket and cwd paths",
        );
      }
      checkSocket(target.socket);
      const timeoutMs = target.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
        throw new BridgeError("native queue timeoutMs must be between 1000 and 300000");
      }
      return { type, id: target.id, socket: target.socket, cwd: target.cwd, timeoutMs };
    },
    binding: (target) => ({ socket: target.socket, cwd: target.cwd }),
    prepare: (_target, hint) => ({
      promptId: crypto.randomUUID(),
      text: hint,
      phase: "prepared",
      delivery: "steer",
    }),
    deliver: async (target, command, attempted, signal) => {
      await deliver(target, command, attempted, signal);
      if (signal.aborted) {
        // A native delivery returns on abort without confirming admission.
        throw new BridgeError("stopped", true);
      }
    },
  };
}
