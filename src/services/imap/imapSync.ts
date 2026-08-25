import type { ImapConfig, ImapMessage, DeltaCheckRequest, DeltaCheckResult } from "./tauriCommands";
import {
  imapListFolders,
  imapGetFolderStatus,
  imapFetchMessages,
  imapFetchNewUids,
  imapSearchFolder,
  imapDeltaCheck,
  imapSyncFolderStreaming,
} from "./tauriCommands";
import { buildImapConfig } from "./imapConfigBuilder";
import {
  mapFolderToLabel,
  getLabelsForMessage,
  syncFoldersToLabels,
} from "./folderMapper";
import { getFilteredSyncFolders, getAccountImapSyncConfig } from "../db/imapSyncPrefs";
import { getSetting } from "../db/settings";
import type { ParsedMessage, ParsedAttachment } from "../gmail/messageParser";
import type { SyncResult } from "../email/types";
import { upsertMessage, updateMessageThreadIds, getMessageCountForAccount, getMessagesForImapThreadRepair, getMessageThreadIdMap } from "../db/messages";
import { upsertThread, setThreadLabels, deleteThreadsBatch, getThreadCountForAccount } from "../db/threads";
import { upsertAttachment } from "../db/attachments";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { withTransaction } from "../db/connection";
import {
  enterBulkWriteMode,
  exitBulkWriteMode,
  bulkInsertPlaceholderMessages,
  type BulkPlaceholderMessage,
} from "../db/bulkWrite";
import {
  upsertFolderSyncState,
  getAllFolderSyncStates,
} from "../db/folderSyncState";
import {
  buildThreads,
  type ThreadableMessage,
  type ThreadGroup,
} from "../threading/threadBuilder";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { getLabelsForAccount } from "../db/labels";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
/** Number of thread groups to process per transaction in Phase 4. */
const THREAD_BATCH_SIZE = 50;
// ---------------------------------------------------------------------------
// Circuit breaker for connection storms
// ---------------------------------------------------------------------------

/** After this many consecutive connection failures, add a cooldown delay. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Delay (ms) to wait after hitting the circuit breaker threshold. */
const CIRCUIT_BREAKER_DELAY_MS = 15_000;
/** After this many consecutive failures, skip remaining folders entirely. */
const CIRCUIT_BREAKER_MAX_FAILURES = 5;
/** Delay (ms) between folder syncs during initial sync to avoid connection bursts. */
const INTER_FOLDER_DELAY_MS = 1_000;

export function isConnectionError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("tcp") ||
    msg.includes("tls") ||
    msg.includes("dns") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// IMAP SINCE date helpers
// ---------------------------------------------------------------------------

import {
  computeSinceDate,
  formatImapDate,
} from "./imapDateUtils";

// Re-export for tests and callers
export { computeSinceDate, formatImapDate };

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ImapSyncProgress {
  phase: "folders" | "messages" | "threading" | "storing_threads" | "done";
  current: number;
  total: number;
  folder?: string;
}

export type ImapSyncProgressCallback = (progress: ImapSyncProgress) => void;

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic Message-ID for messages that lack one.
 */
function syntheticMessageId(accountId: string, folder: string, uid: number): string {
  return `synthetic-${accountId}-${folder}-${uid}@mailpilot.local`;
}

/**
 * Convert an ImapMessage (from Tauri backend) to the ParsedMessage format
 * used throughout the app.
 */
export function imapMessageToParsedMessage(
  msg: ImapMessage,
  accountId: string,
  folderLabelId: string,
): { parsed: ParsedMessage; threadable: ThreadableMessage } {
  const messageId = `imap-${accountId}-${msg.folder}-${msg.uid}`;
  const rfc2822MessageId =
    msg.message_id ?? syntheticMessageId(accountId, msg.folder, msg.uid);

  const folderMapping = { labelId: folderLabelId, labelName: "", type: "" };
  const labelIds = getLabelsForMessage(
    folderMapping,
    msg.is_read,
    msg.is_starred,
    msg.is_draft,
  );

  const snippet = msg.snippet ?? (msg.body_text ? msg.body_text.slice(0, 200) : "");

  const attachments: ParsedAttachment[] = msg.attachments.map((att) => ({
    filename: att.filename,
    mimeType: att.mime_type,
    size: att.size,
    gmailAttachmentId: att.part_id, // reuse field for IMAP part ID
    contentId: att.content_id,
    isInline: att.is_inline,
  }));

  const parsed: ParsedMessage = {
    id: messageId,
    threadId: "", // will be assigned after threading
    fromAddress: msg.from_address,
    fromName: msg.from_name,
    toAddresses: msg.to_addresses,
    ccAddresses: msg.cc_addresses,
    bccAddresses: msg.bcc_addresses,
    replyTo: msg.reply_to,
    subject: msg.subject,
    snippet,
    date: msg.date * 1000,
    isRead: msg.is_read,
    isStarred: msg.is_starred,
    bodyHtml: msg.body_html,
    bodyText: msg.body_text,
    rawSize: msg.raw_size,
    internalDate: msg.date * 1000,
    labelIds,
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: msg.list_unsubscribe,
    listUnsubscribePost: msg.list_unsubscribe_post,
    authResults: msg.auth_results,
  };

  const threadable: ThreadableMessage = {
    id: messageId,
    messageId: rfc2822MessageId,
    inReplyTo: msg.in_reply_to,
    references: msg.references,
    subject: msg.subject,
    date: msg.date * 1000,
  };

  return { parsed, threadable };
}

