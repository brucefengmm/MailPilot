import type Database from "@tauri-apps/plugin-sql";
import { getDb, withTransaction } from "./connection";

/** Max SQLite rowid captured when bulk mode starts — used to incrementally rebuild FTS. */
let bulkWriteStartRowid = 0;
let bulkWriteDepth = 0;

const MESSAGE_FTS_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
    VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
    VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
  END`,
] as const;

/**
 * Optimise SQLite for large sequential writes during IMAP sync.
 * Disables per-row FTS triggers (major source of lock time) and restores them on exit.
 */
export async function enterBulkWriteMode(): Promise<void> {
  bulkWriteDepth += 1;
  if (bulkWriteDepth > 1) return;

  const db = await getDb();
  const rows = await db.select<{ maxRowid: number }[]>(
    "SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM messages",
    [],
  );
  bulkWriteStartRowid = rows[0]?.maxRowid ?? 0;

  await db.execute("PRAGMA synchronous = OFF", []);
  await db.execute("PRAGMA cache_size = -64000", []);
  await db.execute("PRAGMA temp_store = MEMORY", []);
  await db.execute("DROP TRIGGER IF EXISTS messages_ai", []);
  await db.execute("DROP TRIGGER IF EXISTS messages_ad", []);
  await db.execute("DROP TRIGGER IF EXISTS messages_au", []);

  console.log("[bulkWrite] Entered bulk write mode (FTS triggers disabled)");
}

export async function exitBulkWriteMode(): Promise<void> {
  if (bulkWriteDepth === 0) return;
  bulkWriteDepth -= 1;
  if (bulkWriteDepth > 0) return;

  const ftsStartRowid = bulkWriteStartRowid;
  bulkWriteStartRowid = 0;

  // Restore triggers asynchronously so sync completion is not blocked on lock wait.
  void restoreBulkWriteTriggers(ftsStartRowid);
}

async function restoreBulkWriteTriggers(ftsStartRowid: number): Promise<void> {
  try {
    const db = await getDb();
    await db.execute("PRAGMA synchronous = NORMAL", []);

    for (const stmt of MESSAGE_FTS_TRIGGER_STATEMENTS) {
      await db.execute(stmt, []);
    }

    console.log("[bulkWrite] Exited bulk write mode (FTS triggers restored)");

    // Full rebuild — incremental updates leave FTS out of sync after bulk insert.
    if (ftsStartRowid >= 0) {
      await rebuildFtsFull();
    }
  } catch (err) {
    console.warn("[bulkWrite] Failed to restore FTS triggers:", err);
  }
}

/** Rebuild the entire messages FTS index from scratch. */
export async function rebuildFtsFull(): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')", []);
  console.log("[bulkWrite] FTS full rebuild complete");
}

export function isBulkWriteMode(): boolean {
  return bulkWriteDepth > 0;
}

/** Restore FTS triggers if a previous sync was interrupted mid-bulk-write. */
export async function recoverBulkWriteState(): Promise<void> {
  bulkWriteDepth = 0;
  bulkWriteStartRowid = 0;

  const db = await getDb();
  const rows = await db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_ai'",
    [],
  );

  if (rows.length === 0) {
    console.warn("[bulkWrite] FTS triggers missing — recovering from interrupted bulk sync");
    for (const stmt of MESSAGE_FTS_TRIGGER_STATEMENTS) {
      await db.execute(stmt, []);
    }
  }

  if (!(await isFtsHealthy())) {
    console.warn("[bulkWrite] FTS index unhealthy — rebuilding");
    await rebuildFtsFull();
  }
}

/** Probe whether message UPDATE triggers work (FTS index in sync). */
export async function isFtsHealthy(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ rowid: number }[]>(
    "SELECT rowid FROM messages LIMIT 1",
    [],
  );
  if (rows.length === 0) return true;

  try {
    await db.execute("BEGIN IMMEDIATE", []);
    await db.execute("UPDATE messages SET snippet = snippet WHERE rowid = $1", [
      rows[0]!.rowid,
    ]);
    await db.execute("ROLLBACK", []);
    return true;
  } catch {
    try {
      await db.execute("ROLLBACK", []);
    } catch {
      // already rolled back
    }
    return false;
  }
}

export interface BulkPlaceholderMessage {
  threadId: string;
  accountId: string;
  subject: string | null;
  snippet: string;
  lastMessageAt: number;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  /** Folder/system labels (INBOX, SENT, UNREAD, …) so inbox queries work before Phase 4. */
  labelIds: string[];
  message: {
    id: string;
    fromAddress: string | null;
    fromName: string | null;
    toAddresses: string | null;
    ccAddresses: string | null;
    bccAddresses: string | null;
    replyTo: string | null;
    date: number;
    bodyHtml: string | null;
    bodyText: string | null;
    rawSize: number | null;
    internalDate: number | null;
    listUnsubscribe: string | null;
    listUnsubscribePost: string | null;
    authResults: string | null;
    messageIdHeader: string | null;
    referencesHeader: string | null;
    inReplyToHeader: string | null;
    imapUid: number | null;
    imapFolder: string | null;
  };
  attachments: {
    id: string;
    filename: string | null;
    mimeType: string | null;
    size: number | null;
    gmailAttachmentId: string | null;
    contentId: string | null;
    isInline: boolean;
  }[];
}

/** Insert placeholder threads + messages + attachments in one transaction (no FTS triggers). */
export async function bulkInsertPlaceholderMessages(
  items: BulkPlaceholderMessage[],
): Promise<void> {
  if (items.length === 0) return;

  const toWrite = await filterChangedPlaceholderItems(items);
  if (toWrite.length === 0) {
    console.log(`[bulkWrite] Skipped ${items.length} unchanged placeholder(s)`);
    return;
  }
  if (toWrite.length < items.length) {
    console.log(`[bulkWrite] Writing ${toWrite.length}/${items.length} changed placeholder(s)`);
  }

  await withTransaction(async (db) => {
    const labelEntries: { threadId: string; labelId: string }[] = [];
    for (const item of toWrite) {
      await insertPlaceholderMessage(db, item, labelEntries);
    }
    await insertThreadLabelsBatch(db, toWrite[0]!.accountId, labelEntries);
  });
}

interface ExistingImapRow {
  imap_uid: number;
  imap_folder: string;
  is_read: number;
  is_starred: number;
}

function imapRowKey(folder: string, uid: number): string {
  return `${folder}\0${uid}`;
}

/** Skip messages already in DB with identical IMAP metadata (avoids no-op upserts on re-sync). */
async function filterChangedPlaceholderItems(
  items: BulkPlaceholderMessage[],
): Promise<BulkPlaceholderMessage[]> {
  if (items.length === 0) return items;

  const accountId = items[0]!.accountId;
  const existing = new Map<string, ExistingImapRow>();
  const db = await getDb();

  // Group by folder — query existing rows by (account, folder, uid) which is stable across re-sync.
  const byFolder = new Map<string, BulkPlaceholderMessage[]>();
  for (const item of items) {
    const folder = item.message.imapFolder;
    const uid = item.message.imapUid;
    if (!folder || uid == null) continue;
    const bucket = byFolder.get(folder);
    if (bucket) {
      bucket.push(item);
    } else {
      byFolder.set(folder, [item]);
    }
  }

  for (const [folder, folderItems] of byFolder) {
    for (let i = 0; i < folderItems.length; i += 200) {
      const chunk = folderItems.slice(i, i + 200);
      const placeholders = chunk.map((_, idx) => `$${idx + 3}`).join(", ");
      const rows = await db.select<ExistingImapRow[]>(
        `SELECT imap_uid, imap_folder, is_read, is_starred
         FROM messages
         WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IN (${placeholders})`,
        [accountId, folder, ...chunk.map((item) => item.message.imapUid!)],
      );
      for (const row of rows) {
        existing.set(imapRowKey(row.imap_folder, row.imap_uid), row);
      }
    }
  }

  return items.filter((item) => {
    const folder = item.message.imapFolder;
    const uid = item.message.imapUid;
    if (!folder || uid == null) return true;

    const row = existing.get(imapRowKey(folder, uid));
    if (!row) return true;

    return (
      row.is_read !== (item.isRead ? 1 : 0) ||
      row.is_starred !== (item.isStarred ? 1 : 0)
    );
  });
}

async function insertThreadLabelsBatch(
  db: Database,
  accountId: string,
  entries: { threadId: string; labelId: string }[],
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const { threadId, labelId } of slice) {
      values.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
      params.push(accountId, threadId, labelId);
      idx += 3;
    }
    await db.execute(
      `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

