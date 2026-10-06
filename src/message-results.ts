// Closed success contracts shared by the tool definitions and transaction-time validation.
const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const nullableString = { type: ["string", "null"] };
const array = (items: Record<string, unknown>) => ({ type: "array", items });
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const admission = object(
  {
    recipient: string,
    availability: { enum: ["eligible", "unavailable", "unknown"] },
    lifecycle: string,
    process: { enum: ["present", "unknown"] },
    wake: { const: "unknown" },
    source: { enum: ["t3", "registry", "registration"] },
    reason: string,
    observed_at: string,
    reported_end_at: string,
    historical: boolean,
  },
  ["reported_end_at", "historical"],
);
const message = {
  id: integer,
  project_id: integer,
  sender_id: integer,
  thread_id: nullableString,
  topic: nullableString,
  subject: string,
  body_md: string,
  importance: string,
  revision: integer,
  ack_required: boolean,
  created_ts: nullableString,
  from: string,
  sender_location: {
    ...object({ repo: string, worktree: string, branch: nullableString, title: nullableString }),
    type: ["object", "null"],
  },
  to: array(string),
  cc: array(string),
  bcc: array(string),
  delivery: object({
    persisted: boolean,
    admission_checked_at: string,
    historical: boolean,
    recipients: array(admission),
    warnings: array(string),
  }),
  idempotent_replay: boolean,
};
// Pre-admission/pre-revision retry records keep their original fields on replay.
const messageResult = (properties: Record<string, unknown>) => ({
  ...object(properties, ["idempotent_replay", "delivery", "revision"]),
  anyOf: [
    { required: ["delivery", "revision"] },
    { properties: { idempotent_replay: { const: true } }, required: ["idempotent_replay"] },
  ],
});
export const MESSAGE_RESULT = messageResult(message);
export const REPLY_RESULT = messageResult({ ...message, reply_to: integer });
export const RECEIPT_RESULT = object({
  message_id: integer,
  project_id: integer,
  persisted_at: nullableString,
  revision: integer,
  recipients: array(
    object({
      recipient: string,
      kind: { enum: ["to", "cc", "bcc"] },
      read_at: nullableString,
      acknowledged: boolean,
      acknowledged_at: nullableString,
      withdrawn_at: nullableString,
      admission: { ...admission, type: ["object", "null"] },
    }),
  ),
});