// ---------------------------------------------------------------------------
// Thread storage
// ---------------------------------------------------------------------------

/**
 * Store threads and their messages into the local DB.
 */
async function storeThreadsAndMessages(
  accountId: string,
  threadGroups: ThreadGroup[],
  parsedByLocalId: Map<string, ParsedMessage>,
  imapMsgByLocalId: Map<string, ImapMessage>,
  labelsByRfcId?: Map<string, Set<string>>,
): Promise<ParsedMessage[]> {
  const storedMessages: ParsedMessage[] = [];

  // Pre-check pending ops OUTSIDE any transaction
  const skippedThreadIds = new Set<string>();
  for (const group of threadGroups) {
    const pendingOps = await getPendingOpsForResource(accountId, group.threadId);
    if (pendingOps.length > 0) {
      console.log(`[imapSync] Skipping thread ${group.threadId}: has ${pendingOps.length} pending local ops`);
      skippedThreadIds.add(group.threadId);
    }
  }

  // Process in batches within transactions to avoid long-held locks
  for (let i = 0; i < threadGroups.length; i += THREAD_BATCH_SIZE) {
    const batch = threadGroups.slice(i, i + THREAD_BATCH_SIZE);

    await withTransaction(async () => {
      for (const group of batch) {
        if (skippedThreadIds.has(group.threadId)) continue;

        const messages = group.messageIds
          .map((id) => parsedByLocalId.get(id))
          .filter((m): m is ParsedMessage => m !== undefined);

        if (messages.length === 0) continue;

        // Assign threadId to each message
        for (const msg of messages) {
          msg.threadId = group.threadId;
        }

        // Sort by date ascending
        messages.sort((a, b) => a.date - b.date);

        const firstMessage = messages[0]!;
        const lastMessage = messages[messages.length - 1]!;

        // Collect all label IDs across messages in this thread.
        // Also include labels from duplicate folder copies (same RFC Message-ID
        // in multiple folders) that the threading algorithm may have deduplicated.
        const allLabelIds = new Set<string>();
        for (const msg of messages) {
          for (const lid of msg.labelIds) {
            allLabelIds.add(lid);
          }
          // Merge labels from all folder copies of this message
          const imapMsg = imapMsgByLocalId.get(msg.id);
          const rfcId = imapMsg?.message_id;
          if (rfcId && labelsByRfcId) {
            const extraLabels = labelsByRfcId.get(rfcId);
            if (extraLabels) {
              for (const lid of extraLabels) {
                allLabelIds.add(lid);
              }
            }
          }
        }

        const isRead = messages.every((m) => m.isRead);
        const isStarred = messages.some((m) => m.isStarred);
        const hasAttachments = messages.some((m) => m.hasAttachments);

        await upsertThread({
          id: group.threadId,
          accountId,
          subject: firstMessage.subject,
          snippet: lastMessage.snippet,
          lastMessageAt: lastMessage.date,
          messageCount: messages.length,
          isRead,
          isStarred,
          isImportant: false,
          hasAttachments,
        });

        const labelArray = [...allLabelIds];
        await setThreadLabels(accountId, group.threadId, labelArray);

        // Store messages sequentially to avoid concurrent DB writes
        for (const parsed of messages) {
          const imapMsg = imapMsgByLocalId.get(parsed.id);

          await upsertMessage({
            id: parsed.id,
            accountId,
            threadId: parsed.threadId,
            fromAddress: parsed.fromAddress,
            fromName: parsed.fromName,
            toAddresses: parsed.toAddresses,
            ccAddresses: parsed.ccAddresses,
            bccAddresses: parsed.bccAddresses,
            replyTo: parsed.replyTo,
            subject: parsed.subject,
            snippet: parsed.snippet,
            date: parsed.date,
            isRead: parsed.isRead,
            isStarred: parsed.isStarred,
            bodyHtml: null,
            bodyText: null,
            rawSize: parsed.rawSize,
            internalDate: parsed.internalDate,
            listUnsubscribe: parsed.listUnsubscribe,
            listUnsubscribePost: parsed.listUnsubscribePost,
            authResults: parsed.authResults,
            messageIdHeader: imapMsg?.message_id ?? null,
            referencesHeader: imapMsg?.references ?? null,
            inReplyToHeader: imapMsg?.in_reply_to ?? null,
            imapUid: imapMsg?.uid ?? null,
            imapFolder: imapMsg?.folder ?? null,
          });

          for (const att of parsed.attachments) {
            await upsertAttachment({
              id: `${parsed.id}_${att.gmailAttachmentId}`,
              messageId: parsed.id,
              accountId,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              gmailAttachmentId: att.gmailAttachmentId,
              contentId: att.contentId,
              isInline: att.isInline,
            });
          }

          storedMessages.push(parsed);
        }
      }
    });
  }

  return storedMessages;
}

