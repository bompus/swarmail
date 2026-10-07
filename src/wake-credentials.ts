// One-shot, opt-in T3 bearer rotation. No service or bridge is enabled by this command.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BridgeError, localUrl, T3_TYPES } from "./wake-target.ts";
import {
  backendTimeout,
  checkBackendOperation,
  discoverT3Backend,
  T3Unavailable,
  type BackendCheck,
} from "./wake-backend.ts";
import { sameBinding } from "./wake-state.ts";

interface Credential {
  sessionId: string;
  expiresAt: string;
  digest: string;
}
interface Attempt {
  subject: string;
  credential?: Credential;
}
interface State {
  binding: string;
  disabled?: boolean;
  abandoned?: string[];
  current?: Credential;
  pending?: Attempt;
  retired: Credential[];
}
const fail = (message: string): never => {
  throw new BridgeError(message);
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function privatePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o077) !== 0
  ) {
    fail("credential paths must be private, user-owned files/directories without symlinks");
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atomic(path: string, text: string): void {
  const tmp = path + ".next";
  if (existsSync(tmp)) {
    privatePath(tmp);
    unlinkSync(tmp);
  }
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}

function readConfig(path: string) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const target = config.target;
  const rotation = config.rotation;
  if (
    !target ||
    !T3_TYPES.includes(target.type) ||
    (target.id !== undefined && (typeof target.id !== "string" || !target.id)) ||
    !rotation
  ) {
    fail("T3 target and rotation configuration required");
  }
  // With verifyBackend the CLI is the listener's own binary, so a configured executable (and
  // version, from older configs) is ignored; T3's auth responses are checked on every call.
  const verify = rotation.verifyBackend === true;
  const paths = [
    target.authorizationFile,
    rotation.baseDir,
    ...(verify ? [] : [rotation.executable]),
  ];
  for (const value of paths) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      fail("credential, executable and baseDir paths must be absolute");
    }
  }
  const ttl = rotation.ttlSeconds ?? 86400;
  const window = rotation.renewBeforeSeconds ?? 43200;
  if (rotation.verifyBackend !== undefined && typeof rotation.verifyBackend !== "boolean") {
    fail("rotation.verifyBackend must be a boolean");
  }
  if (
    !Number.isSafeInteger(ttl) ||
    !Number.isSafeInteger(window) ||
    window < 1 ||
    ttl <= window ||
    ttl > 86400 * 30
  ) {
    fail("require integer 0 < renewBeforeSeconds < ttlSeconds <= 2592000");
  }
  if (target.url === undefined && rotation.verifyBackend !== true) {
    fail("target.url is required unless rotation.verifyBackend discovers it");
  }
  // With verifyBackend, discovery replaces this before any request.
  const url = target.url === undefined ? "" : localUrl(target.url);
  // Filled from the verified listener before each CLI call when verifyBackend is set.
  let executable: string;
  let baseDir: string;
  try {
    executable = verify ? "" : realpathSync(rotation.executable);
    baseDir = realpathSync(rotation.baseDir);
  } catch {
    return fail("configured T3 executable or baseDir is unavailable; reconcile the upgrade");
  }
  const headerPath = target.authorizationFile as string;
  return {
    url,
    executable,
    baseDir,
    headerPath,
    ttl,
    window,
    verifyBackend: verify,
    type: target.type,
    /** Optional; part of the saved binding when set. */
    id: target.id as string | undefined,
  };
}
type Config = ReturnType<typeof readConfig>;

function privateCredentialParent(headerPath: string): void {
  const parent = dirname(headerPath);
  privatePath(parent, true);
  if (realpathSync(parent) !== parent) {
    fail("credential parent must use its canonical absolute path");
  }
}

function acquireLock(headerPath: string) {
  mkdirSync(dirname(headerPath), { recursive: true, mode: 0o700 });
  privateCredentialParent(headerPath);
  const root = headerPath + ".rotation";
  mkdirSync(root, { mode: 0o700, recursive: true });
  privatePath(root, true);
  const lockPath = join(root, "lock.sqlite");
  if (!existsSync(lockPath)) {
    closeSync(openSync(lockPath, "wx", 0o600));
  }
  privatePath(lockPath);
  const lock = new Database(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    fail("another credential rotator owns this file");
  }
  return { lock, root };
}

