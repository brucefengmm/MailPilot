import type { DbMessage } from "@/services/db/messages";

/** Stable fingerprint for a thread's messages; changes when messages are added/removed. */
export function computeThreadMessageFingerprint(messages: DbMessage[]): string {
  if (messages.length === 0) return "";
  return `${messages.length}|${messages.map((m) => m.id).join(",")}`;
}