type ParsedChunkItem = {
  parsed: ParsedMessage;
  msg: ImapMessage;
  threadable: ThreadableMessage;
};

/**
 * Store placeholder threads/messages in a single bulk transaction (FTS triggers off).
 */
async function storePlaceholderMessages(
  accountId: string,
  items: ParsedChunkItem[],
): Promise<void> {
  const bulkItems: BulkPlaceholderMessage[] = items.map(({ parsed, msg }) => ({
    threadId: parsed.id,
    accountId,
    subject: parsed.subject,
    snippet: parsed.snippet,
    lastMessageAt: parsed.date,
    isRead: parsed.isRead,
    isStarred: parsed.isStarred,
    hasAttachments: parsed.hasAttachments,
    labelIds: parsed.labelIds,
    message: {
      id: parsed.id,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      replyTo: parsed.replyTo,
      date: parsed.date,
      bodyHtml: null,
      bodyText: null,
      rawSize: parsed.rawSize,
      internalDate: parsed.internalDate,
      listUnsubscribe: parsed.listUnsubscribe,
      listUnsubscribePost: parsed.listUnsubscribePost,
      authResults: parsed.authResults,
      messageIdHeader: msg.message_id ?? null,
      referencesHeader: msg.references ?? null,
      inReplyToHeader: msg.in_reply_to ?? null,
      imapUid: msg.uid ?? null,
      imapFolder: msg.folder ?? null,
    },
    attachments: parsed.attachments.map((att) => ({
      id: `${parsed.id}_${att.gmailAttachmentId}`,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      gmailAttachmentId: att.gmailAttachmentId,
      contentId: att.contentId,
      isInline: att.isInline,
    })),
  }));
  await bulkInsertPlaceholderMessages(bulkItems);
}

/** Messages per SQLite transaction when flushing a synced folder. */
const FOLDER_DB_CHUNK = 150;

/**
 * Flush parsed folder messages to SQLite in large chunks (one transaction per chunk).
 * Defers all DB writes until IMAP fetch completes to avoid lock ping-pong mid-stream.
 */
async function flushFolderMessagesToDb(
  accountId: string,
  items: ParsedChunkItem[],
  allMeta: Map<string, MessageMeta>,
  allThreadable: ThreadableMessage[],
  labelsByRfcId: Map<string, Set<string>>,
): Promise<number> {
  if (items.length === 0) return 0;

  let stored = 0;
  for (let i = 0; i < items.length; i += FOLDER_DB_CHUNK) {
    const chunk = items.slice(i, i + FOLDER_DB_CHUNK);
    await storePlaceholderMessages(accountId, chunk);
    for (const { parsed, threadable } of chunk) {
      accumulateMessageMeta(parsed, threadable, allMeta, allThreadable, labelsByRfcId);
    }
    stored += chunk.length;
  }
  return stored;
}

function accumulateMessageMeta(
  parsed: ParsedMessage,
  threadable: ThreadableMessage,
  allMeta: Map<string, MessageMeta>,
  allThreadable: ThreadableMessage[],
  labelsByRfcId: Map<string, Set<string>>,
): void {
  const meta: MessageMeta = {
    id: parsed.id,
    rfcMessageId: threadable.messageId,
    labelIds: parsed.labelIds,
    isRead: parsed.isRead,
    isStarred: parsed.isStarred,
    hasAttachments: parsed.hasAttachments,
    subject: parsed.subject,
    snippet: parsed.snippet,
    date: parsed.date,
  };
  allMeta.set(parsed.id, meta);
  allThreadable.push(threadable);

  let labels = labelsByRfcId.get(threadable.messageId);
  if (!labels) {
    labels = new Set();
    labelsByRfcId.set(threadable.messageId, labels);
  }
  for (const lid of parsed.labelIds) {
    labels.add(lid);
  }
}

