import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionUpdates, updateHint } from "../src/updates.ts";
import { createServer } from "../src/server.ts";
import { SESSION_ENV } from "../src/tag.ts";

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    fn();
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "updates-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, "targets.json");
  const env = { XDG_STATE_HOME: dir, SWARMAIL_UPDATE_TARGETS: manifest };
  const publish = (revision, held = false) =>
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        targets: {
          guidance: { revision, instruction: "Reread the instruction root.", context: true },
        },
        ...(held && { heldSessions: ["receiver"] }),
      }),
    );
  const check = (options = {}) => sessionUpdates("receiver", { env, ...options });
  const stateFile = join(dir, "swarmail-updates", "receiver.json");
  publish("A");
  return { dir, manifest, env, publish, check, stateFile };
}

test("absent approval leaves hooks silent and creates no state", () => {
  const f = fixture();
  expect(
    sessionUpdates("receiver", { env: { XDG_STATE_HOME: f.dir }, notify: true }),
  ).toMatchObject({
    status: "unconfigured",
    hint: "",
    targets: [],
  });
  expect(existsSync(join(f.dir, "swarmail-updates"))).toBe(false);
});

test("one pending hint covers newer targets; stale acknowledgment cannot consume them", () => {
  const f = fixture();
  expect(f.check({ notify: true }).hint).toContain("swarmail updates --session");
  expect(f.check({ notify: true }).hint).toBe("");
  expect(f.check().targets[0]).toMatchObject({ status: "pending", loaded: null });
  f.publish("B");
  expect(f.check({ notify: true })).toMatchObject({ hint: "", targets: [{ revision: "B" }] });
  expect(() => f.check({ ack: { component: "guidance", revision: "A" } })).toThrow(
    "target changed",
  );
  expect(f.check().targets[0].loaded).toBeNull();
  expect(f.check({ ack: { component: "guidance", revision: "B" } }).targets[0]).toMatchObject({
    status: "attested",
    loaded: { revision: "B", evidence: "attested" },
  });
  f.publish("C");
  expect(f.check({ notify: true }).hint).not.toBe("");
  expect(f.check().targets[0]).toMatchObject({ status: "pending", loaded: { revision: "B" } });
});

test("holds preserve loaded state and suppress output until an explicit reset after release", () => {
  const f = fixture();
  f.check({ ack: { component: "guidance", revision: "A" } });
  const before = readFileSync(f.stateFile, "utf8");
  f.publish("B", true);
  expect(f.check({ notify: true, resetContext: true })).toMatchObject({ status: "held", hint: "" });
  expect(() => f.check({ ack: { component: "guidance", revision: "B" } })).toThrow("held");
  expect(readFileSync(f.stateFile, "utf8")).toBe(before);
  f.publish("B");
  expect(f.check({ resetContext: true, notify: true }).targets[0].loaded).toBeNull();
  expect(f.check({ resetContext: true, notify: true }).hint).toBe("");
  expect(
    sessionUpdates("other", { env: { ...f.env, SWARMAIL_UPDATE_HOLD: "1" }, notify: true }),
  ).toMatchObject({
    status: "held",
    hint: "",
  });
});

test("context reset invalidates guidance but keeps runtime attestations", () => {
  const f = fixture();
  writeFileSync(
    f.manifest,
    JSON.stringify({
      version: 1,
      targets: {
        guidance: { revision: "A", instruction: "Read guidance", context: true },
        tools: { revision: "T", instruction: "Reload tools" },
      },
    }),
  );
  f.check({ ack: { component: "guidance", revision: "A" } });
  f.check({ ack: { component: "tools", revision: "T" } });
  expect(f.check({ resetContext: true, notify: true }).targets).toMatchObject([
    { component: "guidance", status: "pending", loaded: null },
    { component: "tools", status: "attested", loaded: { revision: "T" } },
  ]);
});

test("a contended context reset stays pending until a later hook can invalidate loaded guidance", () => {
  const f = fixture();
  f.check({ ack: { component: "guidance", revision: "A" } });
  const lock = join(f.dir, "swarmail-updates", "receiver.lock");
  writeFileSync(lock, "");
  expect(updateHint("receiver", true, f.env)).toBe("");
  rmSync(lock);
  expect(f.check({ notify: true })).toMatchObject({
    hint: "Updates available: run swarmail updates --session.",
    targets: [{ component: "guidance", status: "pending", loaded: null }],
  });
  expect(f.check({ notify: true }).hint).toBe("");
});

test("a reset invalidates contextual evidence even when its target is temporarily omitted", () => {
  const f = fixture();
  f.check({ ack: { component: "guidance", revision: "A" } });
  writeFileSync(f.manifest, JSON.stringify({ version: 1, targets: {} }));
  f.check({ resetContext: true });
  f.publish("A");
  expect(f.check().targets[0]).toMatchObject({ status: "pending", loaded: null });
});

