import type { ImapMessage } from "./tauriCommands";
import {
  imapListFolders,
  imapRunDeltaSync,
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
            bodyHtml: parsed.bodyHtml,
            bodyText: parsed.bodyText,
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
      bodyHtml: parsed.bodyHtml,
      bodyText: parsed.bodyText,
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
 * Uses batched IMAP connections (P1/P2) and header-only fetch for new UIDs (P3).
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

  const syncStates = await getAllFolderSyncStates(accountId);
  const allFolders = await imapListFolders(config);
  const syncableFolders = await getFilteredSyncFolders(accountId, allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);

  const syncStateMap = new Map(syncStates.map((s) => [s.folder_path, s]));
  const folderByRawPath = new Map(syncableFolders.map((f) => [f.raw_path, f]));

  const newFolders = syncableFolders.filter((f) => !syncStateMap.has(f.raw_path));
  const existingFolders = syncableFolders.filter((f) => syncStateMap.has(f.raw_path));

  const allParsed = new Map<string, ParsedMessage>();
  const allThreadable: ThreadableMessage[] = [];
  const allImapMsgs = new Map<string, ImapMessage>();

  let syncNetworkResult;
  try {
    syncNetworkResult = await imapRunDeltaSync(config, {
      new_folder_searches: newFolders.map((f) => ({
        folder: f.raw_path,
        since_date: syncConfig.sinceDate ?? null,
      })),
      delta_checks: existingFolders.map((f) => {
        const savedState = syncStateMap.get(f.raw_path)!;
        return {
          folder: f.raw_path,
          last_uid: savedState.last_uid,
          uidvalidity: savedState.uidvalidity ?? 0,
        };
      }),
      fetches: [],
      headers_only: true,
      resync_since_date: computeSinceDate(daysBack),
    });
    console.log(
      `[imapSync] Delta sync network: ${syncNetworkResult.search_results.length} searches, ` +
        `${syncNetworkResult.delta_results.length} delta checks, ` +
        `${syncNetworkResult.fetch_results.length} fetches`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
    throw new Error(`Delta sync failed: ${errMsg}`);
  }

  const deltaFolderErrors: string[] = [];
  const foldersWithFetches = new Set(syncNetworkResult.fetch_results.map((r) => r.folder));

  for (const fetch of syncNetworkResult.fetch_results) {
    const folder = folderByRawPath.get(fetch.folder);
    if (!folder) continue;

    const folderMapping = mapFolderToLabel(folder);
    try {
      for (const msg of fetch.messages) {
        const { parsed, threadable } = imapMessageToParsedMessage(
          msg,
          accountId,
          folderMapping.labelId,
        );
        allParsed.set(parsed.id, parsed);
        allThreadable.push(threadable);
        allImapMsgs.set(parsed.id, msg);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
    }
  }

  // Folders that were searched but fetch failed
  for (const search of syncNetworkResult.search_results) {
    if (search.uids.length > 0 && !foldersWithFetches.has(search.folder)) {
      const folder = folderByRawPath.get(search.folder);
      deltaFolderErrors.push(`${folder?.path ?? search.folder}: fetch failed`);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  // New folders: sync state from search + fetch
  for (const search of syncNetworkResult.search_results) {
    const folder = folderByRawPath.get(search.folder);
    if (!folder || syncStateMap.has(search.folder)) continue;
    if (search.uids.length === 0) {
      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: search.folder,
        uidvalidity: search.folder_status.uidvalidity,
        last_uid: 0,
        modseq: null,
        last_sync_at: now,
      });
      continue;
    }

    const fetch = syncNetworkResult.fetch_results.find((r) => r.folder === search.folder);
    let lastUid = 0;
    if (fetch) {
      for (const msg of fetch.messages) {
        if (msg.uid > lastUid) lastUid = msg.uid;
      }
    }
    for (const uid of search.uids) {
      if (uid > lastUid) lastUid = uid;
    }

    await upsertFolderSyncState({
      account_id: accountId,
      folder_path: search.folder,
      uidvalidity: search.folder_status.uidvalidity,
      last_uid: lastUid,
      modseq: null,
      last_sync_at: now,
    });
  }

  // Existing folders: sync state from delta + fetch
  for (const delta of syncNetworkResult.delta_results) {
    const savedState = syncStateMap.get(delta.folder);
    if (!savedState) continue;

    const fetch = syncNetworkResult.fetch_results.find((r) => r.folder === delta.folder);
    const resyncSearch = syncNetworkResult.search_results.find(
      (s) => s.folder === delta.folder && delta.uidvalidity_changed,
    );

    let lastUid = savedState.last_uid;
    let uidvalidity = delta.uidvalidity;

    if (fetch) {
      for (const msg of fetch.messages) {
        if (msg.uid > lastUid) lastUid = msg.uid;
      }
      uidvalidity = fetch.folder_status.uidvalidity;
    } else if (delta.new_uids.length > 0) {
      for (const uid of delta.new_uids) {
        if (uid > lastUid) lastUid = uid;
      }
    }

    if (resyncSearch) {
      uidvalidity = resyncSearch.folder_status.uidvalidity;
    }

    const hadActivity =
      delta.new_uids.length > 0 ||
      delta.uidvalidity_changed ||
      fetch !== undefined;

    if (hadActivity) {
      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: delta.folder,
        uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: now,
      });
    }
  }

  if (allThreadable.length === 0 && deltaFolderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${deltaFolderErrors[0]}`);
  }

  if (allThreadable.length === 0) {
    return { messages: [] };
  }

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

  const threadGroups = buildThreads(allThreadable);
  const storedMessages = await storeThreadsAndMessages(
    accountId,
    threadGroups,
    allParsed,
    allImapMsgs,
    labelsByRfcId,
  );

  await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);

  return { messages: storedMessages };
}
