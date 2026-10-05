// The delivery loop shared by bridges and controllers: wait for mail, journal it, deliver, accept.
import { BridgeError } from "./wake-target.ts";
import type { Pending, WakeState } from "./wake-state.ts";

export interface Offer {
  eventId: number;
  hint: string;
}

export interface DeliveryAdapter {
  /** The next offer after `after`, or null when the wait ended without mail. */
  wait(after: number, signal: AbortSignal): Promise<Offer | null>;
  /** The command to journal before the first delivery attempt. */
  prepare(offer: Offer): Promise<Pending["command"]> | Pending["command"];
  /** Deliver a journaled command. Call `attempted` once the destination may have received it. */
  deliver(pending: Pending, attempted: () => void, signal: AbortSignal): Promise<void>;
  /** Runs after acceptance; a failure here is logged and never stops the loop. */
  accepted(eventId: number): Promise<void> | void;
}

type Journal = Pick<WakeState, "acknowledged" | "pending" | "savePending" | "accept"> & {
  markAttempted(): void;
};

/**
 * Deliver until `signal` aborts. A retryable `BridgeError` backs off from 1 s to 30 s and keeps
 * the journaled command for the next attempt; any other error rejects with it still journaled.
 */
export async function deliveryLoop(
  journal: Journal,
  adapter: DeliveryAdapter,
  { signal, label }: { signal: AbortSignal; label: string },
) {
  // A function, so a check after an await is not narrowed to the loop condition's value.
  const isStopped = () => signal.aborted;
  let backoff = 1000;
  while (!isStopped()) {
    try {
      if (!journal.pending) {
        const offer = await adapter.wait(journal.acknowledged, signal);
        if (!offer) {
          continue;
        }
        journal.savePending({ eventId: offer.eventId, command: await adapter.prepare(offer) });
      }
      const pending = journal.pending!;
      if (isStopped()) {
        break; // The pending command stays in the journal for the next run.
      }
      await adapter.deliver(pending, () => journal.markAttempted(), signal);
      if (isStopped()) {
        break; // Delivery can stop before receiving a receipt. Keep its immutable retry.
      }
      journal.accept(pending.eventId);
      backoff = 1000;
      try {
        await adapter.accepted(pending.eventId);
      } catch (error) {
        if (!isStopped()) {
          console.error(
            `${label}: ${error instanceof Error ? error.message : "after-delivery step failed"}`,
          );
        }
      }
    } catch (error) {
      if (isStopped() && (!(error instanceof BridgeError) || error.retryable)) {
        break;
      }
      if (!(error instanceof BridgeError) || !error.retryable) {
        throw error;
      }
      console.error(`${label}: ${error.message}; retry in ${backoff / 1000}s`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, backoff);
        signal.addEventListener("abort", done, { once: true });
      });
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
