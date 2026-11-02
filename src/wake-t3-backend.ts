// Backend readiness for an opt-in reader. This module never enrolls or delivers mail.
import {
  checkBackendOperation,
  readT3Runtime,
  T3IdentityPending,
  T3Unavailable,
  type BackendCheck,
} from "./wake-backend.ts";
import {
  credentialService,
  T3SessionRetry,
  T3SessionTransportUnavailable,
} from "./wake-credentials.ts";
import { BridgeError } from "./wake-target.ts";

const backendCheckBudgetMs = 5 * 60_000;

/**
 * How long the follower keeps polling, one poll at a time, while T3 restarts or updates itself before the supervisor
 * exits: for a session check that gets an HTTP error or a refused connection, and, counted separately, for a
 * listener whose identity cannot be verified yet (its database is not open, two processes share the port, it
 * exited during the check). The 2 minutes are about four times what the observed updates needed: systemd restarted
 * the exited service 30 s after each and it verified at once. A failure still going after the window is fatal, and a
 * verified different identity never waits. Each poll verifies the T3 listener again, and the supervisor does its
 * other work between polls.
 */
export const T3_RESTART_WAIT_MS = 2 * 60_000;

/** Poll at the consumer's cadence until ready; only individual checks have a deadline. */
export function followT3Backend(
  path: string,
  location: { baseDir: string; url?: string },
  signal?: AbortSignal,
  retryWindowMs = T3_RESTART_WAIT_MS,
  /**
   * Called, with nothing awaited since the follower found out, when it starts verifying a listener that is new or was
   * unavailable and when it finds the backend unavailable, so a caller can hold its requests before the poll resolves.
   */
  onVerify?: () => void,
) {
  const credential = credentialService(path);
  let url: string | undefined;
  let published: string | undefined;
  let nextCheck = 0;
  let unavailable = false;
  let transportOutage = false;
  let retrySince: number | undefined;
  let pendingSince: number | undefined;
  let pendingLogged = false;
  let identityWaited = false; // Set by an identity wait, cleared only by the next verified readiness.
  return async () => {
    const started = performance.now();
    const check: BackendCheck = { signal, deadline: started + backendCheckBudgetMs, retry: true };
    checkBackendOperation(check);
    try {
      const runtime = readT3Runtime(location.baseDir);
      const listener = runtime ? `${runtime.url} ${runtime.pid}` : location.url;
      const same = url !== undefined && listener === published;
      if (!unavailable && same && started < nextCheck) {
        return { url: url!, moved: false, restarted: false };
      }
      if (!same || unavailable) {
        onVerify?.();
      }
      const backend = await credential.backend(check);
      let checked = await credential.current(backend, check);
      if (!checked) {
        if (transportOutage) {
          throw new BridgeError(
            "credential no longer eligible for transport retry; reconcile owned state",
          );
        }
        checked = await credential.renew(backend, false, check);
        if (checked.status === "rotated") {
          console.log("T3 wake credential renewed");
        }
      }
      checkBackendOperation(check);
      const moved = checked.url !== url;
      // A wait for the identity counts as a restart even on the same listener: T3 was updating and may have replaced
      // its database meanwhile, so the caller must open the new one.
      const restarted = listener !== published || identityWaited;
      url = checked.url;
      published = listener;
      nextCheck = performance.now() + 60_000;
      unavailable = false; // Only verified readiness closes an outage.
      transportOutage = false;
      retrySince = undefined;
      pendingSince = undefined;
      pendingLogged = false;
      identityWaited = false;
      return { url, moved, restarted };
    } catch (error) {
      checkBackendOperation(check);
      if (!(error instanceof T3Unavailable)) {
        if (error instanceof BridgeError) {
          throw error;
        }
        throw new BridgeError("T3 backend check failed; reconcile configuration and owned state");
      }
      onVerify?.(); // Any unavailable result holds the caller's requests before this poll resolves.
      if (error instanceof T3IdentityPending) {
        // T3 is up but its identity is not verifiable yet, as while it updates. Wait, bounded; nothing is sent to it.
        identityWaited = true;
        const waited = performance.now() - (pendingSince ??= performance.now());
        if (waited >= retryWindowMs) {
          return error.giveUp();
        }
        if (!pendingLogged) {
          pendingLogged = true;
          console.warn(
            `${error.message.replace("; retrying", "")}; waiting up to ${Math.round(retryWindowMs / 1000)} s for T3 to finish updating`,
          );
        }
        unavailable = true;
        return undefined;
      }
      pendingSince = undefined; // A wait that another failure broke does not count against the next one.
      pendingLogged = false;
      if (error instanceof T3SessionRetry) {
        // Poll again: the listener is verified again first, and the supervisor's other work runs between polls.
        const waited = performance.now() - (retrySince ??= performance.now());
        if (waited >= retryWindowMs) {
          return error.giveUp();
        }
        console.warn(
          `${error.message} (${Math.round(waited / 1000)} s of ${Math.round(retryWindowMs / 1000)} s)`,
        );
        unavailable = true;
        return undefined;
      }
      // Eligibility is established by a clean session check, not listener absence.
      if (error instanceof T3SessionTransportUnavailable) {
        transportOutage = true;
      }
      if (!unavailable) {
        unavailable = true;
        console.warn("T3 backend unavailable; waiting for verified readiness");
      }
      return undefined;
    }
  };
}
