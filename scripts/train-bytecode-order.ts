#!/usr/bin/env bun
// Records scripts/swarmail.order, the profile scripts/build.ts passes as --bytecode-order. It builds the server from
// scripts/train-entry.ts without a profile, runs a short workload against it on a scratch database and port, stops it
// normally so the runtime writes the profile, and copies the profile into the repository.
// Bun matches functions by a hash of their syntax, so a profile from older sources still applies: record it again
// when the workload the server runs changes, not after every edit. Needs Bun 1.4.3 or later and a platform with SIGTERM.
// Usage: bun scripts/train-bytecode-order.ts
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSwarmail, orderProfile } from "./build.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const PROJECT = "/train/project";
const AGENTS = ["AmberFox", "JadeOwl"];
const ROUNDS = 20;

/** Records the profile into `target` from a server built at `root`. */
export async function train(root = REPO_ROOT, target = orderProfile(root)): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "swarmail-order-"));
  try {
    const bin = join(dir, process.platform === "win32" ? "swarmail.exe" : "swarmail");
    buildSwarmail(root, bin, { entry: join(root, "scripts", "train-entry.ts"), order: null });
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const profile = join(dir, "server.order");
    const server = Bun.spawn([bin, "serve"], {
      env: {
        ...process.env,
        // Everything the server writes goes to the scratch directory.
        HOME: dir,
        USERPROFILE: dir,
        SWARMAIL_DB: join(dir, "mail.sqlite3"),
        SWARMAIL_PORT: String(port),
        SWARMAIL_RETIRE_DAYS: "0",
        BUN_BYTECODE_ORDER_OUT: profile,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      await waitHealthy(port, server);
      await workload(port);
    } finally {
      server.kill("SIGTERM");
      await server.exited;
    }
    if (!existsSync(profile)) {
      throw new Error(
        `The server wrote no profile (Bun 1.4.3 or later writes one):\n${await new Response(server.stderr).text()}`,
      );
    }
    copyFileSync(profile, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitHealthy(port: number, server: Bun.Subprocess) {
  const deadline = Date.now() + 15_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/healthz`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (server.exitCode !== null || Date.now() > deadline) {
      throw new Error("The training server did not start");
    }
    await Bun.sleep(10);
  }
}

let nextId = 0;
async function call(port: number, name: string, args: object): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as { error?: unknown; result?: { isError?: boolean } };
  if (!response.ok || body.error || body.result?.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

/** The calls agents make most: register, send, read the inbox, list the roster and search. */
async function workload(port: number) {
  await call(port, "ensure_project", { human_key: PROJECT });
  for (const name of AGENTS) {
    await call(port, "register_agent", {
      project_key: PROJECT,
      program: "train",
      model: "m",
      name,
    });
  }
  for (let i = 0; i < ROUNDS; i++) {
    await call(port, "send_message", {
      project_key: PROJECT,
      sender_name: AGENTS[0],
      to: [AGENTS[1]],
      subject: `coordination ${i}`,
      body_md: `message ${i} about the weekly plan`,
    });
    await call(port, "fetch_inbox", {
      project_key: PROJECT,
      agent_name: AGENTS[1],
      mark_read: false,
    });
    await call(port, "list_agents", { project_key: PROJECT });
    await call(port, "search_messages", { project_key: PROJECT, query: "coordination" });
  }
}

if (import.meta.main) {
  await train();
  console.log(`wrote ${orderProfile()}`);
}
