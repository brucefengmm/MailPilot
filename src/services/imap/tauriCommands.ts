import { invoke } from '@tauri-apps/api/core';

// ---------- IMAP types ----------

export interface ImapConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string; // plaintext password or OAuth2 access token
  auth_method: 'password' | 'oauth2';
  accept_invalid_certs?: boolean;
}

export interface ImapFolder {
  path: string;       // decoded UTF-8 display name
  raw_path: string;   // original modified UTF-7 path for IMAP commands
  name: string;       // decoded display name (last segment)
  delimiter: string;
  special_use: string | null;
  exists: number;
  unseen: number;
}

export interface ImapMessage {
  uid: number;
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  date: number;
  is_read: boolean;
  is_starred: boolean;
  is_draft: boolean;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  raw_size: number;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  attachments: ImapAttachment[];
}

export interface ImapAttachment {
  part_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  is_inline: boolean;
}

export interface ImapFolderStatus {
  uidvalidity: number;
  uidnext: number;
  exists: number;
  unseen: number;
  highest_modseq: number | null;
}

export interface ImapFetchResult {
  messages: ImapMessage[];
  folder_status: ImapFolderStatus;
}

// ---------- Folder search result (lightweight: UIDs + status only) ----------

export interface ImapFolderSearchResult {
  uids: number[];
  folder_status: ImapFolderStatus;
}

// ---------- Folder sync result (single-connection search + fetch) ----------

export interface ImapFolderSyncSummary {
  uids: number[];
  folder_status: ImapFolderStatus;
  messages_fetched: number;
}

export interface ImapSyncBatchEvent {
  accountId: string;
  folder: string;
  messages: ImapMessage[];
  fetchedCount: number;
  totalUids: number;
  batchIndex: number;
  isLastBatch: boolean;
  folderStatus: ImapFolderStatus;
}

export interface ImapFolderSyncResult {
  uids: number[];
  messages: ImapMessage[];
  folder_status: ImapFolderStatus;
}

/** Event payload uses camelCase (Rust #[serde(rename_all = "camelCase")]). */
interface ImapSyncBatchEventPayload {
  accountId: string;
  folder: string;
  messages: ImapMessage[];
  fetchedCount: number;
  totalUids: number;
  batchIndex: number;
  isLastBatch: boolean;
  folderStatus: ImapFolderStatus;
}

// ---------- Delta check types ----------

export interface DeltaCheckRequest {
  folder: string;
  last_uid: number;
  uidvalidity: number;
}

export interface DeltaCheckResult {
  folder: string;
  uidvalidity: number;
  new_uids: number[];
  uidvalidity_changed: boolean;
}

// ---------- Batch sync types ----------

export interface SearchFolderRequest {
  folder: string;
  since_date?: string | null;
}

export interface ImapFolderSearchBatchResult {
  folder: string;
  uids: number[];
  folder_status: ImapFolderStatus;
}

export interface FolderUidFetch {
  folder: string;
  uids: number[];
  /** When true, fetch full body even if request.headers_only is set (e.g. UIDVALIDITY resync). */
  full_body?: boolean;
}

export interface ImapFolderFetchBatchResult {
  folder: string;
  messages: ImapMessage[];
  folder_status: ImapFolderStatus;
}

export interface ImapDeltaSyncRequest {
  new_folder_searches: SearchFolderRequest[];
  delta_checks: DeltaCheckRequest[];
  fetches: FolderUidFetch[];
  headers_only?: boolean;
  /** SINCE date for UIDVALIDITY-changed folder resync (DD-Mon-YYYY). */
  resync_since_date?: string | null;
}

export interface ImapDeltaSyncResult {
  search_results: ImapFolderSearchBatchResult[];
  delta_results: DeltaCheckResult[];
  fetch_results: ImapFolderFetchBatchResult[];
}

// ---------- SMTP types ----------

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
  auth_method: 'password' | 'oauth2';
  accept_invalid_certs?: boolean;
}

export interface SmtpSendResult {
  success: boolean;
  message: string;
}

// ---------- IMAP commands ----------

/**
 * Test IMAP connectivity: connect, authenticate, list folders, logout.
 * Returns a success message string.
 */
export async function imapTestConnection(config: ImapConfig): Promise<string> {
  console.info('[MailPilot] imapTestConnection', {
    host: config.host,
    port: config.port,
    security: config.security,
    auth_method: config.auth_method,
    username: config.username,
    credential_len: config.password.length,
    accept_invalid_certs: config.accept_invalid_certs ?? false,
  });
  try {
    const result = await invoke<string>('imap_test_connection', { config });
    console.info('[MailPilot] imapTestConnection success:', result);
    return result;
  } catch (err) {
    console.error('[MailPilot] imapTestConnection failed:', err);
    throw err;
  }
}

/**
 * List all IMAP folders/mailboxes on the server.
 */
