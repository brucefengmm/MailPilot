import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "../db/messages";

const mockGetAccount = vi.fn();
const mockUpdateMessageBody = vi.fn();
const mockFetchMessage = vi.fn();

vi.mock("../db/accounts", () => ({
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
}));

vi.mock("../db/messages", () => ({
  updateMessageBody: (...args: unknown[]) => mockUpdateMessageBody(...args),
}));

vi.mock("../email/providerFactory", () => ({
  getEmailProvider: vi.fn(() =>
    Promise.resolve({
      fetchMessage: (...args: unknown[]) => mockFetchMessage(...args),
    }),
  ),
}));

const { ensureMessageBodyLoaded } = await import("./messageBodyLoader");

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
    mockGetAccount.mockResolvedValue({
      id: "acc-1",
      provider: "imap",
    });
    mockFetchMessage.mockResolvedValue({
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
    });
    mockUpdateMessageBody.mockResolvedValue(undefined);
  });

  it("returns cached message without fetching", async () => {
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
});
