import { getAccount } from "../db/accounts";
import { updateMessageBody, type DbMessage } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";

/**
 * Load and persist message body on demand (IMAP initial sync stores metadata only).
 */
export async function ensureMessageBodyLoaded(message: DbMessage): Promise<DbMessage> {
  if (message.body_cached || message.body_html || message.body_text) {
    return message;
  }

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
}