export async function imapListFolders(config: ImapConfig): Promise<ImapFolder[]> {
  return invoke<ImapFolder[]>('imap_list_folders', { config });
}

/**
 * Fetch messages from a folder by UID list.
 * Returns parsed messages along with folder status metadata.
 */
export async function imapFetchMessages(
  config: ImapConfig,
  folder: string,
  uids: number[]
): Promise<ImapFetchResult> {
  return invoke<ImapFetchResult>('imap_fetch_messages', { config, folder, uids });
}

/**
 * Get UIDs of messages newer than `sinceUid` in the given folder.
 */
export async function imapFetchNewUids(
  config: ImapConfig,
  folder: string,
  sinceUid: number
): Promise<number[]> {
  return invoke<number[]>('imap_fetch_new_uids', { config, folder, sinceUid });
}

/**
 * Search for all UIDs in a folder using UID SEARCH ALL.
 * Returns real UIDs — avoids the sparse UID gap problem with generateUidRange.
 */
export async function imapSearchAllUids(
  config: ImapConfig,
  folder: string
): Promise<number[]> {
  return invoke<number[]>('imap_search_all_uids', { config, folder });
}

/**
 * Fetch a single message with full body by UID.
 */
export async function imapFetchMessageBody(
  config: ImapConfig,
  folder: string,
  uid: number
): Promise<ImapMessage> {
  return invoke<ImapMessage>('imap_fetch_message_body', { config, folder, uid });
}

/**
 * Set or remove flags on messages.
 * @param flags - Flag names (e.g. "Seen", "Flagged", "Draft"). Backslash prefix is added automatically.
 * @param add - true to add flags, false to remove them.
 */
export async function imapSetFlags(
  config: ImapConfig,
  folder: string,
  uids: number[],
  flags: string[],
  add: boolean
): Promise<void> {
  return invoke<void>('imap_set_flags', { config, folder, uids, flags, add });
}

/**
 * Move messages from one folder to another.
 * Uses MOVE extension if available, falls back to COPY+DELETE.
 */
export async function imapMoveMessages(
  config: ImapConfig,
  folder: string,
  uids: number[],
  destination: string
): Promise<void> {
  return invoke<void>('imap_move_messages', { config, folder, uids, destination });
}

/**
 * Permanently delete messages (flag as Deleted + EXPUNGE).
 */
export async function imapDeleteMessages(
  config: ImapConfig,
  folder: string,
  uids: number[]
): Promise<void> {
  return invoke<void>('imap_delete_messages', { config, folder, uids });
}

/**
 * Append a raw message to a folder (for saving sent mail or drafts).
 * @param rawMessage - The full email message encoded as base64url.
 * @param flags - Optional IMAP flags string (e.g. "(\\Seen)" or "(\\Draft)").
 */
export async function imapAppendMessage(
  config: ImapConfig,
  folder: string,
  rawMessage: string,
  flags?: string
): Promise<void> {
  return invoke<void>('imap_append_message', { config, folder, flags: flags ?? null, rawMessage });
}

/**
 * Get folder status (UIDVALIDITY, UIDNEXT, message count, unseen count).
 */
export async function imapGetFolderStatus(
  config: ImapConfig,
  folder: string
): Promise<ImapFolderStatus> {
  return invoke<ImapFolderStatus>('imap_get_folder_status', { config, folder });
}

/**
 * Fetch a specific MIME part (attachment) by UID and part ID.
 * Returns the attachment data as a base64-encoded string.
 */
export async function imapFetchAttachment(
  config: ImapConfig,
  folder: string,
  uid: number,
  partId: string
): Promise<string> {
  return invoke<string>('imap_fetch_attachment', { config, folder, uid, partId });
}

/**
 * Fetch the raw RFC822 source of a single message by UID.
 * Returns the full message as a UTF-8 string.
 */
export async function imapFetchRawMessage(
  config: ImapConfig,
  folder: string,
  uid: number
): Promise<string> {
  return invoke<string>('imap_fetch_raw_message', { config, folder, uid });
}

/**
 * Check multiple folders for new UIDs in a single IMAP connection.
 * Replaces N separate imapGetFolderStatus + imapFetchNewUids calls with one round-trip.
 */
export async function imapDeltaCheck(
  config: ImapConfig,
  folders: DeltaCheckRequest[]
): Promise<DeltaCheckResult[]> {
  return invoke<DeltaCheckResult[]>('imap_delta_check', { config, folders });
}

/**
 * Search multiple folders in a single IMAP connection.
 */
export async function imapSearchFoldersBatch(
  config: ImapConfig,
  folders: SearchFolderRequest[],
): Promise<ImapFolderSearchBatchResult[]> {
  return invoke<ImapFolderSearchBatchResult[]>('imap_search_folders_batch', { config, folders });
}

/**
 * Fetch multiple UID batches for one folder in a single IMAP connection.
 */
