import { getDb } from "./connection";

interface AiCacheEntry {
  id: string;
  account_id: string;
  thread_id: string;
  type: string;
  content: string;
  message_fingerprint: string | null;
  created_at: number;
}

export async function getAiCacheEntry(
  accountId: string,
  threadId: string,
  type: string,
): Promise<AiCacheEntry | null> {
  const db = await getDb();
  const rows = await db.select<AiCacheEntry[]>(
    "SELECT id, account_id, thread_id, type, content, message_fingerprint, created_at FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3",
    [accountId, threadId, type],
  );
  return rows[0] ?? null;
}

export async function getAiCache(
  accountId: string,
  threadId: string,
  type: string,
): Promise<string | null> {
  const entry = await getAiCacheEntry(accountId, threadId, type);
  return entry?.content ?? null;
}

export async function getValidAiCacheContent(
  accountId: string,
  threadId: string,
  type: string,
  messageFingerprint: string,
): Promise<string | null> {
  if (!messageFingerprint) return null;
  const entry = await getAiCacheEntry(accountId, threadId, type);
  if (!entry?.message_fingerprint || entry.message_fingerprint !== messageFingerprint) {
    return null;
  }
  return entry.content;
}

export async function setAiCache(
  accountId: string,
  threadId: string,
  type: string,
  content: string,
  messageFingerprint?: string,
): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO ai_cache (id, account_id, thread_id, type, content, message_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(account_id, thread_id, type) DO UPDATE SET
       content = $5, message_fingerprint = $6, created_at = unixepoch()`,
    [id, accountId, threadId, type, content, messageFingerprint ?? null],
  );
}

export async function deleteAiCache(
  accountId: string,
  threadId: string,
  type: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3",
    [accountId, threadId, type],
  );
}
