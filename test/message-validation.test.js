import { expect, test } from "bun:test";
import Ajv from "ajv";
import { MESSAGE_RESULT, REPLY_RESULT, RECEIPT_RESULT } from "../src/message-results.ts";
import { isMessageResult, isReplyResult, isReceiptResult } from "../src/message-validation.ts";

const admission = {
  recipient: "Receiver",
  availability: "eligible",
  lifecycle: "active",
  process: "present",
  wake: "unknown",
  source: "t3",
  reason: "registered",
  observed_at: "now",
};
const message = {
  id: 1,
  project_id: 2,
  sender_id: 3,
  thread_id: null,
  topic: null,
  subject: "Request",
  body_md: "Body",
  importance: "normal",
  notification_policy: "wake",
  revision: 1,
  ack_required: false,
  created_ts: null,
  from: "Sender",
  sender_location: null,
  to: ["Receiver"],
  cc: [],
  bcc: [],
  delivery: {
    persisted: true,
    admission_checked_at: "now",
    historical: false,
    recipients: [admission],
    warnings: [],
  },
};
const receipt = {
  message_id: 1,
  project_id: 2,
  persisted_at: null,
  revision: 1,
  recipients: [
    {
      recipient: "Receiver",
      kind: "to",
      read_at: null,
      acknowledged: false,
      acknowledged_at: null,
      withdrawn_at: null,
      admission,
    },
  ],
};
const ajv = new Ajv();
for (const { name, schema, check, fixture } of [
  { name: "message", schema: MESSAGE_RESULT, check: isMessageResult, fixture: message },
  {
    name: "reply",
    schema: REPLY_RESULT,
    check: isReplyResult,
    fixture: { ...message, reply_to: 1 },
  },
  { name: "receipt", schema: RECEIPT_RESULT, check: isReceiptResult, fixture: receipt },
]) {
  const reference = ajv.compile(schema);
  test(`${name} direct checks match the advertised closed contract`, () => {
    const cases = [
      null,
      [],
      fixture,
      Object.create(fixture),
      Object.assign(Object.create(null), structuredClone(fixture)),
      Object.assign(Object.create({ private_field: true }), fixture),
      Object.defineProperty(structuredClone(fixture), "private_field", { value: true }),
    ];
    for (const key of Object.keys(fixture)) {
      for (const value of [undefined, null, false, "wrong", [], {}, NaN, Infinity, 0.5]) {
        cases.push({ ...structuredClone(fixture), [key]: value });
      }
      const missing = structuredClone(fixture);
      delete missing[key];
      cases.push(missing);
    }
    const arrayKey = name === "receipt" ? "recipients" : "to";
    cases.push({ ...fixture, [arrayKey]: new Array(1) });
    cases.push({
      ...fixture,
      [arrayKey]: Object.assign([42], {
        [Symbol.iterator]: function* () {},
      }),
    });
    const integerKey = name === "receipt" ? "message_id" : "id";
    cases.push({ ...fixture, [integerKey]: -1 }, { ...fixture, [integerKey]: 2 ** 60 });
    for (const value of cases) {
      const before = structuredClone(value);
      expect(check(value)).toBe(reference(value));
      expect(structuredClone(value)).toEqual(before);
    }
  });
}

test("nested fields and historical replay preserve JSON Schema acceptance", () => {
  const reference = ajv.compile(MESSAGE_RESULT);
  const variants = [
    {
      ...message,
      notification_policy: undefined,
      revision: undefined,
      delivery: undefined,
      idempotent_replay: true,
    },
    { ...message, revision: undefined, idempotent_replay: false },
    { ...message, delivery: undefined },
    { ...message, sender_location: { repo: "repo", worktree: "tree", branch: null, title: null } },
  ];
  for (const key of Object.keys(admission)) {
    variants.push({
      ...message,
      delivery: { ...message.delivery, recipients: [{ ...admission, [key]: "invalid-enum" }] },
    });
  }
  for (const extra of [
    { private_field: true },
    { historical: undefined, reported_end_at: undefined },
    { historical: true, reported_end_at: "then" },
    { reported_end_at: null },
  ]) {
    variants.push({
      ...message,
      delivery: { ...message.delivery, recipients: [{ ...admission, ...extra }] },
    });
  }
  for (const value of variants) {
    expect(isMessageResult(value)).toBe(reference(value));
  }
  const receiptReference = ajv.compile(RECEIPT_RESULT);
  for (const extra of [
    { admission: null },
    { kind: "bcc" },
    { kind: "other" },
    { private_field: true },
  ]) {
    const value = { ...receipt, recipients: [{ ...receipt.recipients[0], ...extra }] };
    expect(isReceiptResult(value)).toBe(receiptReference(value));
  }
});