interface MessageMeta {
  id: string;
  rfcMessageId: string;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  subject: string | null;
  snippet: string;
  date: number;
}
// ---------------------------------------------------------------------------
// Phase 4 helpers — persist thread groups + safe orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Create/update thread records, assign labels, and re-point messages to real thread IDs.
 * Returns message IDs whose thread_id was successfully updated away from the placeholder.
 */
async function persistThreadGroups(
  accountId: string,
  threadGroups: ThreadGroup[],
  allMeta: Map<string, MessageMeta>,
  labelsByRfcId: Map<string, Set<string>>,
  onProgress?: (current: number, total: number) => void,
): Promise<Set<string>> {
  const reassignedMessageIds = new Set<string>();

  for (let batchStart = 0; batchStart < threadGroups.length; batchStart += THREAD_BATCH_SIZE) {
    const batch = threadGroups.slice(batchStart, batchStart + THREAD_BATCH_SIZE);
    const batchReassigned: string[] = [];

    const skippedThreadIds = new Set<string>();
    for (const group of batch) {
      const pendingOps = await getPendingOpsForResource(accountId, group.threadId);
      if (pendingOps.length > 0) {
        console.log(`[imapSync] Skipping thread ${group.threadId}: has ${pendingOps.length} pending local ops`);
        skippedThreadIds.add(group.threadId);
      }
    }

    await withTransaction(async (db) => {
      for (const group of batch) {
        if (skippedThreadIds.has(group.threadId)) continue;

        const messages = group.messageIds
          .map((id) => allMeta.get(id))
          .filter((m): m is MessageMeta => m !== undefined);

        if (messages.length === 0) continue;

        messages.sort((a, b) => a.date - b.date);

        const messageIds = messages.map((m) => m.id);
        const threadIdMap = await getMessageThreadIdMap(accountId, messageIds, db);
        if (
          messageIds.length > 0 &&
          messageIds.every((id) => threadIdMap.get(id) === group.threadId)
        ) {
          batchReassigned.push(...messageIds);
          continue;
        }

        const firstMessage = messages[0]!;
        const lastMessage = messages[messages.length - 1]!;

        const allLabelIds = new Set<string>();
        for (const msg of messages) {
          for (const lid of msg.labelIds) {
            allLabelIds.add(lid);
          }
          const extraLabels = labelsByRfcId.get(msg.rfcMessageId);
          if (extraLabels) {
            for (const lid of extraLabels) {
              allLabelIds.add(lid);
            }
          }
        }

        const isRead = messages.every((m) => m.isRead);
        const isStarred = messages.some((m) => m.isStarred);
        const hasAttachments = messages.some((m) => m.hasAttachments);

        await upsertThread({
          id: group.threadId,
          accountId,
          subject: firstMessage.subject,
          snippet: lastMessage.snippet,
          lastMessageAt: lastMessage.date,
          messageCount: messages.length,
          isRead,
          isStarred,
          isImportant: false,
          hasAttachments,
        }, db);

        await setThreadLabels(accountId, group.threadId, [...allLabelIds], db);

        await updateMessageThreadIds(accountId, messageIds, group.threadId, db);
        batchReassigned.push(...messageIds);
      }
    });

    for (const id of batchReassigned) {
      reassignedMessageIds.add(id);
    }

    onProgress?.(
      Math.min(batchStart + THREAD_BATCH_SIZE, threadGroups.length),
      threadGroups.length,
    );
  }

  return reassignedMessageIds;
}

/** Delete placeholder threads only after messages were reassigned to real thread IDs. */
async function cleanupOrphanPlaceholderThreads(
  accountId: string,
  allMeta: Map<string, MessageMeta>,
  threadGroups: ThreadGroup[],
  reassignedMessageIds: Set<string>,
): Promise<void> {
  const finalThreadIds = new Set(threadGroups.map((g) => g.threadId));
  const orphanIds = [...allMeta.keys()].filter(
    (msgId) => reassignedMessageIds.has(msgId) && !finalThreadIds.has(msgId),
  );
  if (orphanIds.length > 0) {
    await deleteThreadsBatch(accountId, orphanIds);
    console.log(`[imapSync] Cleaned up ${orphanIds.length} orphaned placeholder threads`);
  }
}

/**
 * Rebuild threads and labels from messages already in the DB.
 * Used when sync fetched messages but thread/label linkage is missing or broken.
 */
