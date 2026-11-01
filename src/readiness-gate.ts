// Whether the automatic supervisor currently has a verified T3 backend. Bridge requests wait on it.
import { BridgeError } from "./wake-target.ts";

/**
 * Closed until the supervisor has verified the T3 listener, and closed again whenever its next check cannot.
 * A bridge awaits `ready()` before each request that carries T3 credentials, so none is sent to a listener the
 * supervisor has not verified, and a request is not made at a T3 that is still starting. A wait is not an error and
 * counts as no retry; it ends when the gate opens or its signal aborts.
 */
export class ReadinessGate {
  #open = false;
  #closedAt: number | undefined;
  #epoch = 0;
  readonly #waiting = new Set<() => void>();

  get isOpen(): boolean {
    return this.#open;
  }

  /** How many times the gate has closed. A delivery that spans a change knows the backend was unverified meanwhile. */
  get epoch(): number {
    return this.#epoch;
  }

  /** Holds requests from now on. Returns whether this changed the gate (it was open). */
  close(now = performance.now()): boolean {
    if (!this.#open) {
      return false;
    }
    this.#open = false;
    this.#closedAt = now;
    this.#epoch++;
    return true;
  }

  /**
   * Lets waiting requests through. Returns how many milliseconds the gate held them since it was last closed, or
   * undefined when this did not end a hold (it was already open, or it had never been closed).
   */
  open(now = performance.now()): number | undefined {
    if (this.#open) {
      return undefined;
    }
    this.#open = true;
    const held = this.#closedAt === undefined ? undefined : now - this.#closedAt;
    this.#closedAt = undefined;
    for (const release of [...this.#waiting]) {
      release();
    }
    return held;
  }

  /**
   * The `WakeTarget` fields that make a bridge's requests wait on this gate and stop with `signal`: `ready` waits,
   * and `isReady` is the final check made with nothing awaited before a request is sent.
   */
  admission(signal: AbortSignal) {
    return {
      ready: () => this.ready(signal),
      isReady: () => this.#open && !signal.aborted,
      epoch: () => this.#epoch,
    };
  }

  /**
   * Resolves when the gate is open. An abort, including one already made while the gate is open, ends the wait with a
   * retryable error, as a stopping bridge expects: it starts no further request.
   */
  ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new BridgeError("T3 readiness wait cancelled", true));
    }
    if (this.#open) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const release = () => {
        this.#waiting.delete(release);
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        this.#waiting.delete(release);
        reject(new BridgeError("T3 readiness wait cancelled", true));
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      this.#waiting.add(release);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}
