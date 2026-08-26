import { getDb } from "./connection";
import type { ParsedAttachment } from "../gmail/messageParser";

export interface DbAttachment {
  id: string;
  message_id: string;
  account_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  gmail_attachment_id: string | null;
  content_id: string | null;
  is_inline: number;
  local_path: string | null;
}

export async function upsertAttachment(att: {
  id: string;
  messageId: string;
  accountId: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  gmailAttachmentId: string | null;
  contentId: string | null;
  isInline: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, gmail_attachment_id, content_id, is_inline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       filename = $4, mime_type = $5, size = $6,
       gmail_attachment_id = $7, content_id = $8, is_inline = $9`,
    [
      att.id,
      att.messageId,
      att.accountId,
      att.filename,
      att.mimeType,
      att.size,
      att.gmailAttachmentId,
      att.contentId,
      att.isInline ? 1 : 0,
    ],
  );
}

export interface AttachmentWithContext {
  id: string;
  message_id: string;
  account_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  gmail_attachment_id: string | null;
  content_id: string | null;
  is_inline: number;
  local_path: string | null;
  from_address: string | null;
  from_name: string | null;
  date: number | null;
  subject: string | null;
  thread_id: string | null;
}

export async function getAttachmentsForAccount(
  accountId: string,
  limit = 200,
  offset = 0,
): Promise<AttachmentWithContext[]> {
  const db = await getDb();
  return db.select<AttachmentWithContext[]>(
    `SELECT a.*, m.from_address, m.from_name, m.date, m.subject, m.thread_id
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id = $1 AND a.filename IS NOT NULL AND a.filename != ''
     ORDER BY m.date DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
}

export interface AttachmentSender {
  from_address: string;
  from_name: string | null;
  count: number;
}

export async function getAttachmentSenders(
  accountId: string,
): Promise<AttachmentSender[]> {
  const db = await getDb();
  return db.select<AttachmentSender[]>(
    `SELECT m.from_address, m.from_name, COUNT(*) as count
     FROM attachments a
     JOIN messages m ON a.message_id = m.id AND a.account_id = m.account_id
     WHERE a.account_id = $1 AND a.filename IS NOT NULL AND a.filename != ''
       AND m.from_address IS NOT NULL
     GROUP BY m.from_address
     ORDER BY count DESC`,
    [accountId],
  );
}

export async function getAttachmentsForMessage(
  accountId: string,
  messageId: string,
): Promise<DbAttachment[]> {
  const db = await getDb();
  return db.select<DbAttachment[]>(
    "SELECT * FROM attachments WHERE account_id = $1 AND message_id = $2 ORDER BY filename ASC",
    [accountId, messageId],
  );
}

/** True when the row represents a downloadable file (not inline CID or MIME container). */
export function isFileAttachment(att: DbAttachment): boolean {
  if (att.is_inline && !att.filename) return false;
  if (!att.filename) return false;

  const mime = (att.mime_type ?? "").toLowerCase();
  if (mime.startsWith("multipart/")) return false;

  return true;
}

export async function hasFileAttachments(
  accountId: string,
  messageId: string,
): Promise<boolean> {
  const atts = await getAttachmentsForMessage(accountId, messageId);
  return atts.some(isFileAttachment);
}

export async function persistParsedAttachments(
  accountId: string,
  messageId: string,
  attachments: ParsedAttachment[],
): Promise<number> {
  let stored = 0;
  for (const att of attachments) {
    if (att.isInline && !att.filename) continue;
    if (!att.filename) continue;
    const mime = (att.mimeType ?? "").toLowerCase();
    if (mime.startsWith("multipart/")) continue;

    await upsertAttachment({
      id: `${messageId}_${att.gmailAttachmentId}`,
      messageId,
      accountId,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      gmailAttachmentId: att.gmailAttachmentId,
      contentId: att.contentId,
      isInline: att.isInline,
    });
    stored++;
  }
  return stored;
}
