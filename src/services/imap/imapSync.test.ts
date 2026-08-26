import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() calls are hoisted — must use inline factories, not external references
vi.mock("./tauriCommands", () => ({
  imapListFolders: vi.fn(),
  imapGetFolderStatus: vi.fn(),
  imapFetchMessages: vi.fn(),
  imapFetchNewUids: vi.fn(),
  imapSearchAllUids: vi.fn(),
  imapSearchFolder: vi.fn(),
  imapDeltaCheck: vi.fn(),
  imapSyncFolderStreaming: vi.fn(),
}));
vi.mock("./imapConfigBuilder", () => ({
  buildImapConfig: vi.fn(() => ({
    host: "imap.example.com",
    port: 993,
    security: "ssl",
    username: "user@example.com",
    password: "secret",
    auth_method: "password",
  })),
}));
vi.mock("./folderMapper", () => ({
  mapFolderToLabel: vi.fn((folder: { path: string }) => ({
    labelId: folder.path,
    labelName: folder.path,
    type: "user",
  })),
  getLabelsForMessage: vi.fn(
    (mapping: { labelId: string }, isRead: boolean, isStarred: boolean) => {
      const labels = [mapping.labelId];
      if (!isRead) labels.push("UNREAD");
      if (isStarred) labels.push("STARRED");
      return labels;
    },
  ),
  syncFoldersToLabels: vi.fn(),
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
  sortFoldersForSync: vi.fn((folders: unknown[]) => folders),
}));
vi.mock("../db/imapSyncPrefs", () => ({
  getFilteredSyncFolders: vi.fn(async (_accountId: string, folders: unknown[]) => folders),
  getAccountImapSyncConfig: vi.fn(async () => ({
    mode: "days",
    daysBack: 365,
    sinceDate: "1-Jan-2024",
  })),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn(async () => "365"),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
  updateMessageThreadIds: vi.fn(),
  getMessageCountForAccount: vi.fn(async () => 0),
  getMessagesForImapThreadRepair: vi.fn(async () => []),
  getMessageThreadIdMap: vi.fn(async () => new Map()),
}));
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  deleteThread: vi.fn(),
  deleteThreadsBatch: vi.fn(),
  getThreadCountForAccount: vi.fn(async () => 1),
}));
vi.mock("../db/labels", () => ({
  getLabelsForAccount: vi.fn(async () => []),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/connection", () => ({
  withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
}));
vi.mock("../db/folderSyncState", () => ({
  upsertFolderSyncState: vi.fn(),
  getAllFolderSyncStates: vi.fn(),
}));
vi.mock("../db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn(() => []),
}));
vi.mock("../db/bulkWrite", () => ({
  enterBulkWriteMode: vi.fn(),
  exitBulkWriteMode: vi.fn(),
  bulkInsertPlaceholderMessages: vi.fn(),
}));

import { imapMessageToParsedMessage, imapInitialSync, formatImapDate, computeSinceDate, isConnectionError } from "./imapSync";
import {
  createMockImapMessage,
  createMockImapAccount,
  createMockImapFolder,
  createMockImapFolderStatus,
  createMockImapFetchResult,
} from "@/test/mocks";
import { imapListFolders, imapSearchFolder, imapFetchMessages, imapSyncFolderStreaming } from "./tauriCommands";
import { getAccount } from "../db/accounts";
import { withTransaction } from "../db/connection";
import { upsertMessage, updateMessageThreadIds } from "../db/messages";
import { bulkInsertPlaceholderMessages } from "../db/bulkWrite";
import { upsertThread, deleteThreadsBatch } from "../db/threads";
import { upsertAttachment } from "../db/attachments";
import { getPendingOpsForResource } from "../db/pendingOperations";