test("extra descriptor fields cannot replace the component identity or status fields", () => {
  const f = fixture();
  const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
  Object.assign(manifest.targets.guidance, { component: "other", status: "attested", loaded: {} });
  writeFileSync(f.manifest, JSON.stringify(manifest));
  expect(f.check().targets[0]).toMatchObject({
    component: "guidance",
    loaded: null,
    status: "pending",
  });
});

test("the manifest limit counts UTF-8 bytes rather than characters", () => {
  const f = fixture();
  const targets = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [
      `component${i}`,
      { revision: "A", instruction: "あ".repeat(1000) },
    ]),
  );
  writeFileSync(f.manifest, JSON.stringify({ version: 1, targets }));
  expect(() => f.check()).toThrow("64 KiB");
});

test("provider-scoped targets exclude sibling guidance and keep same-ID sessions separate", () => {
  const f = fixture();
  writeFileSync(
    f.manifest,
    JSON.stringify({
      version: 1,
      targets: {
        "guidance.codex": { revision: "A", instruction: "Read Codex guidance", hosts: ["codex"] },
        "guidance.claude": {
          revision: "B",
          instruction: "Read Claude guidance",
          hosts: ["claude"],
        },
        constructor: { revision: "C", instruction: "Check a generic component" },
      },
    }),
  );
  expect(() => f.check()).toThrow("host identity");
  expect(f.check({ host: "codex" }).targets.map((target) => target.component)).toEqual([
    "guidance.codex",
    "constructor",
  ]);
  expect(f.check({ host: "codex" }).targets[1].loaded).toBeNull();
  f.check({ host: "codex", ack: { component: "guidance.codex", revision: "A" } });
  expect(f.check({ host: "claude" }).targets[0]).toMatchObject({
    component: "guidance.claude",
    loaded: null,
  });
  expect(() =>
    f.check({ host: "codex", ack: { component: "guidance.claude", revision: "B" } }),
  ).toThrow("unknown");
});

test("start context uses supported provider output, while unqualified hosts stay silent", async () => {
  const f = fixture();
  const entry = join(import.meta.dir, "../src/cli.ts");
  for (const host of ["claude", "devin", "cursor", "codex", "grok", "agy", "opencode"]) {
    const event = host === "cursor" ? "sessionStart" : "SessionStart";
    const child = Bun.spawn([process.execPath, entry, "register", "--host", host], {
      env: { ...process.env, ...f.env },
      stdin: new Blob([JSON.stringify({ session_id: host, cwd: f.dir, hook_event_name: event })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (["claude", "devin", "cursor"].includes(host)) {
      const output = JSON.parse(text);
      const context =
        host === "cursor" ? output.additional_context : output.hookSpecificOutput.additionalContext;
      expect(context).toContain("Updates available: run swarmail updates --session.");
      expect(output).not.toHaveProperty("decision");
      expect(sessionUpdates(host, { env: f.env, host }).targets[0].loaded).toBeNull();
    } else {
      expect(text).toBe("");
      expect(existsSync(join(f.dir, "swarmail-updates", `${host}-${host}.json`))).toBe(false);
    }
  }
});

test("the public session command reads and acknowledges the exact approved target", async () => {
  const f = fixture();
  const env = { ...process.env, ...f.env, T3_HOME: f.dir };
  for (const key of Object.values(SESSION_ENV)) {
    delete env[key];
  }
  env.CODEX_THREAD_ID = "receiver";
  const run = async (...args) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "updates", ...args],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, error, code };
  };
  const status = await run("--session", "--json");
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out)).toMatchObject({ session_id: "receiver", status: "pending" });
  const ack = await run("--session", "--ack", "guidance", "--revision", "A");
  expect(ack.code).toBe(0);
  expect(JSON.parse(ack.out).targets[0]).toMatchObject({
    component: "guidance",
    status: "attested",
  });
  const invalid = await run("--session", "--ack", "guidance");
  expect(invalid.code).toBe(1);
  expect(invalid.error).toContain("--ack and --revision");
});

test("invalid approval is visible to status, quiet in hooks and leaves no evidence", () => {
  const f = fixture();
  for (const text of ["{", '{"version":2,"targets":{}}', '{"version":1,"targets":{"x":{}}}']) {
    writeFileSync(f.manifest, text);
    expect(() => f.check()).toThrow();
    expect(updateHint("receiver", false, f.env)).toBe("");
    expect(existsSync(f.stateFile)).toBe(false);
  }
  expect(() => sessionUpdates("../other", { env: f.env })).toThrow("identifier");
});

