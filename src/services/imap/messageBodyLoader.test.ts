import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "../db/messages";

const mockGetAccount = vi.fn();
const mockUpdateMessageBody = vi.fn();
const mockFetchMessage = vi.fn();
const mockHasFileAttachments = vi.fn();
const mockPersistParsedAttachments = vi.fn();
const mockMarkThreadHasAttachments = vi.fn();

vi.mock("../db/accounts", () => ({
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
}));

vi.mock("../db/messages", () => ({
  updateMessageBody: (...args: unknown[]) => mockUpdateMessageBody(...args),
}));

vi.mock("../db/attachments", () => ({
  hasFileAttachments: (...args: unknown[]) => mockHasFileAttachments(...args),
  persistParsedAttachments: (...args: unknown[]) => mockPersistParsedAttachments(...args),
}));

vi.mock("../db/threads", () => ({
  markThreadHasAttachments: (...args: unknown[]) => mockMarkThreadHasAttachments(...args),
}));

vi.mock("../email/providerFactory", () => ({
  getEmailProvider: vi.fn(() =>
    Promise.resolve({
      fetchMessage: (...args: unknown[]) => mockFetchMessage(...args),
    }),
  ),
}));

const { ensureMessageBodyLoaded, _resetBodyLoadCacheForTesting } = await import("./messageBodyLoader");

function makeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "imap-acc-1-INBOX-42",
    account_id: "acc-1",
    thread_id: "thread-1",
    from_address: "a@example.com",
    from_name: "A",
    to_addresses: null,
    cc_addresses: null,
    bcc_addresses: null,
    reply_to: null,
    subject: "Test",
    snippet: "Hi",
    date: 1_700_000_000,
    is_read: 1,
    is_starred: 0,
    body_html: null,
    body_text: null,
    body_cached: 0,
    raw_size: 100,
    internal_date: 1_700_000_000,
    list_unsubscribe: null,
    list_unsubscribe_post: null,
    auth_results: null,
    message_id_header: null,
    references_header: null,
    in_reply_to_header: null,
    imap_uid: 42,
    imap_folder: "INBOX",
    ...overrides,
  };
}

describe("ensureMessageBodyLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBodyLoadCacheForTesting();
    mockGetAccount.mockResolvedValue({
      id: "acc-1",
      provider: "imap",
    });
    mockFetchMessage.mockResolvedValue({
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      attachments: [],
    });
    mockUpdateMessageBody.mockResolvedValue(undefined);
    mockHasFileAttachments.mockResolvedValue(false);
    mockPersistParsedAttachments.mockResolvedValue(0);
    mockMarkThreadHasAttachments.mockResolvedValue(undefined);
  });

  it("returns cached message without fetching when attachments exist", async () => {
    mockHasFileAttachments.mockResolvedValue(true);
    const message = makeMessage({ body_cached: 1, body_html: "<p>cached</p>" });
    const result = await ensureMessageBodyLoaded(message);
    expect(result.body_html).toBe("<p>cached</p>");
    expect(mockFetchMessage).not.toHaveBeenCalled();
  });

  it("fetches body via email provider and persists it", async () => {
    const result = await ensureMessageBodyLoaded(makeMessage());
    expect(mockFetchMessage).toHaveBeenCalledWith("imap-acc-1-INBOX-42");
    expect(mockUpdateMessageBody).toHaveBeenCalledWith(
      "acc-1",
      "imap-acc-1-INBOX-42",
      "<p>Hello</p>",
      "Hello",
    );
    expect(result.body_html).toBe("<p>Hello</p>");
    expect(result.body_cached).toBe(1);
  });

  it("persists attachments from full message fetch", async () => {
    mockFetchMessage.mockResolvedValue({
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      attachments: [
        {
          filename: "files.zip",
          mimeType: "application/zip",
          size: 2048,
          gmailAttachmentId: "2",
          contentId: null,
          isInline: false,
        },
      ],
    });
    mockPersistParsedAttachments.mockResolvedValue(1);

    await ensureMessageBodyLoaded(makeMessage());

    expect(mockPersistParsedAttachments).toHaveBeenCalledWith(
      "acc-1",
      "imap-acc-1-INBOX-42",
      [
        expect.objectContaining({ filename: "files.zip" }),
      ],
    );
    expect(mockMarkThreadHasAttachments).toHaveBeenCalledWith("thread-1");
  });

  it("backfills attachments when body is cached but DB has none", async () => {
    mockFetchMessage.mockResolvedValue({
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      attachments: [
        {
          filename: "doc.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 1024,
          gmailAttachmentId: "3",
          contentId: null,
          isInline: false,
        },
      ],
    });
    mockPersistParsedAttachments.mockResolvedValue(1);

    const message = makeMessage({
      body_cached: 1,
      body_html: "<p>Hello</p>",
      body_text: "Hello",
    });

    await ensureMessageBodyLoaded(message);

    expect(mockUpdateMessageBody).not.toHaveBeenCalled();
    expect(mockPersistParsedAttachments).toHaveBeenCalled();
  });

  it("deduplicates concurrent fetches for the same message", async () => {
    let resolveFetch!: (value: { bodyHtml: string; bodyText: string; attachments: [] }) => void;
    const fetchPromise = new Promise<{ bodyHtml: string; bodyText: string; attachments: [] }>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchMessage.mockReturnValue(fetchPromise);

    const message = makeMessage();
    const p1 = ensureMessageBodyLoaded(message);
    const p2 = ensureMessageBodyLoaded(message);

    resolveFetch({ bodyHtml: "<p>Hello</p>", bodyText: "Hello", attachments: [] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockFetchMessage).toHaveBeenCalledTimes(1);
    expect(r1.body_html).toBe("<p>Hello</p>");
    expect(r2.body_html).toBe("<p>Hello</p>");
  });
});