export async function repairImapThreadsFromDb(accountId: string): Promise<void> {
  const dbMessages = await getMessagesForImapThreadRepair(accountId);
  if (dbMessages.length === 0) return;

  console.log(`[imapSync] Repairing thread state for ${dbMessages.length} messages`);

  const accountLabels = await getLabelsForAccount(accountId);
  const folderToLabel = new Map<string, string>();
  for (const label of accountLabels) {
    if (label.imap_folder_path) {
      folderToLabel.set(label.imap_folder_path, label.id);
    }
  }

  const allMeta = new Map<string, MessageMeta>();
  const allThreadable: ThreadableMessage[] = [];
  const labelsByRfcId = new Map<string, Set<string>>();

  for (const msg of dbMessages) {
    const rfcId = msg.message_id_header ?? `synthetic-repair-${msg.id}`;
    const folderLabel = msg.imap_folder ? folderToLabel.get(msg.imap_folder) : undefined;
    const folderMapping = {
      labelId: folderLabel ?? `folder-${msg.imap_folder ?? "unknown"}`,
      labelName: "",
      type: "",
    };
    const labelIds = getLabelsForMessage(
      folderMapping,
      msg.is_read === 1,
      msg.is_starred === 1,
      false,
    );

    const threadable: ThreadableMessage = {
      id: msg.id,
      messageId: rfcId,
      inReplyTo: msg.in_reply_to_header,
      references: msg.references_header,
      subject: msg.subject,
      date: msg.date,
    };

    const meta: MessageMeta = {
      id: msg.id,
      rfcMessageId: rfcId,
      labelIds,
      isRead: msg.is_read === 1,
      isStarred: msg.is_starred === 1,
      hasAttachments: false,
      subject: msg.subject,
      snippet: msg.snippet ?? "",
      date: msg.date,
    };

    allMeta.set(msg.id, meta);
    allThreadable.push(threadable);

    let labels = labelsByRfcId.get(rfcId);
    if (!labels) {
      labels = new Set();
      labelsByRfcId.set(rfcId, labels);
    }
    for (const lid of labelIds) {
      labels.add(lid);
    }
  }

  const threadGroups = buildThreads(allThreadable);
  const reassigned = await persistThreadGroups(
    accountId,
    threadGroups,
    allMeta,
    labelsByRfcId,
  );
  await cleanupOrphanPlaceholderThreads(accountId, allMeta, threadGroups, reassigned);
  console.log(`[imapSync] Repair complete: ${threadGroups.length} threads`);
}

// ---------------------------------------------------------------------------
// Fetch messages from a folder in batches
// ---------------------------------------------------------------------------

/**
 * Fetch messages from a folder in batches of BATCH_SIZE.
 */
async function fetchMessagesInBatches(
  config: ImapConfig,
  folder: string,
  uids: number[],
  onBatch?: (fetched: number, total: number) => void,
): Promise<{ messages: ImapMessage[]; lastUid: number; uidvalidity: number }> {
  const allMessages: ImapMessage[] = [];
  let lastUid = 0;
  let uidvalidity = 0;

  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const result = await imapFetchMessages(config, folder, batch);

    allMessages.push(...result.messages);
    uidvalidity = result.folder_status.uidvalidity;

    for (const msg of result.messages) {
      if (msg.uid > lastUid) lastUid = msg.uid;
    }

    onBatch?.(Math.min(i + BATCH_SIZE, uids.length), uids.length);
  }

  return { messages: allMessages, lastUid, uidvalidity };
}

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

/**
 * Perform initial sync for an IMAP account.
 * Fetches messages from all folders for the past N days.
 */
