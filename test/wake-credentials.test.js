import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testScratch } from "./fixtures/test-scratch.js";

// Rotation and listener identity require Linux process and private-file semantics.
describe.skipIf(process.platform !== "linux")("credential ownership and rotation", () => {
  const roots = [];
  const servers = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop(true);
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const scratch = testScratch("swarmail-credentials-tests", "credential rotation contract tests");

  function fixture(version = "0.0.43-nightly.20260928.2402") {
    const root = mkdtempSync(join(scratch, "case-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const dbPath = join(root, "sessions.json");
    writeFileSync(dbPath, "[]");
    const modePath = join(root, "mode");
    writeFileSync(modePath, "");
    const executable = join(root, "t3");
    writeFileSync(
      executable,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const root=import.meta.dir, args=process.argv.slice(2), path=root+'/sessions.json';
if(args[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}
const sessions=JSON.parse(readFileSync(path,'utf8')), mode=readFileSync(root+'/mode','utf8');
if(args[2]==='issue'){
 if(mode==='delayed-issue'){
  writeFileSync(root+'/issuer-pid',String(process.pid));
  const until=Date.now()+10000;
  while(!require('node:fs').existsSync(root+'/release-issuer') && Date.now()<until)await Bun.sleep(20);
  sessions.splice(0,sessions.length,...JSON.parse(readFileSync(path,'utf8')));
 }
 const sessionId=crypto.randomUUID(), subject=args[args.indexOf('--subject')+1];
 const token='fixture-secret-'+sessionId, expiresAt=new Date(Date.now()+Number(args[args.indexOf('--ttl')+1].slice(0,-1))*1000).toISOString();
 const row={sessionId,subject,token,expiresAt};sessions.push(row);writeFileSync(path,JSON.stringify(sessions));
 if(mode==='lost-issue')process.exit(1);
 console.log(JSON.stringify(row));
}else if(args[2]==='list'){console.log(JSON.stringify(sessions.filter(x=>!x.revoked)))}
else if(args[2]==='revoke'){
 if(mode==='fail-revoke')process.exit(1);
 const row=sessions.find(x=>x.sessionId===args[3]);if(row)row.revoked=true;
 writeFileSync(path,JSON.stringify(sessions));
}else process.exit(2);
`,
      { mode: 0o700 },
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/api/auth/session") {
          return new Response("wrong endpoint", { status: 404 });
        }
        const mode = readFileSync(modePath, "utf8");
        if (mode === "unavailable") {
          return new Response("down", { status: 503 });
        }
        if (mode === "delayed-expiry") {
          await Bun.sleep(1200);
        }
        const row = JSON.parse(readFileSync(dbPath, "utf8")).find(
          (x) => "Bearer " + x.token === request.headers.get("authorization"),
        );
        if (!row || row.revoked || Date.parse(row.expiresAt) <= Date.now() || mode === "reject") {
          return Response.json({ authenticated: false });
        }
        return Response.json({
          authenticated: true,
          sessionMethod: "bearer-access-token",
          expiresAt: row.expiresAt,
          scopes: ["orchestration:operate"],
        });
      },
    });
    servers.push(server);
    const config = {
      target: {
        type: "t3-v1-steer",
        id: "test-thread",
        url: `http://127.0.0.1:${server.port}`,
        authorizationFile: join(root, "authorization"),
      },
      rotation: {
        executable,
        baseDir: root,
        version,
        ttlSeconds: 4,
        renewBeforeSeconds: 3,
      },
    };
    const configPath = join(root, "config.json");
    const configure = () => writeFileSync(configPath, JSON.stringify(config));
    configure();
    const run = async (...args) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "./fixtures/wake-credentials.ts"),
          configPath,
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(out + err).not.toContain("fixture-secret");
      return { out, err, code };
    };
    const rows = () => JSON.parse(readFileSync(dbPath, "utf8"));
    const mode = (value) => writeFileSync(modePath, value);
    const statePath = join(config.target.authorizationFile + ".rotation", "state.json");
    return { root, run, rows, mode, config, configure, statePath, dbPath };
  }

  test.each(["0.0.43-nightly.20260928.2402", "0.0.45-nightly.20261002.2561"])(
    "%s rotation publishes a verified token, reloads without restart, and revokes the old token",
    async (version) => {
      const f = fixture(version);
      expect((await f.run()).code).toBe(0);
      const first = readFileSync(f.config.target.authorizationFile, "utf8");
      expect((await f.run()).out).toContain('"current"');
      expect(f.rows()).toHaveLength(1);
      await Bun.sleep(1200);
      expect((await f.run()).code).toBe(0);
      expect(readFileSync(f.config.target.authorizationFile, "utf8")).not.toBe(first);
      expect(f.rows()[0].revoked).toBe(true);
      expect(f.rows()[1].revoked).toBeUndefined();
    },
  );

  test.skipIf(process.platform !== "linux")(
    "backend mismatch refuses issuance and preserves an existing credential",
    async () => {
      const f = fixture();
      f.config.rotation.verifyBackend = true;
      f.configure();
      expect((await f.run()).err).toContain("backend identity");
      expect(f.rows()).toHaveLength(0);
      expect(existsSync(f.config.target.authorizationFile)).toBe(false);
      f.config.rotation.verifyBackend = false;
      f.configure();
      expect((await f.run()).code).toBe(0);
      const header = readFileSync(f.config.target.authorizationFile, "utf8");
      const state = readFileSync(f.statePath, "utf8");
      f.config.rotation.verifyBackend = true;
      f.configure();
      expect((await f.run("--revoke")).err).toContain("backend identity");
      expect(readFileSync(f.config.target.authorizationFile, "utf8")).toBe(header);
      expect(readFileSync(f.statePath, "utf8")).toBe(state);
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0].revoked).toBeUndefined();
      // Without a runtime file or target.url, T3 is down rather than changed.
      const url = f.config.target.url;
      delete f.config.target.url;
      f.configure();
      const down = await f.run();
      expect(down.code).toBe(75);
      expect(down.err).toContain("unavailable; retrying");
      // A verified backend supplies its own binary, so an upgrade that prunes the configured one is
      // still only a T3 outage.
      f.config.rotation.executable = join(f.root, "removed-runtime");
      f.configure();
      expect((await f.run()).code).toBe(75);
      // Without verification the configured binary is the CLI, and its absence needs the operator.
      f.config.rotation.verifyBackend = false;
      f.config.target.url = url;
      f.configure();
      expect((await f.run()).err).toContain("reconcile the upgrade");
      expect(f.rows()).toHaveLength(1);
    },
  );

  test("unexpected revocation stops replacement; explicit revoke stays disabled after expiry", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    f.mode("reject");
    expect((await f.run()).err).toContain("unexpired credential rejected");
    expect(f.rows()).toHaveLength(1);
    f.mode("");
    expect((await f.run("--revoke")).code).toBe(0);
    await Bun.sleep(4100);
    expect((await f.run()).err).toContain("rotation disabled");
    expect(f.rows()).toHaveLength(1);
  }, 10000);

  test("lost issuance response is recovered by exact attempt subject, preserving unrelated sessions", async () => {
    const f = fixture();
    writeFileSync(
      f.dbPath,
      JSON.stringify([
        {
          sessionId: "unrelated",
          subject: "another-integration",
          token: "other",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      ]),
    );
    f.mode("lost-issue");
    expect((await f.run()).code).toBe(1);
    expect(f.rows()).toHaveLength(2);
    f.mode("");
    expect((await f.run()).code).toBe(0);
    expect(f.rows()[0].revoked).toBeUndefined();
    expect(f.rows()[1].revoked).toBe(true);
    expect(f.rows()).toHaveLength(3);
  });

  test("publication recovery keeps the published credential and retries failed old-token cleanup", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    await Bun.sleep(1200);
    f.mode("fail-revoke");
    expect((await f.run()).code).toBe(1);
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    // Durable boundary after header rename but before metadata promotion.
    const published = state.current;
    state.pending = { subject: f.rows()[1].subject, credential: published };
    state.current = state.retired.pop();
    writeFileSync(f.statePath, JSON.stringify(state));
    f.mode("");
    expect((await f.run()).code).toBe(0);
    expect(f.rows()).toHaveLength(2);
    expect(f.rows()[0].revoked).toBe(true);
    expect(f.rows()[1].revoked).toBeUndefined();
    expect(
      createHash("sha256").update(readFileSync(f.config.target.authorizationFile)).digest("hex"),
    ).toBe(published.digest);
  });

  test("outage preserves the active header; expired credentials recover when T3 returns", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    const first = readFileSync(f.config.target.authorizationFile, "utf8");
    f.mode("unavailable");
    expect((await f.run()).code).toBe(1);
    expect(readFileSync(f.config.target.authorizationFile, "utf8")).toBe(first);
    await Bun.sleep(4100);
    f.mode("");
    expect((await f.run()).code).toBe(0);
    expect(f.rows()).toHaveLength(2);
  }, 10000);

  test("concurrent rotation, changed binding and unsafe credentials are refused", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    const lock = new Database(join(f.config.target.authorizationFile + ".rotation", "lock.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    try {
      expect((await f.run()).err).toContain("another credential rotator");
    } finally {
      lock.close();
    }
    f.config.target.id = "different-thread";
    f.configure();
    expect((await f.run()).err).toContain("binding differs");
    f.config.target.id = "test-thread";
    f.configure();
    chmodSync(f.config.target.authorizationFile, 0o644);
    expect((await f.run()).err).toContain("private, user-owned");
    expect(f.rows()).toHaveLength(1);
  });

  test("expiry during an in-flight auth check rotates instead of disabling renewal", async () => {
    const f = fixture();
    f.config.rotation.ttlSeconds = 2;
    f.config.rotation.renewBeforeSeconds = 1;
    f.configure();
    expect((await f.run()).code).toBe(0);
    await Bun.sleep(1000);
    f.mode("delayed-expiry");
    expect((await f.run()).code).toBe(0);
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).disabled).not.toBe(true);
    expect(f.rows()).toHaveLength(2);
  }, 10000);

  test("an issuer surviving its killed parent remains tracked until later cleanup", async () => {
    const f = fixture();
    f.config.rotation.ttlSeconds = 60;
    f.config.rotation.renewBeforeSeconds = 30;
    f.configure();
    f.mode("delayed-issue");
    const parent = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "./fixtures/wake-credentials.ts"),
        join(f.root, "config.json"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    let child;
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(f.root, "issuer-pid")) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      child = Number(readFileSync(join(f.root, "issuer-pid"), "utf8"));
      parent.kill(9);
      await parent.exited;
      f.mode("");
      expect((await f.run()).code).toBe(0);
      writeFileSync(join(f.root, "release-issuer"), "go");
      const done = Date.now() + 3000;
      while (f.rows().length < 2 && Date.now() < done) {
        await Bun.sleep(20);
      }
      expect(f.rows()).toHaveLength(2);
      expect((await f.run()).code).toBe(0);
      expect(f.rows()[0].revoked).toBeUndefined();
      expect(f.rows()[1].revoked).toBe(true);
      expect(JSON.parse(readFileSync(f.statePath, "utf8")).abandoned).toHaveLength(0);
    } finally {
      if (parent.exitCode === null) {
        parent.kill(9);
        await parent.exited;
      }
      if (child) {
        try {
          process.kill(child, 9);
        } catch {}
      }
    }
  }, 12000);

  for (const boundary of ["unresolved issuance", "published candidate"]) {
    test(`credential ownership survives bounded event orderings after ${boundary}`, async () => {
      const f = fixture();
      // Lifetime is deliberately longer than the test; expiry has its own contract tests.
      f.config.rotation.ttlSeconds = 3600;
      f.config.rotation.renewBeforeSeconds = 1800;
      f.configure();
      expect((await f.run()).code).toBe(0);
      const original = f.rows()[0];
      const candidate = {
        ...original,
        sessionId: "candidate",
        subject: "swarmail-rotation-interrupted-attempt",
        token: "fixture-secretA",
      };
      const unrelated = {
        ...original,
        sessionId: "unrelated",
        subject: "another-integration",
        token: "fixture-secretB",
      };
      const state = JSON.parse(readFileSync(f.statePath, "utf8"));
      state.pending = { subject: candidate.subject };
      const headerPath = f.config.target.authorizationFile;
      if (boundary === "published candidate") {
        const header = `Bearer ${candidate.token}`;
        state.pending.credential = {
          sessionId: candidate.sessionId,
          expiresAt: candidate.expiresAt,
          digest: createHash("sha256").update(header).digest("hex"),
        };
        writeFileSync(headerPath, header);
      }
      // Seed durable crash boundaries, as in the named publication regression above.
      // The existing killed-parent test covers a real issuer surviving its parent.
      writeFileSync(f.statePath, JSON.stringify(state));
      writeFileSync(
        f.dbPath,
        JSON.stringify([
          original,
          unrelated,
          ...(boundary === "published candidate" ? [candidate] : []),
        ]),
      );
      const paths = [f.statePath, headerPath, f.dbPath];
      const snapshot = () => paths.map((path) => readFileSync(path));
      const restore = (saved) => paths.forEach((path, index) => writeFileSync(path, saved[index]));
      const failures = [];
      let checked = 0;
      const events = ["recover", "cleanup fails", "revoke", "issuer finishes"];
      const check = (sequence, before, result) => {
        const label = sequence.join(" -> ");
        const after = JSON.parse(readFileSync(f.statePath, "utf8"));
        const rows = f.rows();
        const live = rows.filter((row) => !row.revoked);
        const ownedIds = new Set(
          [after.current, after.pending?.credential, ...after.retired]
            .filter(Boolean)
            .map((credential) => credential.sessionId),
        );
        const ownedSubjects = new Set([after.pending?.subject, ...(after.abandoned ?? [])]);
        const assert = (condition, invariant) => {
          if (!condition) {
            failures.push(`${label}: ${invariant}`);
          }
        };
        if (sequence.at(-1) === "recover") {
          assert(
            result.code === (before.disabled ? 1 : 0),
            "recovery succeeds unless explicitly disabled",
          );
        }
        if (sequence.at(-1) === "revoke") {
          const unresolved =
            boundary === "unresolved issuance" && !sequence.includes("issuer finishes");
          assert(
            result.code === (unresolved ? 1 : 0),
            "revoke reports unresolved issuance and otherwise succeeds",
          );
        }
        for (const row of live.filter((row) => row.subject !== unrelated.subject)) {
          assert(
            ownedIds.has(row.sessionId) || ownedSubjects.has(row.subject),
            `live credential ${row.sessionId} remains durably owned`,
          );
        }
        if (!after.disabled) {
          const published = readFileSync(headerPath, "utf8").trim();
          assert(
            live.some((row) => `Bearer ${row.token}` === published),
            "published credential remains live while enabled",
          );
        }
        assert(
          JSON.stringify(rows.find((row) => row.sessionId === unrelated.sessionId)) ===
            JSON.stringify(unrelated),
          "unrelated credential remains unchanged",
        );
        if (before.disabled) {
          assert(after.disabled === true, "explicit disable survives recovery");
          assert(
            rows.every((row) =>
              [original.sessionId, unrelated.sessionId, candidate.sessionId].includes(
                row.sessionId,
              ),
            ),
            "disabled rotation never issues another credential",
          );
        }
        if (sequence.at(-1) === "revoke" && result.code === 0) {
          assert(after.disabled === true, "successful revoke persists disabled state");
          assert(
            !live.some((row) => row.sessionId === after.current?.sessionId),
            "successful revoke revokes current credential",
          );
        }
        if (
          result?.code === 0 &&
          boundary === "unresolved issuance" &&
          sequence.includes("issuer finishes")
        ) {
          assert(
            !live.some((row) => row.sessionId === candidate.sessionId),
            "successful recovery cleans up the late issuer",
          );
        }
      };
      // Enumerate every prefix through four events. The issuer can finish only once;
      // rotator invocations are serialized by the production lock, not interleaved internally.
      const walk = async (sequence = []) => {
        if (sequence.length === 4) {
          return;
        }
        const saved = snapshot();
        for (const event of events) {
          if (
            event === "issuer finishes" &&
            (boundary === "published candidate" || sequence.includes(event))
          ) {
            continue;
          }
          restore(saved);
          const before = JSON.parse(readFileSync(f.statePath, "utf8"));
          const next = [...sequence, event];
          let result;
          if (event === "issuer finishes") {
            // External issuer commit; the controller sees it through the real CLI list boundary.
            writeFileSync(f.dbPath, JSON.stringify([...f.rows(), candidate]));
          } else {
            f.mode(event === "cleanup fails" ? "fail-revoke" : "");
            result = await f.run(...(event === "revoke" ? ["--revoke"] : []));
          }
          checked++;
          const count = failures.length;
          check(next, before, result);
          if (failures.length === count) {
            await walk(next);
          }
        }
        restore(saved);
      };
      await walk();
      console.log(`${boundary}: checked ${checked} legal event prefixes through depth 4`);
      expect(failures).toEqual([]);
    }, 90000);
  }

  test("a T3 upgrade keeps the owned credential: any version, a new binary and old saved state", async () => {
    const f = fixture("0.0.99-nightly.20991231.9999");
    expect((await f.run()).code).toBe(0);
    const header = readFileSync(f.config.target.authorizationFile, "utf8");
    // State written before bindings dropped the binary, version and credential path.
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    state.binding = JSON.stringify({
      url: f.config.target.url,
      executable: realpathSync(f.config.rotation.executable),
      baseDir: realpathSync(f.root),
      version: f.config.rotation.version,
      type: f.config.target.type,
      id: f.config.target.id,
      headerPath: f.config.target.authorizationFile,
    });
    writeFileSync(f.statePath, JSON.stringify(state));
    const upgraded = join(f.root, "t3-upgraded");
    copyFileSync(f.config.rotation.executable, upgraded);
    chmodSync(upgraded, 0o700);
    f.config.rotation.executable = upgraded;
    delete f.config.rotation.version;
    f.configure();
    const run = await f.run();
    expect(run.err).toBe("");
    expect(run.out).toContain('"current"');
    expect(readFileSync(f.config.target.authorizationFile, "utf8")).toBe(header);
    expect(f.rows()).toHaveLength(1);
  });

  test.skipIf(process.platform !== "linux")(
    "the minute check verifies the listener before sending the token and never runs the T3 CLI",
    async () => {
      const { credentialService } = await import("../src/wake-credentials.ts");
      const { T3Unavailable } = await import("../src/wake-backend.ts");
      const root = mkdtempSync(join(scratch, "case-"));
      roots.push(root);
      chmodSync(root, 0o700);
      const baseDir = join(root, ".t3");
      mkdirSync(join(baseDir, "userdata"), { recursive: true });
      // verifyT3Backend requires the listener to hold T3's database open; this process is the listener.
      const database = new Database(join(baseDir, "userdata/state.sqlite"));
      const requests = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname);
          return Response.json({
            authenticated: true,
            sessionMethod: "bearer-access-token",
            expiresAt,
            scopes: ["orchestration:operate"],
          });
        },
      });
      servers.push(server);
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      const config = {
        target: { type: "t3-v1-steer", id: "minute", authorizationFile: join(root, "auth/header") },
        rotation: {
          executable: process.execPath,
          baseDir,
          version: "0.0.45-nightly.20261002.2561",
          verifyBackend: true,
        },
      };
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify(config));
      const rotation = config.target.authorizationFile + ".rotation";
      mkdirSync(rotation, { recursive: true, mode: 0o700 });
      chmodSync(join(root, "auth"), 0o700);
      const header = "Bearer fixture-secret-minute";
      writeFileSync(config.target.authorizationFile, header, { mode: 0o600 });
      const saveState = (current) =>
        writeFileSync(
          join(rotation, "state.json"),
          JSON.stringify({
            binding: JSON.stringify({
              executable: realpathSync(process.execPath),
              baseDir: realpathSync(baseDir),
              version: config.rotation.version,
              type: config.target.type,
              id: config.target.id,
              headerPath: config.target.authorizationFile,
            }),
            current,
            retired: [],
          }),
          { mode: 0o600 },
        );
      const digest = createHash("sha256").update(header).digest("hex");
      saveState({ sessionId: "minute", expiresAt, digest });
      const publish = (pid) =>
        writeFileSync(
          join(baseDir, "userdata/server-runtime.json"),
          JSON.stringify({ version: 1, pid, port: server.port }),
        );
      const spawn = Bun.spawn;
      const cli = [];
      Bun.spawn = (command, options) => {
        if (Array.isArray(command) && command[0] === realpathSync(process.execPath)) {
          cli.push(command);
        }
        return spawn(command, options);
      };
      const service = credentialService(configPath);
      const checkCredential = async () => service.current(await service.backend());
      try {
        publish(process.pid);
        expect(await checkCredential()).toEqual({
          status: "current",
          expiresAt,
          url: `http://127.0.0.1:${server.port}`,
        });
        expect(requests).toEqual(["/api/auth/session"]);
        // A listener other than the published one gets no request carrying the token.
        publish(process.pid + 1_000_000);
        await expect(checkCredential()).rejects.toBeInstanceOf(T3Unavailable);
        expect(requests).toHaveLength(1);
        // Renewal due: the full path takes over without a request from the minute check.
        publish(process.pid);
        saveState({
          sessionId: "minute",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          digest,
        });
        expect(await checkCredential()).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(cli).toEqual([]);
      } finally {
        Bun.spawn = spawn;
        database.close();
      }
    },
  );
});