async function insertPlaceholderMessage(
  db: Database,
  item: BulkPlaceholderMessage,
  labelEntries: { threadId: string; labelId: string }[],
): Promise<void> {
  const { message: msg, accountId } = item;

  await db.execute(
    `INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = $3, snippet = $4, last_message_at = $5, message_count = $6,
       is_read = $7, is_starred = $8, is_important = $9, has_attachments = $10`,
    [
      item.threadId,
      accountId,
      item.subject,
      item.snippet,
      item.lastMessageAt,
      1,
      item.isRead ? 1 : 0,
      item.isStarred ? 1 : 0,
      0,
      item.hasAttachments ? 1 : 0,
    ],
  );

  for (const labelId of item.labelIds) {
    labelEntries.push({ threadId: item.threadId, labelId });
  }

  await db.execute(
    `INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, auth_results, message_id_header, references_header, in_reply_to_header, imap_uid, imap_folder)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
     ON CONFLICT(account_id, id) DO UPDATE SET
       from_address = $4, from_name = $5, to_addresses = $6, cc_addresses = $7,
       bcc_addresses = $8, reply_to = $9, subject = $10, snippet = $11,
       date = $12, is_read = $13, is_starred = $14,
       body_html = COALESCE($15, body_html), body_text = COALESCE($16, body_text),
       body_cached = CASE WHEN $15 IS NOT NULL THEN 1 ELSE body_cached END,
       raw_size = $18, internal_date = $19, list_unsubscribe = $20, list_unsubscribe_post = $21,
       auth_results = $22, message_id_header = COALESCE($23, message_id_header),
       references_header = COALESCE($24, references_header),
       in_reply_to_header = COALESCE($25, in_reply_to_header),
       imap_uid = COALESCE($26, imap_uid), imap_folder = COALESCE($27, imap_folder)`,
    [
      msg.id,
      accountId,
      msg.id,
      msg.fromAddress,
      msg.fromName,
      msg.toAddresses,
      msg.ccAddresses,
      msg.bccAddresses,
      msg.replyTo,
      item.subject,
      item.snippet,
      msg.date,
      item.isRead ? 1 : 0,
      item.isStarred ? 1 : 0,
      msg.bodyHtml,
      msg.bodyText,
      msg.bodyHtml ? 1 : 0,
      msg.rawSize,
      msg.internalDate,
      msg.listUnsubscribe,
      msg.listUnsubscribePost,
      msg.authResults,
      msg.messageIdHeader,
      msg.referencesHeader,
      msg.inReplyToHeader,
      msg.imapUid,
      msg.imapFolder,
    ],
  );

  for (const att of item.attachments) {
    await db.execute(
      `INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, gmail_attachment_id, content_id, is_inline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(id) DO UPDATE SET
         filename = $4, mime_type = $5, size = $6,
         gmail_attachment_id = $7, content_id = $8, is_inline = $9`,
      [
        att.id,
        msg.id,
        accountId,
        att.filename,
        att.mimeType,
        att.size,
        att.gmailAttachmentId,
        att.contentId,
        att.isInline ? 1 : 0,
      ],
    );
  }
}

/** @internal Exported for unit tests. */
export const bulkWriteInternals = {
  filterChangedPlaceholderItems,
  imapRowKey,
  MESSAGE_FTS_TRIGGER_STATEMENTS,
};