export async function imapInitialSync(
  accountId: string,
  _daysBack = 365,
  onProgress?: ImapSyncProgressCallback,
): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  const syncPeriodStr = await getSetting("sync_period_days");
  const globalDaysBack = parseInt(syncPeriodStr ?? "365", 10) || 365;
  const syncConfig = await getAccountImapSyncConfig(account, globalDaysBack);

  // Phase 1: List and sync folders
  onProgress?.({ phase: "folders", current: 0, total: 1 });
  const allFolders = await imapListFolders(config);
  const syncableFolders = await getFilteredSyncFolders(accountId, allFolders);

  await enterBulkWriteMode();
  try {
  await syncFoldersToLabels(accountId, syncableFolders);
  console.log(
    `[imapSync] Initial sync for account ${accountId}: ` +
      `mode=${syncConfig.mode}, daysBack=${syncConfig.daysBack}, ` +
      `sinceDate=${syncConfig.sinceDate ?? "ALL"}, ` +
      `${syncableFolders.length}/${allFolders.length} folders enabled`,
  );
  console.log(
    `[imapSync] Folders to sync: ${syncableFolders.map((f) => f.path).join(", ") || "(none)"}`,
  );
  onProgress?.({ phase: "folders", current: 1, total: 1 });

  // Phase 2: Streaming fetch & store — single bulk-write session (FTS triggers off).

  const allThreadable: ThreadableMessage[] = [];
  const allMeta = new Map<string, MessageMeta>();

  // Track RFC Message-ID → all label IDs from every folder copy.
  const labelsByRfcId = new Map<string, Set<string>>();

  // Progress total uses filtered UID counts from IMAP SEARCH (not folder.exists).
  let completedFoldersUidTotal = 0;

  let fetchedTotal = 0;
  let totalMessagesFound = 0;
  let storedCount = 0;
  let consecutiveFailures = 0;
  const folderErrors: string[] = [];

  // Date filter config (skip when syncing all mail)
  const cutoffDate =
    syncConfig.mode === "all"
      ? 0
      : Math.floor(Date.now() / 1000) - syncConfig.daysBack * 86400;
  const nowSeconds = Math.floor(Date.now() / 1000);

  for (let folderIdx = 0; folderIdx < syncableFolders.length; folderIdx++) {
    const folder = syncableFolders[folderIdx]!;
    if (folder.exists === 0) continue;

    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive connection failures, ` +
        `skipping remaining ${syncableFolders.length - folderIdx} folders`,
      );
      break;
    }

    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive failures, ` +
        `waiting ${CIRCUIT_BREAKER_DELAY_MS / 1000}s before next folder`,
      );
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    if (folderIdx > 0) {
      await delay(INTER_FOLDER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);

    try {
      let dateFallbackCount = 0;
      let folderFetchedCount = 0;
      let folderStoredCount = 0;
      let lastUid = 0;
      let uidvalidity = 0;
      let totalUidsInFolder = 0;
      const folderPending: ParsedChunkItem[] = [];

      const summary = await imapSyncFolderStreaming(
        config,
        accountId,
        folder.raw_path,
        BATCH_SIZE,
        syncConfig.sinceDate ?? null,
        async (batch) => {
          uidvalidity = batch.folderStatus.uidvalidity;
          totalUidsInFolder = batch.totalUids;

          for (const msg of batch.messages) {
            if (msg.uid > lastUid) lastUid = msg.uid;
            folderFetchedCount++;

            if (msg.date === 0) {
              dateFallbackCount++;
              msg.date = nowSeconds;
            }
            if (msg.date < cutoffDate) continue;

            const { parsed, threadable } = imapMessageToParsedMessage(
              msg,
              accountId,
              folderMapping.labelId,
            );
            parsed.threadId = parsed.id;
            folderPending.push({ parsed, msg, threadable });
          }

          fetchedTotal += batch.messages.length;
          const progressTotal = completedFoldersUidTotal + totalUidsInFolder;
          onProgress?.({
            phase: "messages",
            current: fetchedTotal,
            total: Math.max(progressTotal, fetchedTotal, 1),
            folder: folder.path,
          });
        },
      );

      folderStoredCount = await flushFolderMessagesToDb(
        accountId,
        folderPending,
        allMeta,
        allThreadable,
        labelsByRfcId,
      );
      storedCount += folderStoredCount;

      consecutiveFailures = 0;
      completedFoldersUidTotal += summary.uids.length;
      if (summary.uids.length === 0) continue;

      totalMessagesFound += folderFetchedCount;

      if (dateFallbackCount > 0) {
        console.warn(
          `[imapSync] Folder ${folder.path}: ${dateFallbackCount}/${folderFetchedCount} messages had unparseable dates, using current time as fallback`,
        );
      }

      console.log(
        `[imapSync] Folder ${folder.path}: ${totalUidsInFolder || summary.uids.length} UIDs, ${folderFetchedCount} fetched, ${folderStoredCount} after date filter (single connection)`,
      );

      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity: uidvalidity || summary.folder_status.uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`[imapSync] Failed to sync folder ${folder.path}:`, err);
      folderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
    }
  }

  // If no messages were stored and every folder failed, propagate the error
  if (storedCount === 0 && folderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${folderErrors[0]}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Thread messages (lightweight — only IDs + headers in memory)
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "threading", current: 0, total: allThreadable.length });
  const threadGroups = buildThreads(allThreadable);
  console.log(
    `[imapSync] Threading: ${allThreadable.length} messages → ${threadGroups.length} thread groups`,
  );

  // ---------------------------------------------------------------------------
  // Phase 4: Create thread records + batch-update message thread IDs
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "storing_threads", current: 0, total: threadGroups.length });

  const reassignedMessageIds = await persistThreadGroups(
    accountId,
    threadGroups,
    allMeta,
    labelsByRfcId,
    (current, total) => onProgress?.({ phase: "storing_threads", current, total }),
  );

  // ---------------------------------------------------------------------------
  // Phase 5: Clean up orphaned placeholder threads
  // ---------------------------------------------------------------------------
  await cleanupOrphanPlaceholderThreads(
    accountId,
    allMeta,
    threadGroups,
    reassignedMessageIds,
  );

  console.log(
    `[imapSync] Stored ${storedCount} messages in ${threadGroups.length} threads (found ${totalMessagesFound} on server)`,
  );

  // Repair broken state: messages in DB but no threads (e.g. interrupted prior sync).
  const threadCount = await getThreadCountForAccount(accountId);
  const messageCount = await getMessageCountForAccount(accountId);
  if (messageCount > 0 && threadCount === 0) {
    console.warn(`[imapSync] ${messageCount} messages but 0 threads — running repair`);
    await repairImapThreadsFromDb(accountId);
  }

  // Only mark sync as complete if messages were stored OR no messages exist on server.
  if (storedCount > 0 || totalMessagesFound === 0) {
    await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);
  } else {
    console.warn(
      `[imapSync] Found ${totalMessagesFound} messages on server but stored 0 — NOT marking sync as complete so it will be retried`,
    );
  }

  onProgress?.({
    phase: "done",
    current: storedCount,
    total: storedCount,
  });

  return { messages: [] };
  } finally {
    await exitBulkWriteMode();
  }
}

