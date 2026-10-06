// Direct checks for the closed MCP output contracts in message-results.ts.
type Check = (value: unknown) => boolean;
const string: Check = (value) => typeof value === "string";
const integer = Number.isInteger;
const boolean: Check = (value) => typeof value === "boolean";
const nullableString: Check = (value) => value === null || string(value);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const list =
  (check: Check): Check =>
  (value) => {
    if (!Array.isArray(value)) {
      return false;
    }
    for (let i = 0; i < value.length; i++) {
      if (!check(value[i])) {
        return false;
      }
    }
    return true;
  };
const oneOf =
  (values: readonly unknown[]): Check =>
  (value) =>
    values.includes(value);
const closed = (fields: Record<string, Check>): Check => {
  const checks = Object.entries(fields);
  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    for (const key in value) {
      if (!Object.hasOwn(fields, key)) {
        return false;
      }
    }
    for (const [key, check] of checks) {
      if (!check((value as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  };
};
const admission = closed({
  recipient: string,
  availability: oneOf(["eligible", "unavailable", "unknown"]),
  lifecycle: string,
  process: oneOf(["present", "unknown"]),
  wake: (value: unknown) => value === "unknown",
  source: oneOf(["t3", "registry", "registration"]),
  reason: string,
  observed_at: string,
  reported_end_at: optional(string),
  historical: optional(boolean),
});
const nullableAdmission: Check = (value) => value === null || admission(value);
const location = closed({
  repo: string,
  worktree: string,
  branch: nullableString,
  title: nullableString,
});
const delivery = closed({
  persisted: boolean,
  admission_checked_at: string,
  historical: boolean,
  recipients: list(admission),
  warnings: list(string),
});
const messageFields = {
  id: integer,
  project_id: integer,
  sender_id: integer,
  thread_id: nullableString,
  topic: nullableString,
  subject: string,
  body_md: string,
  importance: string,
  notification_policy: optional(oneOf(["wake", "quiet"])),
  revision: optional(integer),
  ack_required: boolean,
  created_ts: nullableString,
  from: string,
  sender_location: (value: unknown) => value === null || location(value),
  to: list(string),
  cc: list(string),
  bcc: list(string),
  delivery: optional(delivery),
  idempotent_replay: optional(boolean),
};
const messageResult = (fields: Record<string, Check>): Check => {
  const check = closed(fields);
  return (value) =>
    check(value) &&
    (((value as Record<string, unknown>).delivery !== undefined &&
      (value as Record<string, unknown>).revision !== undefined &&
      (value as Record<string, unknown>).notification_policy !== undefined) ||
      (value as Record<string, unknown>).idempotent_replay === true);
};
export const isMessageResult = messageResult(messageFields);
export const isReplyResult = messageResult({ ...messageFields, reply_to: integer });
export const isReceiptResult = closed({
  message_id: integer,
  project_id: integer,
  persisted_at: nullableString,
  revision: integer,
  recipients: list(
    closed({
      recipient: string,
      kind: oneOf(["to", "cc", "bcc"]),
      read_at: nullableString,
      acknowledged: boolean,
      acknowledged_at: nullableString,
      withdrawn_at: nullableString,
      admission: nullableAdmission,
    }),
  ),
});