function readState(config: Config, root: string) {
  const { url, baseDir, type, id } = config;
  const statePath = join(root, "state.json");
  // A verified backend is identified by its database; its port and binary move on restart and
  // upgrade. The state lives beside its credential file, so the path needs no binding.
  const binding = JSON.stringify({ ...(config.verifyBackend ? {} : { url }), baseDir, type, id });
  if (existsSync(statePath)) {
    privatePath(statePath);
  }
  const state: State = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { binding, retired: [] };
  if (!sameBinding(state.binding, binding)) {
    fail("saved credential binding differs; reconcile before changing configuration");
  }
  const save = () => atomic(statePath, JSON.stringify(state));
  return { ...config, state, save };
}

/** Only clean, read-only session checks may produce this transient error. */
export class T3SessionTransportUnavailable extends T3Unavailable {
  readonly reason: "refused" | "reset" | "timeout";
  constructor(reason: "refused" | "reset" | "timeout") {
    super();
    this.reason = reason;
    this.message = `T3 session transport unavailable (${reason}); retrying`;
  }
}

async function sessionCheck(
  url: string,
  value: string,
  credential: Credential,
  check: BackendCheck = {},
  retryTransport = false,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(backendTimeout(15000, check));
  const signal = check.signal ? AbortSignal.any([check.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url + "/api/auth/session", {
      headers: { authorization: value },
      redirect: "error",
      signal,
    });
  } catch (error) {
    checkBackendOperation(check); // Shutdown wins a race with the request timeout.
    if (retryTransport) {
      const code = error instanceof TypeError ? (error as NodeJS.ErrnoException).code : undefined;
      const reason = timeout.aborted
        ? "timeout"
        : code === "ConnectionRefused"
          ? "refused"
          : code === "ECONNRESET"
            ? "reset"
            : undefined;
      if (reason) {
        throw new T3SessionTransportUnavailable(reason);
      }
    }
    return sanitized(error);
  }
  checkBackendOperation(check);
  if (response.status === 401) {
    return false;
  }
  if (!response.ok) {
    fail("T3 session check failed; no credential issued");
  }
  let result: {
    authenticated?: boolean;
    sessionMethod?: string;
    expiresAt?: string;
    scopes?: string[];
  };
  try {
    result = (await response.json()) as typeof result;
  } catch (error) {
    checkBackendOperation(check);
    if (retryTransport && timeout.aborted) {
      throw new T3SessionTransportUnavailable("timeout");
    }
    return sanitized(error); // Malformed JSON and interrupted bodies remain fatal.
  }
  checkBackendOperation(check);
  if (result.authenticated === false) {
    return false;
  }
  if (
    result.authenticated !== true ||
    result.sessionMethod !== "bearer-access-token" ||
    Date.parse(result.expiresAt ?? "") !== Date.parse(credential.expiresAt) ||
    !result.scopes?.includes("orchestration:operate")
  ) {
    fail("unexpected T3 session contract");
  }
  return true;
}

function readHeader(headerPath: string): string | undefined {
  if (!existsSync(headerPath)) {
    return undefined;
  }
  privatePath(headerPath);
  return readFileSync(headerPath, "utf8").trim();
}

/** The T3 CLI and session checks for a backend verified once per refresh by `backend()`. */
function t3Client(config: Config, control: BackendCheck = {}) {
  const { url, executable, baseDir, headerPath } = config;
  const run = async (command: string[]): Promise<string> => {
    checkBackendOperation(control);
    const process = Bun.spawn([executable, ...command], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: backendTimeout(20000, control),
      signal: control.signal,
      killSignal: "SIGKILL",
    });
    const [output, exit] = await Promise.all([new Response(process.stdout).text(), process.exited]);
    checkBackendOperation(control);
    if (exit !== 0) {
      fail("T3 CLI failed; credential state retained");
    }
    return output;
  };
  const cli = (command: string[]) => run(["auth", "session", ...command, "--base-dir", baseDir]);
  const header = () => readHeader(headerPath);
  const revoke = async (id: string) => {
    await cli(["revoke", id]);
  };
  const check = (value: string, credential: Credential) =>
    sessionCheck(url, value, credential, control);
  return { cli, header, revoke, check };
}

