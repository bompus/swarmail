import { iso } from "./db.ts";
import type { Row } from "./store.ts";

export const payload = (m: Row, sender: string) => {
  const recipients = JSON.parse(m.recipients_json);
  return {
    id: m.id,
    project_id: m.project_id,
    sender_id: m.sender_id,
    thread_id: m.thread_id,
    topic: m.topic,
    subject: m.subject,
    body_md: m.body_md,
    importance: m.importance,
    revision: m.revision,
    ack_required: !!m.ack_required,
    created_ts: iso(m.created_ts),
    from: sender,
    sender_location: m.sender_location ? JSON.parse(m.sender_location) : null,
    to: recipients.to ?? [],
    cc: recipients.cc ?? [],
    bcc: recipients.bcc ?? [],
  };
};

export const inboxOut = (m: Row, includeBody: boolean) => ({
  id: m.id,
  project_id: m.project_id,
  sender_id: m.sender_id,
  thread_id: m.thread_id,
  topic: m.topic,
  subject: m.subject,
  importance: m.importance,
  revision: m.revision,
  ack_required: !!m.ack_required,
  from: m.from,
  sender_location: m.sender_location ? JSON.parse(m.sender_location) : null,
  created_ts: iso(m.created_ts),
  // Omit unset read_ts and ack_ts.
  ...(m.read_ts != null && { read_ts: iso(m.read_ts) }),
  ...(m.ack_ts != null && { ack_ts: iso(m.ack_ts) }),
  kind: m.kind,
  ...(includeBody && { body_md: m.body_md }),
});