describe("imapMessageToParsedMessage", () => {
  it("converts basic IMAP message to ParsedMessage format", () => {
    const msg = createMockImapMessage();
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
    expect(parsed.fromName).toBe("Sender Name");
    expect(parsed.toAddresses).toBe("recipient@example.com");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.date).toBe(1700000000000);
    expect(parsed.isRead).toBe(false);
    expect(parsed.isStarred).toBe(false);
    expect(parsed.bodyHtml).toBe("<p>Hello</p>");
    expect(parsed.bodyText).toBe("Hello");
    expect(parsed.snippet).toBe("Hello");
    expect(parsed.rawSize).toBe(1024);
    expect(parsed.hasAttachments).toBe(false);
    expect(parsed.attachments).toEqual([]);
  });

  it("generates stable message ID from account, folder, and uid", () => {
    const msg = createMockImapMessage({ uid: 99, folder: "Sent" });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-2", "SENT");
    expect(parsed.id).toBe("imap-acc-2-Sent-99");
  });

  it("includes UNREAD label for unread messages", () => {
    const msg = createMockImapMessage({ is_read: false });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("does not include UNREAD label for read messages", () => {
    const msg = createMockImapMessage({ is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).not.toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("includes STARRED label for flagged messages", () => {
    const msg = createMockImapMessage({ is_starred: true, is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("STARRED");
  });

  it("creates threadable message with correct fields", () => {
    const msg = createMockImapMessage({
      message_id: "<msg-abc@host.com>",
      in_reply_to: "<msg-parent@host.com>",
      references: "<msg-root@host.com> <msg-parent@host.com>",
    });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.id).toBe("imap-acc-1-INBOX-42");
    expect(threadable.messageId).toBe("<msg-abc@host.com>");
    expect(threadable.inReplyTo).toBe("<msg-parent@host.com>");
    expect(threadable.references).toBe("<msg-root@host.com> <msg-parent@host.com>");
    expect(threadable.subject).toBe("Test Subject");
    expect(threadable.date).toBe(1700000000000);
  });

  it("generates synthetic message ID when none present", () => {
    const msg = createMockImapMessage({ message_id: null });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.messageId).toBe("synthetic-acc-1-INBOX-42@mailpilot.local");
  });

  it("converts attachments correctly", () => {
    const msg = createMockImapMessage({
      attachments: [
        {
          part_id: "2",
          filename: "report.pdf",
          mime_type: "application/pdf",
          size: 50000,
          content_id: null,
          is_inline: false,
        },
        {
          part_id: "3",
          filename: "logo.png",
          mime_type: "image/png",
          size: 1024,
          content_id: "logo-cid",
          is_inline: true,
        },
      ],
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.hasAttachments).toBe(true);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toEqual({
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 50000,
      gmailAttachmentId: "2",
      contentId: null,
      isInline: false,
    });
    expect(parsed.attachments[1]).toEqual({
      filename: "logo.png",
      mimeType: "image/png",
      size: 1024,
      gmailAttachmentId: "3",
      contentId: "logo-cid",
      isInline: true,
    });
  });

  it("generates snippet from body_text when snippet is null", () => {
    const msg = createMockImapMessage({
      snippet: null,
      body_text: "This is a long email body that should be truncated to create a snippet for display purposes.",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.snippet).toBe("This is a long email body that should be truncated to create a snippet for display purposes.");
  });

  it("handles null body fields gracefully", () => {
    const msg = createMockImapMessage({
      body_html: null,
      body_text: null,
      snippet: null,
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.bodyText).toBeNull();
    expect(parsed.snippet).toBe("");
  });

  it("preserves list-unsubscribe headers", () => {
    const msg = createMockImapMessage({
      list_unsubscribe: "<mailto:unsub@list.com>",
      list_unsubscribe_post: "List-Unsubscribe=One-Click",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.listUnsubscribe).toBe("<mailto:unsub@list.com>");
    expect(parsed.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
  });

  it("preserves auth results", () => {
    const msg = createMockImapMessage({
      auth_results: '{"spf":"pass","dkim":"pass"}',
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.authResults).toBe('{"spf":"pass","dkim":"pass"}');
  });

  it("handles date=0 (unparseable Date header) without crashing", () => {
    const msg = createMockImapMessage({ date: 0 });
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    // date=0 * 1000 = 0, passed through — the caller (imapInitialSync) applies the fallback
    expect(parsed.date).toBe(0);
    expect(threadable.date).toBe(0);
    // Message should still be valid
    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
  });
});

describe("imapInitialSync", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSyncFolderStreaming = vi.mocked(imapSyncFolderStreaming);
  const mockWithTransaction = vi.mocked(withTransaction);
  const mockUpsertMessage = vi.mocked(upsertMessage);
  const mockUpdateMessageThreadIds = vi.mocked(updateMessageThreadIds);
  const mockUpsertThread = vi.mocked(upsertThread);
  const mockUpsertAttachment = vi.mocked(upsertAttachment);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    mockImapSyncFolderStreaming.mockReset();
    mockImapListFolders.mockReset();
    vi.useRealTimers();
  });

  /** Configure mocks to return a single folder with the given messages via streaming sync. */
  function setupFolderWithMessages(folder: string, messages: ReturnType<typeof createMockImapMessage>[]) {
    const mockFolder = createMockImapFolder({
      path: folder,
      raw_path: folder,
      exists: messages.length,
      special_use: folder === "INBOX" ? "\\Inbox" : null,
    });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    const folderStatus = createMockImapFolderStatus({ exists: messages.length });
    mockImapSyncFolderStreaming.mockImplementation(
      async (_config, accountId, folderPath, _batchSize, _sinceDate, onBatch) => {
        await onBatch({
          accountId,
          folder: folderPath,
          messages,
          fetchedCount: messages.length,
          totalUids: messages.length,
          batchIndex: 0,
          isLastBatch: true,
          folderStatus,
        });
        return {
          uids: messages.map((m) => m.uid),
          folder_status: folderStatus,
          messages_fetched: messages.length,
        };
      },
    );
    return mockFolder;
  }

  it("stores messages to DB after folder fetch completes", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "First", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "Second", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    expect(vi.mocked(bulkInsertPlaceholderMessages)).toHaveBeenCalledTimes(1);
    const bulkItems = vi.mocked(bulkInsertPlaceholderMessages).mock.calls[0]![0];
    expect(bulkItems).toHaveLength(2);
    expect(bulkItems[0]!.threadId).toBe(bulkItems[0]!.message.id);
    expect(bulkItems[1]!.threadId).toBe(bulkItems[1]!.message.id);
  });

  it("creates placeholder thread before each message to satisfy FK constraint", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "World", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    const bulkItems = vi.mocked(bulkInsertPlaceholderMessages).mock.calls[0]![0];
    expect(bulkItems).toHaveLength(2);
    expect(bulkItems[0]!.threadId).toBe(bulkItems[0]!.message.id);
    expect(bulkItems[1]!.threadId).toBe(bulkItems[1]!.message.id);
    expect(mockUpsertThread.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("updates thread IDs after threading phase", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1]);

    await imapInitialSync("acc-1");

    expect(mockUpsertThread).toHaveBeenCalledTimes(1);

    // Thread IDs should be batch-updated via updateMessageThreadIds
    expect(mockUpdateMessageThreadIds).toHaveBeenCalledTimes(1);
    const [accountId, messageIds, threadId] = mockUpdateMessageThreadIds.mock.calls[0]!;
    expect(accountId).toBe("acc-1");
    expect(messageIds).toHaveLength(1);
    expect(threadId).toBeTruthy();
  });

  it("returns empty messages array (bodies not accumulated)", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const result = await imapInitialSync("acc-1");

    // The streaming approach returns empty array — bodies are already in DB
    expect(result.messages).toEqual([]);
  });

  it("stores attachments immediately with the message", async () => {
    const msg = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      date: Math.floor(Date.now() / 1000),
      attachments: [
        {
          part_id: "2",
          filename: "doc.pdf",
          mime_type: "application/pdf",
          size: 5000,
          content_id: null,
          is_inline: false,
        },
      ],
    });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    const bulkItems = vi.mocked(bulkInsertPlaceholderMessages).mock.calls[0]![0];
    expect(bulkItems[0]!.attachments).toHaveLength(1);
    expect(bulkItems[0]!.attachments[0]).toMatchObject({
      filename: "doc.pdf",
      mimeType: "application/pdf",
    });
  });

  it("filters messages by date cutoff", async () => {
    const recentDate = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const oldDate = Math.floor(Date.now() / 1000) - 400 * 86400; // 400 days ago

    const recentMsg = createMockImapMessage({ uid: 1, message_id: "<recent@test>", date: recentDate });
    const oldMsg = createMockImapMessage({ uid: 2, message_id: "<old@test>", date: oldDate });

    setupFolderWithMessages("INBOX", [recentMsg, oldMsg]);

    await imapInitialSync("acc-1", 365);

    const bulkItems = vi.mocked(bulkInsertPlaceholderMessages).mock.calls[0]![0];
    expect(bulkItems).toHaveLength(1);
    expect(bulkItems[0]!.message.id).toContain("1");
  });

  it("handles empty folders gracefully", async () => {
    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 0 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    const result = await imapInitialSync("acc-1");

    expect(mockImapSyncFolderStreaming).not.toHaveBeenCalled();
    expect(vi.mocked(bulkInsertPlaceholderMessages)).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
  });

  it("uses filtered UID count for progress total, not folder.exists", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({
        path: "INBOX",
        raw_path: "INBOX",
        exists: 8777,
        special_use: "\\Inbox",
      }),
    ]);
    const folderStatus = createMockImapFolderStatus({ exists: 8777 });
    mockImapSyncFolderStreaming.mockImplementation(
      async (_config, accountId, folderPath, _batchSize, _sinceDate, onBatch) => {
        await onBatch({
          accountId,
          folder: folderPath,
          messages: [msg],
          fetchedCount: 1,
          totalUids: 1,
          batchIndex: 0,
          isLastBatch: true,
          folderStatus,
        });
        return { uids: [1], folder_status: folderStatus, messages_fetched: 1 };
      },
    );

    const progressCalls: Array<{ phase: string; total?: number }> = [];
    await imapInitialSync("acc-1", 365, (progress) => {
      progressCalls.push(progress);
    });

    const messageProgress = progressCalls.filter((p) => p.phase === "messages");
    expect(messageProgress.length).toBeGreaterThan(0);
    expect(messageProgress.every((p) => p.total !== 8777)).toBe(true);
    expect(messageProgress.some((p) => p.total === 1)).toBe(true);
  });

  it("reports progress through all phases", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const progressCalls: Array<{ phase: string }> = [];
    await imapInitialSync("acc-1", 365, (progress) => {
      progressCalls.push({ phase: progress.phase });
    });

    const phases = progressCalls.map((p) => p.phase);
    expect(phases).toContain("folders");
    expect(phases).toContain("messages");
    expect(phases).toContain("threading");
    expect(phases).toContain("storing_threads");
    expect(phases).toContain("done");
  });

  it("uses imapSyncFolderStreaming for single-connection sync per folder", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    expect(mockImapSyncFolderStreaming).toHaveBeenCalledTimes(1);
    expect(mockImapSyncFolderStreaming).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "acc-1",
      "INBOX",
      50,
      expect.stringMatching(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/),
      expect.any(Function),
    );
  });

  it("persists body content when available during sync (P0.2)", async () => {
    const msg = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      date: Math.floor(Date.now() / 1000),
      body_html: "<p>Hello</p>",
      body_text: "Hello",
    });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    expect(vi.mocked(bulkInsertPlaceholderMessages)).toHaveBeenCalled();
    const bulkItems = vi.mocked(bulkInsertPlaceholderMessages).mock.calls[0]?.[0] ?? [];
    expect(bulkItems[0]?.message.bodyHtml).toBe("<p>Hello</p>");
    expect(bulkItems[0]?.message.bodyText).toBe("Hello");
  });

  it("wraps thread storage in a transaction", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    // Phase 4 thread batch uses withTransaction
    expect(mockWithTransaction).toHaveBeenCalled();
  });

  it("continues on folder sync error without crashing entire sync", async () => {
    const msgs = Array.from({ length: 2 }, (_, i) =>
      createMockImapMessage({ uid: i + 1, message_id: `<m${i}@test>`, date: Math.floor(Date.now() / 1000) }),
    );
    setupFolderWithMessages("INBOX", msgs);

    mockImapSyncFolderStreaming.mockRejectedValueOnce(new Error("chunk fetch failed"));

    await expect(imapInitialSync("acc-1")).rejects.toThrow("All folders failed to sync");
  });

  it("circuit breaker skips remaining folders after 5 consecutive connection failures", async () => {
    const folders = Array.from({ length: 8 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSyncFolderStreaming.mockRejectedValue(new Error("TCP connect timed out (os error 60)"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
    expect(mockImapSyncFolderStreaming).toHaveBeenCalledTimes(5);
  });

  it("circuit breaker resets on successful folder sync", async () => {
    const folders = [
      createMockImapFolder({ path: "f1", raw_path: "f1", exists: 10 }),
      createMockImapFolder({ path: "f2", raw_path: "f2", exists: 10 }),
      createMockImapFolder({ path: "f3", raw_path: "f3", exists: 10 }),
      createMockImapFolder({ path: "f4", raw_path: "f4", exists: 10 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);

    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    const folderStatus = createMockImapFolderStatus({ exists: 1 });

    mockImapSyncFolderStreaming
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockImplementationOnce(async (_config, accountId, folderPath, _batchSize, _sinceDate, onBatch) => {
        await onBatch({
          accountId,
          folder: folderPath,
          messages: [msg],
          fetchedCount: 1,
          totalUids: 1,
          batchIndex: 0,
          isLastBatch: true,
          folderStatus,
        });
        return { uids: [msg.uid], folder_status: folderStatus, messages_fetched: 1 };
      })
      .mockRejectedValueOnce(new Error("TCP connect timed out"));

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(mockImapSyncFolderStreaming).toHaveBeenCalledTimes(4);
  });

  it("continues on non-connection errors without triggering circuit breaker", async () => {
    const folders = Array.from({ length: 6 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSyncFolderStreaming.mockRejectedValue(new Error("PARSE failed: invalid response"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
    expect(mockImapSyncFolderStreaming).toHaveBeenCalledTimes(6);
  });
});

describe("formatImapDate", () => {
  it("formats a date as DD-Mon-YYYY for IMAP SINCE criterion", () => {
    // 2024-03-15 UTC
    const date = new Date(Date.UTC(2024, 2, 15));
    expect(formatImapDate(date)).toBe("15-Mar-2024");
  });

  it("handles single-digit days without zero-padding", () => {
    const date = new Date(Date.UTC(2024, 0, 5));
    expect(formatImapDate(date)).toBe("5-Jan-2024");
  });

  it("handles December correctly", () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    expect(formatImapDate(date)).toBe("31-Dec-2024");
  });
});

describe("computeSinceDate", () => {
  it("returns a date daysBack+1 days ago in DD-Mon-YYYY format", () => {
    const result = computeSinceDate(365);
    // Should match DD-Mon-YYYY format
    expect(result).toMatch(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/);
  });

  it("adds 1-day safety margin", () => {
    // For daysBack=0, should still go back 1 day
    const result = computeSinceDate(0);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(result).toBe(formatImapDate(yesterday));
  });
});

describe("isConnectionError", () => {
  it("detects 'timed out' errors", () => {
    expect(isConnectionError("TCP connect timed out (os error 60)")).toBe(true);
  });

  it("detects 'connection' errors", () => {
    expect(isConnectionError("connection reset by peer")).toBe(true);
  });

  it("detects TLS errors", () => {
    expect(isConnectionError("tls handshake failed")).toBe(true);
  });

  it("detects DNS errors", () => {
    expect(isConnectionError("dns resolution failed")).toBe(true);
  });

  it("detects ECONNREFUSED errors", () => {
    expect(isConnectionError("connect ECONNREFUSED 127.0.0.1:993")).toBe(true);
  });

  it("detects socket errors", () => {
    expect(isConnectionError("socket hang up")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isConnectionError("network is unreachable")).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError("PARSE failed: invalid response")).toBe(false);
    expect(isConnectionError("authentication failed")).toBe(false);
  });
});

describe("imapInitialSync — all-folders-fail propagation", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSyncFolderStreaming = vi.mocked(imapSyncFolderStreaming);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    mockImapSyncFolderStreaming.mockReset();
    vi.useRealTimers();
  });

  it("throws when all folders fail and no messages were stored", async () => {
    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 10 }),
      createMockImapFolder({ path: "Sent", raw_path: "Sent", exists: 5 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSyncFolderStreaming.mockRejectedValue("authentication failed");

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
  });
});

describe("imapInitialSync — placeholder cleanup", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSyncFolderStreaming = vi.mocked(imapSyncFolderStreaming);
  const mockDeleteThreadsBatch = vi.mocked(deleteThreadsBatch);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes orphaned placeholder threads after threading", async () => {
    const msg1 = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      subject: "Thread Subject",
      date: Math.floor(Date.now() / 1000),
    });
    const msg2 = createMockImapMessage({
      uid: 2,
      message_id: "<m2@test>",
      in_reply_to: "<m1@test>",
      references: "<m1@test>",
      subject: "Re: Thread Subject",
      date: Math.floor(Date.now() / 1000) + 60,
    });

    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 2, special_use: "\\Inbox" });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    const folderStatus = createMockImapFolderStatus({ exists: 2 });
    mockImapSyncFolderStreaming.mockImplementation(
      async (_config, accountId, folderPath, _batchSize, _sinceDate, onBatch) => {
        await onBatch({
          accountId,
          folder: folderPath,
          messages: [msg1, msg2],
          fetchedCount: 2,
          totalUids: 2,
          batchIndex: 0,
          isLastBatch: true,
          folderStatus,
        });
        return { uids: [1, 2], folder_status: folderStatus, messages_fetched: 2 };
      },
    );

    await imapInitialSync("acc-1");

    // Threading should merge the two messages into one thread,
    // so at least one placeholder thread (the one not chosen as thread ID) should be deleted
    expect(mockDeleteThreadsBatch).toHaveBeenCalled();
  });
});
