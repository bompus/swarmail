// One destination per bridge: a `wake-bridge` process, or a runner inside the T3 supervisor.
// SQLite holds the pending command and an owner lock released when its connection closes.
import { readFileSync } from "node:fs";
import { BridgeError, localUrl, openCodeAdapter, t3V1Adapter, t3V2Adapter } from "./wake-target.ts";
import type { TargetAdapter, WakeTarget } from "./wake-target.ts";
import { grokAdapter } from "./wake-grok.ts";
import type { GrokTarget } from "./wake-grok.ts";
import { codexAdapter } from "./wake-codex.ts";
import type { CodexTarget } from "./wake-codex.ts";
import { SESSION_RE } from "./wake.ts";
import { openWakeState, waitForOffer } from "./wake-state.ts";
import type { Pending, WakeState } from "./wake-state.ts";
import { deliveryLoop } from "./wake-loop.ts";
import { t3NoticeAdapter } from "./wake-t3-notice.ts";

type Target = WakeTarget | GrokTarget | CodexTarget;

/** Every wake target type. A new one adds a row here and nothing else in the bridge. */
// The HTTP types share WakeTarget, whose `type` is itself a union.
type TargetOf<K> = K extends WakeTarget["type"] ? WakeTarget : Extract<Target, { type: K }>;
const ADAPTERS: { [K in Target["type"]]: TargetAdapter<TargetOf<K>> } = {
  "t3-v1-steer": t3V1Adapter,
  "t3-v2-queue": t3V2Adapter,
  "opencode-v2-queue": openCodeAdapter,
  "grok-queue": grokAdapter,
  "codex-queue": codexAdapter,
};

function adapterFor(type: string): TargetAdapter<Target> | undefined {
  return Object.hasOwn(ADAPTERS, type)
    ? (ADAPTERS[type as Target["type"]] as TargetAdapter<Target>)
    : undefined;
}

export interface BridgeConfig {
  swarmailUrl: string;
  target: Target;
}

function readConfig(path: string): BridgeConfig {
  const input = JSON.parse(readFileSync(path, "utf8"));
  const target = input?.target;
  if (!target || typeof target.id !== "string" || !SESSION_RE.test(target.id)) {
    throw new BridgeError("config requires a target session/thread id");
  }
  const swarmailUrl = localUrl(input.swarmailUrl ?? "http://127.0.0.1:18765");
  const adapter = adapterFor(target.type);
  if (!adapter) {
    throw new BridgeError("config requires target type and absolute authorizationFile");
  }
  return { swarmailUrl, target: adapter.parse(target) };
}

/** Deliver wake hints until `stop` aborts; a non-retryable error rejects. */
export async function runBridge(
  config: BridgeConfig,
  state: WakeState,
  stop: AbortController,
  label = "swarmail wake-bridge",
) {
  const target = config.target;
  const adapter = adapterFor(target.type)!;
  const delivery =
    target.type === "t3-v2-queue"
      ? t3NoticeAdapter(config as BridgeConfig & { target: WakeTarget }, state)
      : {
          wait: (after: number, signal: AbortSignal) => waitForOffer(config, after, signal),
          prepare: (offer: { hint: string }) => adapter.prepare(target, offer.hint),
          deliver: (pending: Pending, attempted: () => void, signal: AbortSignal) =>
            adapter.deliver(target, pending.command, attempted, signal),
        };
  await deliveryLoop(
    state,
    {
      ...delivery,
      accepted: (eventId) => console.error(`${label}: admitted mail through ${eventId}`),
    },
    { signal: stop.signal, label },
  );
}

/** The destination a bridge's state is bound to: its adapter's binding fields, type and id. */
export function bridgeBinding(target: Target): string {
  return JSON.stringify({
    ...adapterFor(target.type)!.binding(target),
    type: target.type,
    id: target.id,
  });
}

export async function wakeBridge(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] === "--help") {
    console.error(
      "usage: swarmail wake-bridge <config.json> (explicit target; see docs/wake-bridges.md)",
    );
    return args[0] === "--help" ? 0 : 64;
  }
  let state: WakeState | undefined;
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const config = readConfig(args[0]!);
    state = openWakeState(config.swarmailUrl, config.target.id, bridgeBinding(config.target));
    console.error(`swarmail wake-bridge: ${config.target.type} enabled for ${config.target.id}`);
    await runBridge(config, state, stop);
    return 0;
  } catch (error) {
    // Remote bodies, URLs with tickets, and file contents never enter diagnostics.
    console.error(
      `swarmail wake-bridge: ${error instanceof BridgeError ? error.message : "invalid configuration or local state"}`,
    );
    return 1;
  } finally {
    state?.close();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}
