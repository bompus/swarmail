// Approved local update targets and session attestations, independent of mail and its receipts.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildSource } from "./build.ts";
import { renameOver } from "./files.ts";
import { stateHome } from "./paths.ts";
import { withLock, selfSession } from "./registry.ts";
import { SESSION_RE } from "./wake.ts";

interface Target {
  revision: string;
  instruction: string;
  context?: boolean;
  hosts?: string[];
}
interface Targets {
  version: 1;
  targets: Record<string, Target>;
  heldSessions?: string[];
}
interface Loaded {
  revision: string;
  evidence: "attested";
  at: string;
  context?: boolean;
}
interface State {
  loaded: Record<string, Loaded>;
  hintPending: boolean;
  contextReset?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const componentName = /^[a-z][a-z0-9_.-]{0,95}$/;
const hostName = /^[a-z][a-z0-9-]{0,31}$/;

function readTargets(path: string): Targets {
  if (!isAbsolute(path)) {
    throw new Error("SWARMAIL_UPDATE_TARGETS must be an absolute path");
  }
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 65536) {
    throw new Error("update targets exceed 64 KiB");
  }
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1 || !record(value.targets)) {
    throw new Error("invalid update targets");
  }
  const entries = Object.entries(value.targets);
  if (
    entries.length > 32 ||
    entries.some(
      ([key, target]) =>
        !componentName.test(key) ||
        !record(target) ||
        typeof target.revision !== "string" ||
        !/^[\w.:-]{1,160}$/.test(target.revision) ||
        typeof target.instruction !== "string" ||
        !target.instruction.trim() ||
        target.instruction.length > 1000 ||
        (target.context !== undefined && typeof target.context !== "boolean") ||
        (target.hosts !== undefined &&
          (!Array.isArray(target.hosts) ||
            !target.hosts.length ||
            target.hosts.some((host) => typeof host !== "string" || !hostName.test(host)))),
    ) ||
    (value.heldSessions !== undefined &&
      (!Array.isArray(value.heldSessions) ||
        value.heldSessions.some((sid) => typeof sid !== "string" || !SESSION_RE.test(sid))))
  ) {
    throw new Error("invalid update targets");
  }
  const validated = value as unknown as Targets;
  return {
    version: 1,
    targets: Object.fromEntries(
      Object.entries(validated.targets).map(([key, target]) => [
        key,
        {
          revision: target.revision,
          instruction: target.instruction,
          ...(target.context !== undefined && { context: target.context }),
          ...(target.hosts && { hosts: target.hosts }),
        },
      ]),
    ),
    ...(validated.heldSessions && { heldSessions: validated.heldSessions }),
  };
}

function readState(file: string): State {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (record(value) && record(value.loaded) && typeof value.hintPending === "boolean") {
      const loaded = Object.fromEntries(
        Object.entries(value.loaded).filter(
          ([key, item]) =>
            componentName.test(key) &&
            record(item) &&
            typeof item.revision === "string" &&
            item.evidence === "attested" &&
            typeof item.at === "string" &&
            (item.context === undefined || typeof item.context === "boolean"),
        ),
      ) as Record<string, Loaded>;
      return {
        loaded,
        hintPending: value.hintPending,
        ...(typeof value.contextReset === "string" && { contextReset: value.contextReset }),
      };
    }
  } catch {
    // Missing or damaged evidence is unknown, never proof of a loaded revision.
  }
  return { loaded: {}, hintPending: false };
}

function scopedTargets(manifest: Targets, host?: string): Targets {
  if (!host && Object.values(manifest.targets).some((target) => target.hosts)) {
    throw new Error("host identity is required for provider-scoped update targets");
  }
  return {
    ...manifest,
    targets: Object.fromEntries(
      Object.entries(manifest.targets).filter(
        ([, target]) => !target.hosts || target.hosts.includes(host!),
      ),
    ),
  };
}

export interface UpdateOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  notify?: boolean;
  resetContext?: boolean;
  ack?: { component: string; revision: string };
}

interface UpdateStatus {
  session_id: string;
  cli_build: string | null;
  status: string;
  targets: Array<Target & { component: string; loaded: Loaded | null; status: string }>;
  hint: string;
}

function isHeld(manifest: Targets, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return env.SWARMAIL_UPDATE_HOLD === "1" || !!manifest.heldSessions?.includes(sessionId);
}

