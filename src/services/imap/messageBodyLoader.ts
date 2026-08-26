import { getAccount } from "../db/accounts";
import {
  hasFileAttachments,
  persistParsedAttachments,
} from "../db/attachments";
import type { ParsedAttachment } from "../gmail/messageParser";
import { updateMessageBody, type DbMessage } from "../db/messages";
import { markThreadHasAttachments } from "../db/threads";
import { getEmailProvider } from "../email/providerFactory";

const inFlightBodyLoads = new Map<string, Promise<DbMessage>>();
/** Messages where attachment backfill ran but found none (avoid re-fetch every expand). */
const attachmentBackfillAttempted = new Set<string>();

function bodyLoadKey(message: DbMessage): string {
  return `${message.account_id}:${message.id}`;
}

function bodyIsReady(message: DbMessage): boolean {
  return Boolean(message.body_cached || message.body_html || message.body_text);
}

function isParsedFileAttachment(att: ParsedAttachment): boolean {
  if (att.isInline && !att.filename) return false;
  if (!att.filename) return false;
  const mime = (att.mimeType ?? "").toLowerCase();
  if (mime.startsWith("multipart/")) return false;
  return true;
}

async function fetchAndPersistMessageContent(message: DbMessage): Promise<DbMessage> {
  const account = await getAccount(message.account_id);
  if (!account) return message;

  if (account.provider !== "imap" && account.provider !== "gmail_api") {
    return message;
  }

  const provider = await getEmailProvider(account.id);
  const parsed = await provider.fetchMessage(message.id);
  const fileAttachments = parsed.attachments.filter(isParsedFileAttachment);

  if (!bodyIsReady(message)) {
    await updateMessageBody(
      message.account_id,
      message.id,
      parsed.bodyHtml,
      parsed.bodyText,
    );
  }

  if (fileAttachments.length > 0) {
    await persistParsedAttachments(message.account_id, message.id, fileAttachments);
    await markThreadHasAttachments(message.thread_id);
  } else if (bodyIsReady(message)) {
    attachmentBackfillAttempted.add(bodyLoadKey(message));
  }

  return {
    ...message,
    body_html: parsed.bodyHtml ?? message.body_html,
    body_text: parsed.bodyText ?? message.body_text,
    body_cached: 1,
  };
}

/**
 * Load and persist message body on demand (IMAP initial sync stores metadata only).
 * Also backfills attachment rows when the body is cached but attachments are missing
 * (common after header-only delta sync).
 */
export async function ensureMessageBodyLoaded(message: DbMessage): Promise<DbMessage> {
  const key = bodyLoadKey(message);
  const needsBody = !bodyIsReady(message);
  const needsAttachments =
    bodyIsReady(message) &&
    !(await hasFileAttachments(message.account_id, message.id)) &&
    !attachmentBackfillAttempted.has(key);

  if (!needsBody && !needsAttachments) {
    return message;
  }

  const existing = inFlightBodyLoads.get(key);
  if (existing) {
    return existing;
  }

  const loadPromise = fetchAndPersistMessageContent(message);
  inFlightBodyLoads.set(key, loadPromise);
  try {
    return await loadPromise;
  } finally {
    inFlightBodyLoads.delete(key);
  }
}

/**
 * Backfill attachment metadata for the latest message in a thread that has a
 * cached body but no file attachment rows (common after header-only delta sync).
 * Only touches the last message to avoid N sequential IMAP connections per thread.
 */
export async function backfillThreadAttachments(
  accountId: string,
  _threadId: string,
  messages: DbMessage[],
): Promise<number> {
  const lastWithBody = [...messages].reverse().find(bodyIsReady);
  if (!lastWithBody) return 0;
  if (await hasFileAttachments(accountId, lastWithBody.id)) return 0;

  await ensureMessageBodyLoaded(lastWithBody);
  return (await hasFileAttachments(accountId, lastWithBody.id)) ? 1 : 0;
}

/** Reset in-flight map for unit tests. */
export function _resetBodyLoadCacheForTesting(): void {
  inFlightBodyLoads.clear();
  attachmentBackfillAttempted.clear();
}
