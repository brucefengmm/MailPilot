import { getAccount } from "../db/accounts";
import { updateMessageBody, type DbMessage } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";

const inFlightBodyLoads = new Map<string, Promise<DbMessage>>();

function bodyLoadKey(message: DbMessage): string {
  return `${message.account_id}:${message.id}`;
}

/**
 * Load and persist message body on demand (IMAP initial sync stores metadata only).
 */
export async function ensureMessageBodyLoaded(message: DbMessage): Promise<DbMessage> {
  if (message.body_cached || message.body_html || message.body_text) {
    return message;
  }

  const key = bodyLoadKey(message);
  const existing = inFlightBodyLoads.get(key);
  if (existing) {
    return existing;
  }

  const loadPromise = (async (): Promise<DbMessage> => {
    const account = await getAccount(message.account_id);
    if (!account) return message;

    if (account.provider === "imap" || account.provider === "gmail_api") {
      const provider = await getEmailProvider(account.id);
      const parsed = await provider.fetchMessage(message.id);
      await updateMessageBody(
        message.account_id,
        message.id,
        parsed.bodyHtml,
        parsed.bodyText,
      );

      return {
        ...message,
        body_html: parsed.bodyHtml,
        body_text: parsed.bodyText,
        body_cached: 1,
      };
    }

    return message;
  })();

  inFlightBodyLoads.set(key, loadPromise);
  try {
    return await loadPromise;
  } finally {
    inFlightBodyLoads.delete(key);
  }
}

/** Reset in-flight map for unit tests. */
export function _resetBodyLoadCacheForTesting(): void {
  inFlightBodyLoads.clear();
}
