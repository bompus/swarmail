import { type Args, ToolError } from "./store.ts";

const fields = ["resource_id", "phase_id", "state", "next_action"];
const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 96,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
  not: { pattern: "\\s" },
};

export const RESOURCE_NOTICE_SCHEMA = {
  type: "object",
  description:
    "Resource release or dependency cancellation. Exactly four fields: resource_id and phase_id are opaque ASCII identifiers (1..96 characters, starting with a letter/digit, then letters/digits/_.:-). released allows none or retry_admission; cancelled allows none or drop_dependency. Only request an action from a receiver with that dependency. Identifiers and receipts do not prove release or grant permission.",
  additionalProperties: false,
  properties: {
    resource_id: identifier,
    phase_id: identifier,
    state: { type: "string", enum: ["released", "cancelled"] },
    next_action: { type: "string", enum: ["none", "retry_admission", "drop_dependency"] },
  },
  required: fields,
  oneOf: [
    {
      properties: {
        state: { const: "released" },
        next_action: { enum: ["none", "retry_admission"] },
      },
    },
    {
      properties: {
        state: { const: "cancelled" },
        next_action: { enum: ["none", "drop_dependency"] },
      },
    },
  ],
};

const sendFields = [
  "project_key",
  "sender_name",
  "to",
  "resource_notice",
  "idempotency_key",
  "thread_id",
];
export const RESOURCE_SEND_CONSTRAINTS = {
  oneOf: [
    { required: ["subject", "body_md"], not: { required: ["resource_notice"] } },
    {
      required: ["resource_notice", "idempotency_key"],
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(sendFields.map((field) => [field, {}])),
        to: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", pattern: "\\S" } },
        idempotency_key: { type: "string", pattern: "\\S" },
      },
    },
  ],
};

/** Compile the typed send input before admission or retry lookup; never accept caller-written prose. */
export function compileResourceNotice(args: Args): Args {
  const invalid = () => {
    throw new ToolError(
      "INVALID_ARGUMENT",
      "invalid resource notice; inspect send_message or swarmail send --help",
    );
  };
  const notice = args.resource_notice;
  if (
    Object.keys(args).some((key) => !sendFields.includes(key)) ||
    typeof args.project_key !== "string" ||
    typeof args.sender_name !== "string" ||
    (Object.hasOwn(args, "thread_id") && typeof args.thread_id !== "string") ||
    !Array.isArray(args.to) ||
    args.to.length !== 1 ||
    typeof args.to[0] !== "string" ||
    !args.to[0].trim() ||
    typeof args.idempotency_key !== "string" ||
    !args.idempotency_key.trim() ||
    !notice ||
    typeof notice !== "object" ||
    Array.isArray(notice)
  ) {
    invalid();
  }
  const value = notice as Record<string, unknown>;
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => typeof value[key] !== "string") ||
    [value.resource_id, value.phase_id].some(
      (id) =>
        typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id) || /\s/.test(id),
    ) ||
    !(value.state === "released"
      ? value.next_action === "none" || value.next_action === "retry_admission"
      : value.state === "cancelled" &&
        (value.next_action === "none" || value.next_action === "drop_dependency"))
  ) {
    invalid();
  }
  const released = value.state === "released";
  const sentence = released
    ? `Resource \`${value.resource_id}\` was released by phase \`${value.phase_id}\`.`
    : `Phase \`${value.phase_id}\` cancelled its dependency on resource \`${value.resource_id}\`.`;
  const action =
    value.next_action === "retry_admission"
      ? "Recheck admission before starting."
      : value.next_action === "drop_dependency"
        ? "Remove that dependency. Resource availability is not established."
        : "No action requested.";
  return {
    ...args,
    resource_notice: Object.fromEntries(fields.map((key) => [key, value[key]])),
    subject: released ? "Resource released" : "Dependency cancelled",
    body_md: `${sentence} ${action}`,
    topic: "resource-coordination",
    importance: "normal",
    ack_required: false,
    notification_policy: value.next_action === "none" ? "quiet" : "wake",
  };
}