type Context = ReturnType<typeof readState>;
type Client = ReturnType<typeof t3Client>;
async function recover(ctx: Context, client: Client) {
  const { state, save } = ctx;
  const { cli, header, revoke } = client;
  // Publication may have completed immediately before a crash. Reconcile it before cleanup.
  if (state.pending?.credential && digest(header() ?? "") === state.pending.credential.digest) {
    if (state.current) {
      state.retired.push(state.current);
    }
    state.current = state.pending.credential;
    delete state.pending;
    save();
  }
  if (state.pending) {
    state.abandoned = [...(state.abandoned ?? []), state.pending.subject];
    delete state.pending;
    save();
  }
  if (state.abandoned?.length) {
    const sessions: { subject: string; sessionId: string }[] = JSON.parse(
      await cli(["list", "--json"]),
    );
    if (!Array.isArray(sessions)) {
      fail("unexpected T3 session list");
    }
    for (const subject of [...state.abandoned]) {
      const owned = sessions.filter((session) => session.subject === subject);
      if (owned.length === 0) {
        continue;
      } // The issuer can outlive a killed rotator.
      for (const session of owned) {
        await revoke(session.sessionId);
      }
      state.abandoned = state.abandoned.filter((item) => item !== subject);
      save();
    }
  }
  // Never adopt an unrelated file or recreate one removed deliberately.
  const existing = header();
  if (state.current ? digest(existing ?? "") !== state.current.digest : existing !== undefined) {
    fail("credential file differs from owned state; operator reconciliation required");
  }
  for (const credential of [...state.retired]) {
    if (Date.parse(credential.expiresAt) > Date.now()) {
      await revoke(credential.sessionId);
    }
    state.retired = state.retired.filter((item) => item.sessionId !== credential.sessionId);
    save();
  }
}

export interface CredentialResult {
  status: "current" | "rotated" | "revoked";
  expiresAt?: string;
  /** The T3 origin the credential was checked against. */
  url: string;
}

async function rotate(
  ctx: Context,
  client: Client,
  revokeOnly: boolean,
): Promise<CredentialResult> {
  const { state, save, headerPath, ttl, window } = ctx;
  const { cli, header, revoke, check } = client;
  const existing = header();
  if (revokeOnly) {
    state.disabled = true;
    save();
    if (state.current) {
      await revoke(state.current.sessionId);
      // Preserve revoked state so a scheduled run cannot recreate it.
      console.log("Owned credential revoked; disable its timer before removing state and header");
    }
    if (state.abandoned?.length) {
      fail("unresolved issuance attempts retained; reconcile before removing state");
    }
    return { status: "revoked", url: ctx.url };
  }
  if (state.disabled) {
    fail("rotation disabled by revoke; explicit operator reconciliation required");
  }
  if (state.current && Date.parse(state.current.expiresAt) > Date.now()) {
    if (
      !(await check(existing!, state.current)) &&
      Date.parse(state.current.expiresAt) > Date.now()
    ) {
      state.disabled = true;
      save();
      fail("unexpired credential rejected; automatic replacement stopped");
    }
    if (Date.parse(state.current.expiresAt) - Date.now() > window * 1000) {
      return { status: "current", expiresAt: state.current.expiresAt, url: ctx.url };
    }
  }
  state.pending = { subject: `swarmail-rotation-${randomUUID()}` };
  save(); // The subject recovers even an issued token whose CLI response was lost.
  const issued = JSON.parse(
    await cli([
      "issue",
      "--ttl",
      `${ttl}s`,
      "--subject",
      state.pending.subject,
      "--label",
      "Swarmail wake bridge",
      "--json",
    ]),
  );
  if (
    typeof issued.sessionId !== "string" ||
    !issued.sessionId ||
    typeof issued.token !== "string" ||
    !issued.token ||
    /\s/.test(issued.token) ||
    !Number.isFinite(Date.parse(issued.expiresAt)) ||
    Date.parse(issued.expiresAt) <= Date.now()
  ) {
    fail("unexpected T3 credential response; issuance intent retained");
  }
  const value = `Bearer ${issued.token}`;
  const credential = {
    sessionId: issued.sessionId,
    expiresAt: issued.expiresAt,
    digest: digest(value),
  };
  state.pending.credential = credential;
  save();
  if (!(await check(value, credential))) {
    fail("candidate credential rejected; current file retained");
  }
  atomic(headerPath, value);
  if (state.current) {
    state.retired.push(state.current);
  }
  state.current = credential;
  delete state.pending;
  save();
  for (const old of [...state.retired]) {
    await revoke(old.sessionId);
    state.retired = state.retired.filter((item) => item.sessionId !== old.sessionId);
    save();
  }
  return { status: "rotated", expiresAt: credential.expiresAt, url: ctx.url };
}

/** Child output and network errors can contain credentials, so only these messages pass. */
function sanitized(error: unknown): never {
  if (error instanceof T3Unavailable || error instanceof BridgeError) {
    throw error;
  }
  return fail(
    "operation failed; check configuration, T3 availability and owned state; no secrets logged",
  );
}

