import { afterAll, beforeAll, expect, test } from "bun:test";
import Ajv from "ajv";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { TOOLS } from "../src/tools.ts";

let dir,
  server,
  db,
  url,
  id = 0;
const project_key = "/project/structured";
const sender_name = "StructuredSender";
const validator = new Ajv();
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "swarmail-structured-"));
  ({ server, db } = createServer(join(dir, "mail.sqlite3"), 0));
  url = `http://127.0.0.1:${server.port}/mcp/`;
  for (const name of [sender_name, "StructuredReceiver"]) {
    await call("register_agent", { project_key, name, program: "test", model: "test" });
  }
});
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function rpc(method, params, version) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(version !== undefined && { "MCP-Protocol-Version": version }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) {
    return { status: res.status };
  }
  return (await res.json()).result;
}
const call = (name, args, version) => rpc("tools/call", { name, arguments: args }, version);
const value = (result) => JSON.parse(result.content[0].text);
const send = (extra = {}) => ({
  project_key,
  sender_name,
  to: ["StructuredReceiver"],
  subject: "Request",
  body_md: "Details",
  ...extra,
});
const count = () => db.query("SELECT count(*) AS n FROM messages").get().n;

// Removing the header gate or publishing schemas on legacy responses breaks this contract.
for (const version of [undefined, "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
  test(`success format and declared schemas follow protocol ${version ?? "absent"}`, async () => {
    const modern = version === "2025-06-18" || version === "2025-11-25";
    const definitions = (await rpc("tools/list", {}, version)).tools;
    expect(definitions.filter((t) => t.outputSchema).map((t) => t.name)).toEqual(
      modern ? ["send_message", "reply_message", "get_message_delivery_receipt"] : [],
    );
    const sent = await call(
      "send_message",
      send({ cc: [sender_name], bcc: ["StructuredReceiver"] }),
      version,
    );
    const reply = await call(
      "reply_message",
      {
        project_key,
        sender_name: "StructuredReceiver",
        message_id: value(sent).id,
        body_md: "Answer",
      },
      version,
    );
    const receipt = await call(
      "get_message_delivery_receipt",
      { project_key, message_id: value(sent).id },
      version,
    );
    for (const [name, result] of [
      ["send_message", sent],
      ["reply_message", reply],
      ["get_message_delivery_receipt", receipt],
    ]) {
      expect(result.isError).toBeUndefined();
      if (modern) {
        expect(result.structuredContent).toEqual(value(result));
        const validate = validator.compile(definitions.find((t) => t.name === name).outputSchema);
        expect(validate(result.structuredContent)).toBe(true);
        expect(validate({ ...result.structuredContent, unexpected: "leak" })).toBe(false);
      } else {
        expect(result.structuredContent).toBeUndefined();
      }
    }
    expect(value(sent).bcc).toEqual(["StructuredReceiver"]);
    expect(value(sent).sender_location).toBeNull();
    expect(value(receipt).recipients[0].read_at).toBeNull();
    expect(value(receipt).recipients[0].admission.historical).toBe(true);
    const inbox = await call(
      "fetch_inbox",
      { project_key, agent_name: "StructuredReceiver", mark_read: false },
      version,
    );
    expect(inbox.structuredContent).toBeUndefined();
    expect(Array.isArray(value(inbox))).toBe(true);
    const error = await call("send_message", send({ to: ["NotRegistered"] }), version);
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toBeUndefined();
    expect(value(error).error.recoverable).toBe(true);
  });
}

test("unsupported explicit protocols reject before storing mail or processing notifications", async () => {
  const before = count();
  for (const version of ["1999-01-01", "", "2025-06-18,2025-11-25"]) {
    expect(await call("send_message", send(), version)).toEqual({ status: 400 });
    const res = await fetch(url, {
      method: "POST",
      headers: { "MCP-Protocol-Version": version },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(400);
  }
  expect(count()).toBe(before);
});

test("reply acknowledgement defaults, explicit overrides and original receipts", async () => {
  for (const parentAck of [false, true]) {
    const parent = value(
      await call(
        "send_message",
        send({ ack_required: parentAck, importance: "urgent", topic: "operations" }),
      ),
    );
    for (const replyAck of [undefined, true, false]) {
      const result = value(
        await call("reply_message", {
          project_key,
          sender_name: "StructuredReceiver",
          message_id: parent.id,
          body_md: "Answer",
          ...(replyAck !== undefined && { ack_required: replyAck }),
        }),
      );
      expect(result).toMatchObject({
        ack_required: replyAck ?? false,
        importance: "urgent",
        topic: "operations",
        thread_id: String(parent.id),
        reply_to: parent.id,
      });
    }
    const receipt = value(
      await call("get_message_delivery_receipt", { project_key, message_id: parent.id }),
    );
    expect(receipt.recipients[0]).toMatchObject({
      read_at: null,
      acknowledged: false,
      acknowledged_at: null,
    });
  }
});

test("a pre-upgrade reply replay preserves omitted fields and its saved acknowledgement flag", async () => {
  const parent = value(await call("send_message", send({ ack_required: true })));
  const args = {
    project_key,
    sender_name: "StructuredReceiver",
    message_id: parent.id,
    body_md: "Saved answer",
    idempotency_key: "old-reply",
  };
  const first = value(await call("reply_message", args));
  const historical = { ...first, ack_required: true };
  delete historical.delivery;
  delete historical.revision;
  db.run("UPDATE idempotency_keys SET result = ? WHERE key = ?", [
    JSON.stringify(historical),
    "old-reply",
  ]);
  const before = count();
  const replay = await call("reply_message", args, "2025-06-18");
  expect(replay.structuredContent).toEqual({ ...historical, idempotent_replay: true });
  expect(value(replay)).toEqual(replay.structuredContent);
  const conflict = await call("reply_message", { ...args, ack_required: true }, "2025-06-18");
  expect(value(conflict).error.type).toBe("IDEMPOTENCY_KEY_CONFLICT");
  expect(count()).toBe(before);
});

test("invalid fresh success rolls back mail, retry key and wake notice before returning a safe error", async () => {
  const tool = TOOLS.find((t) => t.name === "send_message");
  const run = tool.run;
  const before = db.serialize();
  tool.run = (...args) => ({ ...run(...args), unexpected: "must not escape" });
  try {
    const result = await call(
      "send_message",
      send({ idempotency_key: "invalid-result" }),
      "2025-06-18",
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(value(result)).toEqual({
      error: {
        type: "INTERNAL",
        message: "Tool result failed validation",
        recoverable: false,
        data: {},
      },
    });
    expect(db.serialize()).toEqual(before);
  } finally {
    tool.run = run;
  }
});

test("corrupt replay and nested receipt data are rejected without leaking fields or committing activity", async () => {
  const args = send({ idempotency_key: "corrupt-replay" });
  const sent = value(await call("send_message", args));
  db.run("UPDATE idempotency_keys SET result = ? WHERE key = ?", [
    JSON.stringify({
      ...sent,
      sender_location: {
        repo: "fixture",
        worktree: "/fixture",
        branch: null,
        title: null,
        private_field: "hidden",
      },
    }),
    "corrupt-replay",
  ]);
  const before = db.serialize();
  const replay = await call("send_message", args, "2025-11-25");
  expect(value(replay).error.type).toBe("INTERNAL");
  expect(replay.structuredContent).toBeUndefined();
  expect(db.serialize()).toEqual(before);
  db.run("UPDATE message_recipients SET admission_json = ? WHERE message_id = ?", [
    JSON.stringify({ ...sent.delivery.recipients[0], private_field: "hidden" }),
    sent.id,
  ]);
  const receipt = await call(
    "get_message_delivery_receipt",
    { project_key, message_id: sent.id },
    "2025-11-25",
  );
  expect(value(receipt).error.type).toBe("INTERNAL");
  expect(receipt.content[0].text).not.toContain("private_field");
  db.run("UPDATE message_recipients SET admission_json = NULL WHERE message_id = ?", [sent.id]);
  const historical = await call(
    "get_message_delivery_receipt",
    { project_key, message_id: sent.id },
    "2025-11-25",
  );
  expect(historical.structuredContent.recipients[0].admission).toBeNull();
});
