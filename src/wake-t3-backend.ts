// Backend readiness for an opt-in reader. This module never enrolls or delivers mail.
import {
  checkBackendOperation,
  readT3Runtime,
  T3Unavailable,
  type BackendCheck,
} from "./wake-backend.ts";
import { credentialService, T3SessionTransportUnavailable } from "./wake-credentials.ts";
import { BridgeError } from "./wake-target.ts";

const unavailableGraceMs = 5 * 60_000;

/** Poll with the consumer's existing cadence. Each outage has one absolute grace deadline. */
export function followT3Backend(
  path: string,
  location: { baseDir: string; url?: string },
  signal?: AbortSignal,
) {
  const credential = credentialService(path);
  let url: string | undefined;
  let published: string | undefined;
  let nextCheck = 0;
  let deadline: number | undefined;
  let transportOutage = false;
  return async () => {
    const started = performance.now();
    const check: BackendCheck = { signal, deadline: deadline ?? started + unavailableGraceMs };
    checkBackendOperation(check);
    try {
      const runtime = readT3Runtime(location.baseDir);
      const listener = runtime ? `${runtime.url} ${runtime.pid}` : location.url;
      const same = url !== undefined && listener === published;
      if (deadline === undefined && same && started < nextCheck) {
        return { url: url!, moved: false, restarted: false };
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
      deadline = undefined; // Only verified readiness closes an outage.
      transportOutage = false;
      return { url, moved, restarted };
    } catch (error) {
      checkBackendOperation(check);
      if (!(error instanceof T3Unavailable)) {
        if (error instanceof BridgeError) {
          throw error;
        }
        throw new BridgeError("T3 backend check failed; reconcile configuration and owned state");
      }
      // Eligibility is established by a clean session check, not listener absence.
      if (error instanceof T3SessionTransportUnavailable) {
        transportOutage = true;
      }
      if (deadline === undefined) {
        deadline = started + unavailableGraceMs;
        console.warn("T3 backend unavailable; waiting within the existing grace budget");
      }
      checkBackendOperation({ signal, deadline });
      return undefined;
    }
  };
}