function queueReset(file: string): void {
  const generation = randomUUID();
  const temporary = `${file}.${generation}.tmp`;
  try {
    writeFileSync(temporary, generation);
    renameOver(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function consumeReset(file: string, state: State): void {
  let generation: string;
  try {
    generation = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (generation !== state.contextReset) {
    for (const [key, loaded] of Object.entries(state.loaded)) {
      if (loaded.context) {
        delete state.loaded[key];
        state.hintPending = false;
      }
    }
    state.contextReset = generation;
  }
}

/** Checks approved targets under the session lock; a claimed hint is not a loaded attestation. */
export function sessionUpdates(sessionId: string, options: UpdateOptions = {}): UpdateStatus {
  const env = options.env ?? process.env;
  const base = { session_id: sessionId, cli_build: buildSource };
  if (!SESSION_RE.test(sessionId)) {
    throw new Error("invalid update session identifier");
  }
  if (options.host !== undefined && !hostName.test(options.host)) {
    throw new Error("invalid update host identifier");
  }
  if (!env.SWARMAIL_UPDATE_TARGETS) {
    if (options.ack) {
      throw new Error("no approved update targets configured");
    }
    return { ...base, status: "unconfigured", targets: [], hint: "" };
  }
  const dir = join(stateHome(env), "swarmail-updates");
  const identity = options.host ? `${options.host}-${sessionId}` : sessionId;
  const file = join(dir, `${identity}.json`);
  // Validate before creating state; the host must publish a complete manifest atomically.
  const initial = scopedTargets(readTargets(env.SWARMAIL_UPDATE_TARGETS), options.host);
  mkdirSync(dir, { recursive: true });
  const resetFile = join(dir, `${identity}.reset`);
  if (options.resetContext && !isHeld(initial, sessionId, env)) {
    queueReset(resetFile);
  }
  let result: UpdateStatus | undefined;
  const locked = withLock(
    join(dir, `${identity}.lock`),
    () => {
      const approved = scopedTargets(readTargets(env.SWARMAIL_UPDATE_TARGETS!), options.host);
      const before = readState(file);
      const state = { ...before, loaded: { ...before.loaded } };
      const held = isHeld(approved, sessionId, env);
      if (held && options.ack) {
        throw new Error("update session is held");
      }
      if (!held) {
        consumeReset(resetFile, state);
      }
      if (options.ack) {
        const { component, revision } = options.ack;
        const target = Object.hasOwn(approved.targets, component)
          ? approved.targets[component]
          : undefined;
        if (!target || target.revision !== revision) {
          throw new Error(
            "update target changed or is unknown; inspect current targets before refreshing",
          );
        }
        state.loaded[component] = {
          revision,
          evidence: "attested",
          at: new Date().toISOString(),
          ...(target.context && { context: true }),
        };
      }
      const targets = Object.entries(approved.targets).map(([component, target]) => {
        const loaded = Object.hasOwn(state.loaded, component) ? state.loaded[component] : undefined;
        return {
          component,
          ...target,
          loaded: loaded ?? null,
          status: held ? "held" : loaded?.revision === target.revision ? "attested" : "pending",
        };
      });
      const pending = targets.some((target) => target.loaded?.revision !== target.revision);
      if (!pending) {
        state.hintPending = false;
      }
      const hint =
        pending && !held && options.notify && !state.hintPending
          ? "Updates available: run swarmail updates --session."
          : "";
      if (hint) {
        state.hintPending = true;
      }
      if (JSON.stringify(state) !== JSON.stringify(before)) {
        writeFileSync(`${file}.tmp`, JSON.stringify(state) + "\n");
        renameOver(`${file}.tmp`, file);
      }
      result = {
        ...base,
        status: held
          ? "held"
          : pending
            ? "pending"
            : targets.length
              ? "attested"
              : "not_applicable",
        targets,
        hint,
      };
    },
    { waitMs: options.notify ? 0 : 9000 },
  );
  if (!locked || !result) {
    throw new Error("update session state is busy");
  }
  return result;
}

/** Quiet, opt-in context hints: no network, mail, installation or idle-turn wake. */
export function updateHint(
  sessionId: string,
  resetContext = false,
  env = process.env,
  host?: string,
): string {
  try {
    return sessionUpdates(sessionId, { env, host, notify: true, resetContext }).hint;
  } catch {
    // A missing manifest or a held lock must not block tools; the explicit status command reports errors.
    return "";
  }
}

export async function updatesCommand(args: string[]): Promise<void> {
  const allowed = new Set(["--session", "--json", "--reset-context", "--ack", "--revision"]);
  const flags = new Set<string>();
  let component: string | undefined, revision: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!allowed.has(arg) || flags.has(arg)) {
      throw new Error("invalid updates arguments");
    }
    flags.add(arg);
    if (arg === "--ack" || arg === "--revision") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === "--ack") {
        component = value;
      } else {
        revision = value;
      }
    }
  }
  if (!flags.has("--session") || !!component !== !!revision) {
    throw new Error("updates requires --session; --ack and --revision must be supplied together");
  }
  const session = selfSession();
  const result = sessionUpdates(session.session_id, {
    host: session.host,
    resetContext: flags.has("--reset-context"),
    ...(component && revision && { ack: { component, revision } }),
  });
  console.log(JSON.stringify(result));
}
