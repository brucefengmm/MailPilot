import type { DbAccount } from "./accounts";
import { getAccount } from "./accounts";
import { getDb } from "./connection";
import { getSyncableFolders, sortFoldersForSync } from "../imap/folderMapper";
import type { ImapFolder } from "../imap/tauriCommands";
import { computeSinceDate, formatImapDate } from "../imap/imapDateUtils";

export type ImapSyncMode = "days" | "all" | "since";

export interface ImapFolderSyncPref {
  folder_path: string;
  sync_enabled: number;
}

export interface ImapSyncConfig {
  mode: ImapSyncMode;
  daysBack: number;
  /** IMAP SINCE date (DD-Mon-YYYY), undefined when syncing all mail */
  sinceDate: string | undefined;
}

export async function getFolderSyncPrefs(
  accountId: string,
): Promise<ImapFolderSyncPref[]> {
  const db = await getDb();
  return db.select<ImapFolderSyncPref[]>(
    "SELECT folder_path, sync_enabled FROM imap_folder_sync_prefs WHERE account_id = $1 ORDER BY folder_path ASC",
    [accountId],
  );
}

export async function hasFolderSyncPrefs(accountId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM imap_folder_sync_prefs WHERE account_id = $1",
    [accountId],
  );
  return (rows[0]?.count ?? 0) > 0;
}

/** True after the user has completed at least one successful IMAP mail sync. */
export async function hasCompletedImapInitialSync(accountId: string): Promise<boolean> {
  const account = await getAccount(accountId);
  return !!account?.history_id;
}

/** IMAP accounts join background auto-sync only after folder prefs exist and first sync finished. */
export async function isImapReadyForAutoSync(accountId: string): Promise<boolean> {
  if (!(await hasFolderSyncPrefs(accountId))) return false;
  return hasCompletedImapInitialSync(accountId);
}

/** Show setup banner until folders are configured and first sync has run. */
export async function needsImapSyncSetup(accountId: string): Promise<boolean> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== "imap") return false;
  if (!(await hasFolderSyncPrefs(accountId))) return true;
  return !(await hasCompletedImapInitialSync(accountId));
}

export async function saveFolderSyncPrefs(
  accountId: string,
  prefs: { folderPath: string; enabled: boolean }[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM imap_folder_sync_prefs WHERE account_id = $1",
    [accountId],
  );
  for (const pref of prefs) {
    await db.execute(
      `INSERT INTO imap_folder_sync_prefs (account_id, folder_path, sync_enabled)
       VALUES ($1, $2, $3)`,
      [accountId, pref.folderPath, pref.enabled ? 1 : 0],
    );
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("mailpilot-imap-sync-configured", { detail: { accountId } }),
    );
  }
}

export async function updateAccountImapSyncSettings(
  accountId: string,
  settings: {
    mode: ImapSyncMode;
    days?: number | null;
    sinceDate?: string | null;
  },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE accounts SET imap_sync_mode = $1, imap_sync_days = $2, imap_sync_since = $3, updated_at = unixepoch()
     WHERE id = $4`,
    [
      settings.mode,
      settings.days ?? null,
      settings.sinceDate ?? null,
      accountId,
    ],
  );
}

/** Resolve effective IMAP sync window for an account. */
export async function getAccountImapSyncConfig(
  account: DbAccount,
  globalDaysBack: number,
): Promise<ImapSyncConfig> {
  const mode = (account.imap_sync_mode as ImapSyncMode | null) ?? "days";
  const daysBack =
    account.imap_sync_days ?? globalDaysBack;

  if (mode === "all") {
    return { mode: "all", daysBack, sinceDate: undefined };
  }

  if (mode === "since" && account.imap_sync_since) {
    const parsed = new Date(account.imap_sync_since + "T00:00:00Z");
    if (!Number.isNaN(parsed.getTime())) {
      return {
        mode: "since",
        daysBack,
        sinceDate: formatImapDate(parsed),
      };
    }
  }

  return {
    mode: "days",
    daysBack,
    sinceDate: computeSinceDate(daysBack),
  };
}

/** Apply per-folder sync preferences; when none saved, sync all syncable folders. */
export async function getFilteredSyncFolders(
  accountId: string,
  allFolders: ImapFolder[],
): Promise<ImapFolder[]> {
  const base = getSyncableFolders(allFolders);
  const prefs = await getFolderSyncPrefs(accountId);
  if (prefs.length === 0) {
    return sortFoldersForSync(base);
  }
  const enabledPaths = new Set(
    prefs.filter((p) => p.sync_enabled).map((p) => p.folder_path),
  );
  return sortFoldersForSync(
    base.filter((f) => enabledPaths.has(f.raw_path)),
  );
}
