import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BulkPlaceholderMessage } from "./bulkWrite";

const mockSelect = vi.fn();
const mockExecute = vi.fn();

vi.mock("./connection", () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      select: mockSelect,
      execute: mockExecute,
    }),
  ),
  withTransaction: vi.fn(async (fn: (db: unknown) => Promise<void>) => {
    await fn({ execute: mockExecute, select: mockSelect });
  }),
}));

const { bulkInsertPlaceholderMessages, bulkWriteInternals } = await import("./bulkWrite");

function makeItem(
  uid: number,
  folder: string,
  overrides: Partial<{ isRead: boolean; isStarred: boolean }> = {},
): BulkPlaceholderMessage {
  return {
    threadId: `imap-acc-1-${folder}-${uid}`,
    accountId: "acc-1",
    subject: "Test",
    snippet: "Hello",
    lastMessageAt: 1_700_000_000,
    isRead: overrides.isRead ?? true,
    isStarred: overrides.isStarred ?? false,
    hasAttachments: false,
    labelIds: ["INBOX"],
    message: {
      id: `imap-acc-1-${folder}-${uid}`,
      fromAddress: "a@example.com",
      fromName: "A",
      toAddresses: null,
      ccAddresses: null,
      bccAddresses: null,
      replyTo: null,
      date: 1_700_000_000,
      bodyHtml: null,
      bodyText: null,
      rawSize: 100,
      internalDate: 1_700_000_000,
      listUnsubscribe: null,
      listUnsubscribePost: null,
      authResults: null,
      messageIdHeader: "<msg@example.com>",
      referencesHeader: null,
      inReplyToHeader: null,
      imapUid: uid,
      imapFolder: folder,
    },
    attachments: [],
  };
}

describe("filterChangedPlaceholderItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips items with matching IMAP uid/folder and read/star flags", async () => {
    mockSelect.mockResolvedValue([
      { imap_uid: 42, imap_folder: "INBOX", is_read: 1, is_starred: 0 },
    ]);

    const items = [makeItem(42, "INBOX")];
    const filtered = await bulkWriteInternals.filterChangedPlaceholderItems(items);

    expect(filtered).toEqual([]);
    expect(mockSelect).toHaveBeenCalledWith(
      expect.stringContaining("imap_uid IN"),
      ["acc-1", "INBOX", 42],
    );
  });

  it("keeps items when read flag changed on server", async () => {
    mockSelect.mockResolvedValue([
      { imap_uid: 42, imap_folder: "INBOX", is_read: 0, is_starred: 0 },
    ]);

    const items = [makeItem(42, "INBOX", { isRead: true })];
    const filtered = await bulkWriteInternals.filterChangedPlaceholderItems(items);

    expect(filtered).toHaveLength(1);
  });

  it("keeps items not yet in DB", async () => {
    mockSelect.mockResolvedValue([]);

    const items = [makeItem(99, "INBOX")];
    const filtered = await bulkWriteInternals.filterChangedPlaceholderItems(items);

    expect(filtered).toHaveLength(1);
  });
});

describe("bulkInsertPlaceholderMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockResolvedValue([
      { imap_uid: 1, imap_folder: "INBOX", is_read: 1, is_starred: 0 },
    ]);
  });

  it("does not open a write transaction when all items are unchanged", async () => {
    const { withTransaction } = await import("./connection");
    const items = [makeItem(1, "INBOX")];

    await bulkInsertPlaceholderMessages(items);

    expect(vi.mocked(withTransaction)).not.toHaveBeenCalled();
  });
});
