import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { mail } from "../src/mail.ts";
import { AGENT_GUIDANCE, SENDING_GUIDANCE } from "../src/guidance.ts";

const P = "/w/t3-links";
let dir: string;
let server: ReturnType<typeof createServer>["server"];
let db: ReturnType<typeof createServer>["db"];
let url: string;

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "swarmail-t3-links-")));
  ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
  url = `http://127.0.0.1:${server.port}/mcp/`;
});
afterAll(async () => {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 0;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const r = ((await res.json()) as any).result;
  const value = JSON.parse(r.content[0].text);
  if (r.isError) {
    throw Object.assign(new Error(value.error.message), value.error);
  }
  return value;
}
const register = (name: string, task_description: string) =>
  call("register_agent", {
    project_key: P,
    program: "claude-code",
    model: "m",
    name,
    task_description,
  });

async function pair() {
  await register("AmberFox", "[t3:mcp:sender-thread claude:s1 cwd:~/w] sends");
  await register("IndigoHill", "[claude:s2 cwd:~/w] reads outside T3");
  await register("GreenLake", "[t3:mcp:reader-thread claude:s3 cwd:~/w] reads in T3");
}

test("whois and registration return the T3 thread a link needs, or null outside T3", async () => {
  await pair();
  const t3 = await call("whois", { project_key: P, agent_name: "AmberFox" });
  expect(t3.t3_thread).toBe("mcp:sender-thread");
  const plain = await call("whois", { project_key: P, agent_name: "IndigoHill" });
  expect(plain.t3_thread).toBeNull();
  const again = await register("AmberFox", "[t3:mcp:sender-thread claude:s1 cwd:~/w] renamed task");
  expect(again.t3_thread).toBe("mcp:sender-thread");
});

test("an inbox entry names the sender's T3 thread, or null for a sender outside T3", async () => {
  await pair();
  for (const sender of ["AmberFox", "IndigoHill"]) {
    await call("send_message", {
      project_key: P,
      sender_name: sender,
      to: ["GreenLake"],
      subject: `from ${sender}`,
      body_md: "hello",
    });
  }
  const inbox = await call("fetch_inbox", {
    project_key: P,
    agent_name: "GreenLake",
    mark_read: false,
  });
  const by = Object.fromEntries(inbox.map((m: any) => [m.from, m.sender_t3_thread]));
  expect(by).toEqual({ AmberFox: "mcp:sender-thread", IndigoHill: null });
});

test("the guidance tells a T3 session to link threads and keep names as the fallback", () => {
  for (const text of [SENDING_GUIDANCE, AGENT_GUIDANCE]) {
    expect(text).toContain("[title](t3-thread://v1/<t3_thread>)");
    expect(text).toContain("use the name only if the user asks");
  }
});

test("the inbox command shows the sender's thread link target beside a registered name, only under T3", async () => {
  const message = (id: number, from: string, sender_t3_thread: string | null) => ({
    id,
    from,
    subject: `s${id}`,
    created_ts: "2026-01-01",
    importance: "normal",
    ack_required: false,
    thread_id: null,
    sender_location: { title: "Work", repo: "r", worktree: "w", branch: null },
    sender_t3_thread,
  });
  const fixture = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                message(2, "IndigoHill", null),
                message(1, "AmberFox", "mcp:sender-thread"),
              ]),
            },
          ],
        },
      }),
  });
  const repo = join(dir, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const env = { SWARMAIL_URL: `http://127.0.0.1:${fixture.port}`, SWARMAIL_AGENT: "GreenLake" };
    expect(await mail(["inbox", "--peek"], async () => "", env, repo)).toBe(0);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("from AmberFox (Work) [t3-thread://v1/mcp:sender-thread]: s1");
    expect(text).toContain("from IndigoHill (Work): s2");
  } finally {
    log.mockRestore();
    await fixture.stop(true);
  }
});
