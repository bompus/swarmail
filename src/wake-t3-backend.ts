// Backend readiness for an opt-in reader. This module never enrolls or delivers mail.
import {
  checkBackendOperation,
  readT3Runtime,
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
 * How long a session check that gets an HTTP error or a refused connection keeps being retried, one poll at a time,
 * before the supervisor exits. A T3 restart (a nightly update) answers with errors for several seconds; an outage
 * longer than this still fails. Each poll verifies the T3 listener again, and the supervisor does its other work
 * between polls.
 */
export const T3_SESSION_CHECK_RETRY_MS = 2 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll at the consumer's cadence until ready; only individual checks have a deadline. */
export function followT3Backend(
  path: string,
  location: { baseDir: string; url?: string },
  signal?: AbortSignal,
  retryWindowMs = T3_SESSION_CHECK_RETRY_MS,
  /** Called before a verification of a listener that is new or was unavailable begins, so a caller can hold its requests. */
  onVerify?: () => void,
) {
  const credential = credentialService(path);
  let url: string | undefined;
  let published: string | undefined;
  let nextCheck = 0;
  let unavailable = false;
  let transportOutage = false;
  let retrySince: number | undefined;
  return async () => {
    const started = performance.now();
    const check: BackendCheck = { signal, deadline: started + backendCheckBudgetMs, retry: true };
    checkBackendOperation(check);
    try {
      const runtime = readT3Runtime(location.baseDir);
      if (runtime && !processAlive(runtime.pid)) {
        throw new T3Unavailable(); // A cached result must not outlive the T3 process that earned it.
      }
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
      const restarted = listener !== published;
      url = checked.url;
      published = listener;
      nextCheck = performance.now() + 60_000;
      unavailable = false; // Only verified readiness closes an outage.
      transportOutage = false;
      retrySince = undefined;
      return { url, moved, restarted };
    } catch (error) {
      checkBackendOperation(check);
      if (!(error instanceof T3Unavailable)) {
        if (error instanceof BridgeError) {
          throw error;
        }
        throw new BridgeError("T3 backend check failed; reconcile configuration and owned state");
      }
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
