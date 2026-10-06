// A failed eligibility check retains pending mail and its immutable retry.
import { BridgeError } from "./wake-target.ts";

export async function ensureWakeEligible(
  base: string,
  session: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const url = new URL("/wait/status", base);
    url.searchParams.set("session", session);
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (!response.ok || ((await response.json()) as { eligible?: unknown }).eligible !== true) {
      throw new Error("held");
    }
  } catch {
    throw new BridgeError("receiver lifecycle unavailable or inactive; holding mail", true);
  }
}
