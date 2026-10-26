// A failed eligibility check retains pending mail and its immutable retry.
import {
  BridgeError,
  TargetAuthenticationError,
  rejectedToken,
  serverHeaders,
} from "./wake-target.ts";

export async function ensureWakeEligible(
  base: string,
  session: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const headers = serverHeaders(base, env);
  try {
    const url = new URL("/wait/status", base);
    url.searchParams.set("session", session);
    const response = await fetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
      redirect: "error",
    });
    rejectedToken(response.status);
    if (!response.ok || ((await response.json()) as { eligible?: unknown }).eligible !== true) {
      throw new Error("held");
    }
  } catch (error) {
    if (error instanceof TargetAuthenticationError) {
      throw error;
    }
    throw new BridgeError("receiver lifecycle unavailable or inactive; holding mail", true);
  }
}
