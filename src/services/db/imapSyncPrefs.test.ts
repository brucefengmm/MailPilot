import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAccountImapSyncConfig,
  getFilteredSyncFolders,
} from "./imapSyncPrefs";
import { createMockDbAccount } from "@/test/mocks";
import { createMockImapFolder } from "@/test/mocks";

vi.mock("./connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../imap/folderMapper", () => ({
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
  sortFoldersForSync: vi.fn((folders: unknown[]) => folders),
}));

import { getDb } from "./connection";
import { getSyncableFolders, sortFoldersForSync } from "../imap/folderMapper";

describe("getAccountImapSyncConfig", () => {
  it("returns all-mail config when mode is all", async () => {
    const account = createMockDbAccount({
      imap_sync_mode: "all",
    });
    const config = await getAccountImapSyncConfig(account, 365);
    expect(config.mode).toBe("all");
    expect(config.sinceDate).toBeUndefined();
  });

  it("returns since date config when mode is since", async () => {
    const account = createMockDbAccount({
      imap_sync_mode: "since",
      imap_sync_since: "2024-06-01",
    });
    const config = await getAccountImapSyncConfig(account, 365);
    expect(config.mode).toBe("since");
    expect(config.sinceDate).toBe("1-Jun-2024");
  });

  it("defaults to days mode with account-specific days", async () => {
    const account = createMockDbAccount({
      imap_sync_mode: "days",
      imap_sync_days: 90,
    });
    const config = await getAccountImapSyncConfig(account, 365);
    expect(config.mode).toBe("days");
    expect(config.daysBack).toBe(90);
    expect(config.sinceDate).toMatch(/\d+-[A-Z][a-z]{2}-\d{4}/);
  });
});

describe("getFilteredSyncFolders", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn(async () => []),
    } as never);
  });

  it("returns all syncable folders when no prefs saved", async () => {
    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
      createMockImapFolder({ path: "Yandex|list", raw_path: "Yandex|list" }),
    ];
    const result = await getFilteredSyncFolders("acc-1", folders);
    expect(getSyncableFolders).toHaveBeenCalledWith(folders);
    expect(sortFoldersForSync).toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("filters to enabled folders when prefs exist", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn(async () => [
        { folder_path: "INBOX", sync_enabled: 1 },
        { folder_path: "Yandex|list", sync_enabled: 0 },
      ]),
    } as never);

    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
      createMockImapFolder({ path: "Yandex|list", raw_path: "Yandex|list" }),
    ];
    const result = await getFilteredSyncFolders("acc-1", folders);
    expect(result).toHaveLength(1);
    expect(result[0]!.raw_path).toBe("INBOX");
  });
});
