import { expect, test } from "bun:test";
import Schema from "typebox/schema";
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
  const reference = Schema.Compile(schema);
  test(`${name} direct checks preserve JSON and JavaScript contracts`, () => {
    // TypeBox checks JSON values. Explicit expectations keep JavaScript-only
    // cases independent of validator differences in undefined, keys and holes.
    /** @type {Array<[unknown, boolean?]>} */
    const cases = [
      [null],
      [[]],
      [fixture],
      [Object.create(fixture), true],
      [Object.assign(Object.create(null), structuredClone(fixture)), true],
      [Object.assign(Object.create({ private_field: true }), fixture), false],
      [Object.defineProperty(structuredClone(fixture), "private_field", { value: true }), true],
    ];
    for (const key of Object.keys(fixture)) {
      for (const value of [undefined, null, false, "wrong", [], {}, NaN, Infinity, 0.5]) {
        // Every fixture field is required for a fresh result. Nonfinite numbers
        // are invalid for these fields and have no JSON representation.
        cases.push([
          { ...structuredClone(fixture), [key]: value },
          value === undefined || (typeof value === "number" && !Number.isFinite(value))
            ? false
            : undefined,
        ]);
      }
      const missing = structuredClone(fixture);
      delete missing[key];
      cases.push([missing]);
    }
    const arrayKey = name === "receipt" ? "recipients" : "to";
    cases.push([{ ...fixture, [arrayKey]: new Array(1) }, false]);
    cases.push([
      {
        ...fixture,
        [arrayKey]: Object.assign([42], {
          [Symbol.iterator]: function* () {},
        }),
      },
      false,
    ]);
    const integerKey = name === "receipt" ? "message_id" : "id";
    cases.push([{ ...fixture, [integerKey]: -1 }], [{ ...fixture, [integerKey]: 2 ** 60 }]);
    for (const [value, javascriptExpected] of cases) {
      const before = structuredClone(value);
      expect(check(value)).toBe(javascriptExpected ?? reference.Check(value));
      expect(structuredClone(value)).toEqual(before);
    }
  });
}

test("nested fields and historical replay preserve JSON and JavaScript acceptance", () => {
  const reference = Schema.Compile(MESSAGE_RESULT);
  /** @type {Array<[unknown, boolean?]>} */
  const variants = [
    [
      {
        ...message,
        notification_policy: undefined,
        revision: undefined,
        delivery: undefined,
        idempotent_replay: true,
      },
      true,
    ],
    [{ ...message, revision: undefined, idempotent_replay: false }, false],
    [{ ...message, delivery: undefined }, false],
    [
      {
        ...message,
        sender_location: { repo: "repo", worktree: "tree", branch: null, title: null },
      },
    ],
  ];
  for (const key of Object.keys(admission)) {
    variants.push([
      {
        ...message,
        delivery: { ...message.delivery, recipients: [{ ...admission, [key]: "invalid-enum" }] },
      },
    ]);
  }
  for (const [extra, javascriptExpected] of [
    [{ private_field: true }],
    // Optional fields may be undefined without changing admission acceptance.
    [{ historical: undefined, reported_end_at: undefined }, true],
    [{ historical: true, reported_end_at: "then" }],
    [{ reported_end_at: null }],
  ]) {
    variants.push([
      {
        ...message,
        delivery: { ...message.delivery, recipients: [{ ...admission, ...extra }] },
      },
      javascriptExpected,
    ]);
  }
  for (const [value, javascriptExpected] of variants) {
    expect(isMessageResult(value)).toBe(javascriptExpected ?? reference.Check(value));
  }
  const receiptReference = Schema.Compile(RECEIPT_RESULT);
  for (const extra of [
    { admission: null },
    { kind: "bcc" },
    { kind: "other" },
    { private_field: true },
  ]) {
    const value = { ...receipt, recipients: [{ ...receipt.recipients[0], ...extra }] };
    expect(isReceiptResult(value)).toBe(receiptReference.Check(value));
  }
});