/** Snapshot only; incomplete ownership always belongs to the locked renewal path. */
function cleanCurrent(backend: Config): { current: Credential; value: string } | undefined {
  const root = backend.headerPath + ".rotation";
  if (!existsSync(join(root, "state.json"))) {
    return undefined;
  }
  privateCredentialParent(backend.headerPath);
  privatePath(root, true);
  const { state } = readState(backend, root);
  const current = state.current;
  const value = readHeader(backend.headerPath);
  if (
    !current ||
    value === undefined ||
    state.disabled ||
    state.pending ||
    state.abandoned?.length ||
    state.retired.length ||
    digest(value) !== current.digest ||
    Date.parse(current.expiresAt) - Date.now() <= backend.window * 1000
  ) {
    return undefined;
  }
  return { current, value };
}

/**
 * The credential for one config file, read once. Each refresh verifies the T3 listener once with
 * `backend()`, then runs `current()`, `renew()` or both against that backend. Errors are
 * T3Unavailable (T3 is down or restarting; retry) or a BridgeError safe to log.
 */
export function credentialService(path: string) {
  let config: Config;
  try {
    if (process.platform === "win32") {
      fail("credential rotation currently requires Unix file permissions");
    }
    config = readConfig(path);
  } catch (error) {
    sanitized(error);
  }
  return {
    /** With verifyBackend, the verified listener's URL and the executable whose CLI matches it. */
    async backend(check: BackendCheck = {}): Promise<Config> {
      checkBackendOperation(check);
      if (!config.verifyBackend) {
        return config;
      }
      try {
        const backend = await discoverT3Backend(
          {
            baseDir: config.baseDir,
            url: config.url || undefined,
          },
          check,
        );
        return { ...config, ...backend };
      } catch (error) {
        return sanitized(error);
      }
    },
    /**
     * The owned credential, checked with one session request and without the T3 CLI, the rotation
     * lock or a state write. Undefined means `renew()` must run: the credential is missing,
     * rejected, due for renewal, or its state holds unfinished work.
     */
    async current(
      backend: Config,
      check: BackendCheck = {},
    ): Promise<CredentialResult | undefined> {
      checkBackendOperation(check);
      if (!backend.verifyBackend) {
        return undefined;
      }
      let checkingSession = false;
      try {
        const owned = cleanCurrent(backend);
        if (!owned) {
          return undefined;
        }
        const { current, value } = owned;
        checkingSession = true;
        if (!(await sessionCheck(backend.url, value, current, check, true))) {
          return undefined;
        }
        const after = cleanCurrent(backend);
        if (
          !after ||
          after.value !== value ||
          after.current.sessionId !== current.sessionId ||
          after.current.expiresAt !== current.expiresAt
        ) {
          return undefined;
        }
        return { status: "current", expiresAt: current.expiresAt, url: backend.url };
      } catch (error) {
        checkBackendOperation(check);
        if (checkingSession) {
          return sanitized(error);
        }
        return undefined; // renew() reports the failure without exposing its detail.
      }
    },
    /** Recovery of unfinished work, then rotation when due, or revocation, under the lock. */
    async renew(
      backend: Config,
      revokeOnly = false,
      check: BackendCheck = {},
    ): Promise<CredentialResult> {
      let lock: Database | undefined;
      try {
        checkBackendOperation(check);
        const acquired = acquireLock(backend.headerPath);
        lock = acquired.lock;
        const ctx = readState(backend, acquired.root);
        const client = t3Client(backend, check);
        await recover(ctx, client);
        checkBackendOperation(check);
        return await rotate(ctx, client, revokeOnly);
      } catch (error) {
        return sanitized(error);
      } finally {
        lock?.close();
      }
    },
  };
}

/** One check or rotation. Exits 75 (EX_TEMPFAIL) while T3 is unavailable, 1 on any other failure. */
export async function wakeCredentials(args: string[]): Promise<number> {
  try {
    if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== "--revoke")) {
      fail("usage: swarmail wake-credentials <config.json> [--revoke]");
    }
    const service = credentialService(args[0]!);
    const result = await service.renew(await service.backend(), args[1] === "--revoke");
    if (result.status !== "revoked") {
      console.log(JSON.stringify({ status: result.status, expiresAt: result.expiresAt }));
    }
    return 0;
  } catch (error) {
    console.error(`swarmail wake-credentials: ${(error as Error).message}`);
    return error instanceof T3Unavailable ? 75 : 1;
  }
}