test("concurrent native processes claim one pending hint and preserve registration state", async () => {
  const f = fixture();
  mkdirSync(join(f.dir, "swarmail-register"));
  const registration = join(f.dir, "swarmail-register", "receiver.json");
  writeFileSync(registration, '{"name":"BlueLake","projects":["project"]}');
  const before = readFileSync(registration, "utf8");
  const source = new URL("../src/updates.ts", import.meta.url).href;
  const run = () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {updateHint} from ${JSON.stringify(source)}; console.log(JSON.stringify({hint:updateHint("receiver")}));`,
      ],
      {
        env: { ...process.env, ...f.env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return Promise.all([new Response(child.stdout).json(), child.exited]);
  };
  const results = await Promise.all([run(), run(), run(), run()]);
  expect(results.every(([, code]) => code === 0)).toBe(true);
  expect(results.filter(([result]) => result.hint).length).toBe(1);
  expect(f.check().targets[0].loaded).toBeNull();
  expect(readFileSync(registration, "utf8")).toBe(before);
});

test("update event orderings never attest a newer target or repeat a pending hint", () => {
  const f = fixture();
  const events = [
    "publish-A",
    "publish-B",
    "hint",
    "ack-A",
    "ack-B",
    "hold",
    "reset",
    "omit",
    "contended-reset",
  ];
  const failures = [];
  const walk = (sequence) => {
    if (sequence.length === 3) {
      return;
    }
    for (const event of events) {
      const manifest = readFileSync(f.manifest, "utf8");
      const saved = existsSync(f.stateFile) ? readFileSync(f.stateFile, "utf8") : null;
      const resetFile = join(f.dir, "swarmail-updates", "receiver.reset");
      const reset = existsSync(resetFile) ? readFileSync(resetFile, "utf8") : null;
      const before = f.check();
      const wasPending = saved && JSON.parse(saved).hintPending;
      const path = [...sequence, event];
      let result;
      try {
        if (event.startsWith("publish-")) {
          f.publish(event.slice(-1));
        } else if (event.startsWith("ack-")) {
          result = f.check({ ack: { component: "guidance", revision: event.slice(-1) } });
        } else if (event === "hold") {
          f.publish(before.targets[0]?.revision ?? "A", true);
        } else if (event === "omit") {
          writeFileSync(f.manifest, JSON.stringify({ version: 1, targets: {} }));
        } else if (event === "contended-reset") {
          const lock = join(f.dir, "swarmail-updates", "receiver.lock");
          writeFileSync(lock, "");
          updateHint("receiver", true, f.env);
          rmSync(lock);
        } else {
          result = f.check({ notify: event === "hint", resetContext: event === "reset" });
        }
      } catch (error) {
        if (!event.startsWith("ack-") || !/target changed|held/.test(error.message)) {
          failures.push({ path, error: error.message });
        }
      }
      const after = f.check();
      if (
        after.targets[0]?.status === "attested" &&
        after.targets[0].loaded.revision !== after.targets[0].revision
      ) {
        failures.push({ path, invariant: "attestation must match approved target" });
      }
      if (result?.hint && (before.status === "held" || (event === "hint" && wasPending))) {
        failures.push({ path, invariant: "no held or repeated pending hint" });
      }
      if (
        (event === "reset" || event === "contended-reset") &&
        before.status !== "held" &&
        after.targets.some((target) => target.context && target.loaded !== null)
      ) {
        failures.push({ path, invariant: "context reset cannot retain contextual attestation" });
      }
      walk(path);
      writeFileSync(f.manifest, manifest);
      if (reset === null) {
        rmSync(resetFile, { force: true });
      } else {
        writeFileSync(resetFile, reset);
      }
      if (saved === null) {
        rmSync(f.stateFile, { force: true });
      } else {
        writeFileSync(f.stateFile, saved);
      }
    }
  };
  walk([]);
  expect(failures).toEqual([]);
});

test("running server exposes the exact negotiated tool catalog fingerprint without writes", async () => {
  const f = fixture();
  const { server, db } = createServer(join(f.dir, "mail.sqlite"), 0);
  cleanups.push(() => {
    server.stop(true);
    db.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const hashes = [];
  for (const protocol of ["2025-03-26", "2025-11-25"]) {
    const versions = await (await fetch(`${base}/versions?protocolVersion=${protocol}`)).json();
    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "MCP-Protocol-Version": protocol },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (await response.json()).result.tools;
    const independent = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
    expect(versions).toEqual({
      server_build: null,
      protocol_version: protocol,
      tools_revision: independent,
    });
    hashes.push(independent);
  }
  expect(hashes[0]).not.toBe(hashes[1]);
  expect((await fetch(base + "/versions?protocolVersion=invalid")).status).toBe(400);
  expect((await fetch(base + "/versions", { method: "POST" })).status).toBe(405);
  expect(
    (await fetch(base + "/versions", { headers: { origin: "https://example.invalid" } })).status,
  ).toBe(403);
  expect(db.query("SELECT count(*) AS n FROM messages").get().n).toBe(0);
});