// ---------------------------------------------------------------------------
// Delta sync
// ---------------------------------------------------------------------------

/**
 * Perform delta sync for an IMAP account.
 * Fetches only new messages since the last sync using stored UID state.
 */
export async function imapDeltaSync(accountId: string, daysBack = 365): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  const syncPeriodStr = await getSetting("sync_period_days");
  const globalDaysBack = parseInt(syncPeriodStr ?? "365", 10) || 365;
  const syncConfig = await getAccountImapSyncConfig(account, globalDaysBack);

  // Get all folders we've synced before
  const syncStates = await getAllFolderSyncStates(accountId);

  // Also check for any new folders
  const allFolders = await imapListFolders(config);
  const syncableFolders = await getFilteredSyncFolders(accountId, allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);

  const syncStateMap = new Map(syncStates.map((s) => [s.folder_path, s]));

  const allParsed = new Map<string, ParsedMessage>();
  const allThreadable: ThreadableMessage[] = [];
  const allImapMsgs = new Map<string, ImapMessage>();

  // Separate folders into new (no saved state) vs existing (have saved state)
  const newFolders = syncableFolders.filter((f) => !syncStateMap.has(f.raw_path));
  const existingFolders = syncableFolders.filter((f) => syncStateMap.has(f.raw_path));

  // Handle new folders: search for UIDs then fetch in chunks
  let consecutiveFailures = 0;
  const deltaFolderErrors: string[] = [];
  for (const folder of newFolders) {
    // Circuit breaker: skip remaining new folders after too many failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Delta sync circuit breaker: ${consecutiveFailures} consecutive failures, skipping remaining new folders`,
      );
      break;
    }
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);
    try {
      const searchResult = await imapSearchFolder(
        config,
        folder.raw_path,
        syncConfig.sinceDate,
      );
      consecutiveFailures = 0;

      if (searchResult.uids.length === 0) continue;

      const { messages, lastUid } = await fetchMessagesInBatches(
        config,
        folder.raw_path,
        searchResult.uids,
      );

      for (const msg of messages) {
        const { parsed, threadable } = imapMessageToParsedMessage(
          msg,
          accountId,
          folderMapping.labelId,
        );
        allParsed.set(parsed.id, parsed);
        allThreadable.push(threadable);
        allImapMsgs.set(parsed.id, msg);
      }

      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity: searchResult.folder_status.uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`Delta sync failed for new folder ${folder.path}:`, err);
      deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
    }
  }

  // Batch-check existing folders in a single IMAP connection.
  // Falls back to per-folder checks if the batch command fails.
  if (existingFolders.length > 0) {
    const deltaRequests: DeltaCheckRequest[] = existingFolders.map((folder) => {
      const savedState = syncStateMap.get(folder.raw_path)!;
      return {
        folder: folder.raw_path,
        last_uid: savedState.last_uid,
        uidvalidity: savedState.uidvalidity ?? 0,
      };
    });

    let deltaResultMap: Map<string, DeltaCheckResult>;
    try {
      const deltaResults = await imapDeltaCheck(config, deltaRequests);
      deltaResultMap = new Map(deltaResults.map((r) => [r.folder, r]));
      console.log(`[imapSync] Batch delta check: ${deltaResults.length}/${existingFolders.length} folders checked`);
    } catch (err) {
      // Batch check failed — fall back to per-folder checks
      console.warn(`[imapSync] Batch delta check failed, falling back to per-folder:`, err);
      deltaResultMap = new Map();
      for (const folder of existingFolders) {
        const savedState = syncStateMap.get(folder.raw_path)!;
        try {
          const currentStatus = await imapGetFolderStatus(config, folder.raw_path);
          const uidvalidityChanged =
            savedState.uidvalidity !== null &&
            currentStatus.uidvalidity !== savedState.uidvalidity;

          if (uidvalidityChanged) {
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: [],
              uidvalidity_changed: true,
            });
          } else {
            const newUids = await imapFetchNewUids(config, folder.raw_path, savedState.last_uid);
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: newUids,
              uidvalidity_changed: false,
            });
          }
        } catch (folderErr) {
          console.error(`[imapSync] Per-folder check failed for ${folder.path}:`, folderErr);
        }
      }
    }

    for (const folder of existingFolders) {
      const folderMapping = mapFolderToLabel(folder);
      const savedState = syncStateMap.get(folder.raw_path)!;
      const deltaResult = deltaResultMap.get(folder.raw_path);

      if (!deltaResult) continue;

      try {
        if (deltaResult.uidvalidity_changed) {
          // UIDVALIDITY changed — full resync of this folder
          console.warn(
            `UIDVALIDITY changed for folder ${folder.path} ` +
              `(was ${savedState.uidvalidity}, now ${deltaResult.uidvalidity}). ` +
              `Doing full resync of this folder.`,
          );
          const sinceDate = computeSinceDate(daysBack);
          const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
          if (searchResult.uids.length === 0) continue;

          const { messages, lastUid } = await fetchMessagesInBatches(
            config,
            folder.raw_path,
            searchResult.uids,
          );

          for (const msg of messages) {
            const { parsed, threadable } = imapMessageToParsedMessage(
              msg,
              accountId,
              folderMapping.labelId,
            );
            allParsed.set(parsed.id, parsed);
            allThreadable.push(threadable);
            allImapMsgs.set(parsed.id, msg);
          }

          await upsertFolderSyncState({
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity: searchResult.folder_status.uidvalidity,
            last_uid: lastUid,
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
          });
          continue;
        }

        // Normal delta: fetch the new UIDs returned by delta check
        if (deltaResult.new_uids.length === 0) continue;

        const { messages, lastUid, uidvalidity } = await fetchMessagesInBatches(
          config,
          folder.raw_path,
          deltaResult.new_uids,
        );

        for (const msg of messages) {
          const { parsed, threadable } = imapMessageToParsedMessage(
            msg,
            accountId,
            folderMapping.labelId,
          );
          allParsed.set(parsed.id, parsed);
          allThreadable.push(threadable);
          allImapMsgs.set(parsed.id, msg);
        }

        await upsertFolderSyncState({
          account_id: accountId,
          folder_path: folder.raw_path,
          uidvalidity,
          last_uid: Math.max(savedState.last_uid, lastUid),
          modseq: null,
          last_sync_at: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
        console.error(`Delta sync failed for folder ${folder.path}:`, err);
        deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      }
    }
  }

  // If no new messages found and every folder errored, propagate the error
  if (allThreadable.length === 0 && deltaFolderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${deltaFolderErrors[0]}`);
  }

  if (allThreadable.length === 0) {
    return { messages: [] };
  }

  // Build RFC Message-ID → labels map for cross-folder label merging
  const labelsByRfcId = new Map<string, Set<string>>();
  for (const threadable of allThreadable) {
    const parsed = allParsed.get(threadable.id);
    if (!parsed) continue;
    let labels = labelsByRfcId.get(threadable.messageId);
    if (!labels) {
      labels = new Set();
      labelsByRfcId.set(threadable.messageId, labels);
    }
    for (const lid of parsed.labelIds) {
      labels.add(lid);
    }
  }

  // Thread the new messages
  const threadGroups = buildThreads(allThreadable);

  // Store in DB
  const storedMessages = await storeThreadsAndMessages(
    accountId,
    threadGroups,
    allParsed,
    allImapMsgs,
    labelsByRfcId,
  );

  // Update sync state timestamp
  await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);

  return { messages: storedMessages };
}