export async function imapFetchMessagesBatched(
  config: ImapConfig,
  folder: string,
  uids: number[],
  options?: { headersOnly?: boolean; batchSize?: number },
): Promise<ImapFetchResult> {
  const batchSize = options?.batchSize ?? 50;
  const uidBatches: number[][] = [];
  for (let i = 0; i < uids.length; i += batchSize) {
    uidBatches.push(uids.slice(i, i + batchSize));
  }
  return invoke<ImapFetchResult>('imap_fetch_messages_batched', {
    config,
    folder,
    uidBatches,
    headersOnly: options?.headersOnly ?? false,
  });
}

/**
 * Run delta sync network ops with minimal IMAP connections:
 * one session for searches + delta checks, one per folder for batched fetches.
 */
export async function imapRunDeltaSync(
  config: ImapConfig,
  request: ImapDeltaSyncRequest,
): Promise<ImapDeltaSyncResult> {
  return invoke<ImapDeltaSyncResult>('imap_run_delta_sync', { config, request });
}

/**
 * Sync a folder in a single IMAP connection: SELECT → UID SEARCH → batched UID FETCH.
 * When `sinceDate` is provided (format `DD-Mon-YYYY`), uses `UID SEARCH SINCE <date>`
 * to only fetch messages from that date onward, avoiding timeouts on large folders.
 */
export async function imapSyncFolder(
  config: ImapConfig,
  folder: string,
  batchSize: number,
  sinceDate?: string | null,
): Promise<ImapFolderSyncResult> {
  return invoke<ImapFolderSyncResult>('imap_sync_folder', { config, folder, batchSize, sinceDate: sinceDate ?? null });
}

/**
 * Single-connection folder sync with per-batch Tauri events.
 * Messages arrive via `onBatch`; the invoke result is a lightweight summary.
 */
export async function imapSyncFolderStreaming(
  config: ImapConfig,
  accountId: string,
  folder: string,
  batchSize: number,
  sinceDate: string | null | undefined,
  onBatch: (event: ImapSyncBatchEvent) => void | Promise<void>,
): Promise<ImapFolderSyncSummary> {
  const { listen } = await import('@tauri-apps/api/event');
  let batchQueue: Promise<void> = Promise.resolve();

  const unlisten = await listen<ImapSyncBatchEventPayload>('imap-sync-folder-batch', (event) => {
    const payload = event.payload;
    if (payload.accountId === accountId && payload.folder === folder) {
      batchQueue = batchQueue.then(() => Promise.resolve(onBatch(payload)));
    }
  });

  try {
    const summary = await invoke<ImapFolderSyncSummary>('imap_sync_folder_streaming', {
      config,
      accountId,
      folder,
      batchSize,
      sinceDate: sinceDate ?? null,
    });
    await batchQueue;
    return summary;
  } finally {
    unlisten();
  }
}

/**
 * Search a folder for UIDs without fetching message bodies.
 * Returns UIDs and folder status — lightweight alternative to `imapSyncFolder`
 * for callers that fetch messages in smaller IPC-friendly chunks.
 */
export async function imapSearchFolder(
  config: ImapConfig,
  folder: string,
  sinceDate?: string | null,
): Promise<ImapFolderSearchResult> {
  return invoke<ImapFolderSearchResult>('imap_search_folder', { config, folder, sinceDate: sinceDate ?? null });
}

/**
 * Raw IMAP diagnostic: bypasses async-imap to show raw server responses.
 */
export async function imapRawFetchDiagnostic(
  config: ImapConfig,
  folder: string,
  uidRange: string,
): Promise<string> {
  return invoke<string>('imap_raw_fetch_diagnostic', { config, folder, uidRange });
}

// ---------- SMTP commands ----------

/**
 * Send a pre-built RFC 2822 email via SMTP.
 * @param rawEmail - The full email message encoded as base64url.
 */
export async function smtpSendEmail(
  config: SmtpConfig,
  rawEmail: string
): Promise<SmtpSendResult> {
  return invoke<SmtpSendResult>('smtp_send_email', { config, rawEmail });
}

/**
 * Test SMTP connectivity by connecting and authenticating.
 */
export async function smtpTestConnection(config: SmtpConfig): Promise<SmtpSendResult> {
  console.info('[MailPilot] smtpTestConnection', {
    host: config.host,
    port: config.port,
    security: config.security,
    auth_method: config.auth_method,
    username: config.username,
    credential_len: config.password.length,
    accept_invalid_certs: config.accept_invalid_certs ?? false,
  });
  try {
    const result = await invoke<SmtpSendResult>('smtp_test_connection', { config });
    console.info('[MailPilot] smtpTestConnection result:', result);
    return result;
  } catch (err) {
    console.error('[MailPilot] smtpTestConnection failed:', err);
    throw err;
  }
}
