import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { ImapConfig, ImapFolder } from "@/services/imap/tauriCommands";
import { imapListFolders } from "@/services/imap/tauriCommands";
import { getSyncableFolders } from "@/services/imap/folderMapper";
import type { ImapSyncMode } from "@/services/db/imapSyncPrefs";

export interface ImapSyncConfigState {
  syncMode: ImapSyncMode;
  syncDays: string;
  syncSince: string;
  folderPrefs: Record<string, boolean>;
}

interface ImapSyncConfigPanelProps {
  imapConfig: ImapConfig;
  initialSyncMode?: ImapSyncMode;
  initialSyncDays?: string;
  initialSyncSince?: string;
  initialFolderPrefs?: Record<string, boolean>;
  onChange: (state: ImapSyncConfigState) => void;
}

const inputClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors";

export function ImapSyncConfigPanel({
  imapConfig,
  initialSyncMode = "days",
  initialSyncDays = "365",
  initialSyncSince = "",
  initialFolderPrefs,
  onChange,
}: ImapSyncConfigPanelProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folders, setFolders] = useState<ImapFolder[]>([]);
  const [folderFilter, setFolderFilter] = useState("");
  const [syncMode, setSyncMode] = useState<ImapSyncMode>(initialSyncMode);
  const [syncDays, setSyncDays] = useState(initialSyncDays);
  const [syncSince, setSyncSince] = useState(initialSyncSince);
  const [folderPrefs, setFolderPrefs] = useState<Record<string, boolean>>(
    initialFolderPrefs ?? {},
  );

  const loadFolders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const all = await imapListFolders(imapConfig);
      const syncable = getSyncableFolders(all);
      setFolders(syncable);
      if (!initialFolderPrefs || Object.keys(initialFolderPrefs).length === 0) {
        const prefs: Record<string, boolean> = {};
        for (const f of syncable) {
          prefs[f.raw_path] = true;
        }
        setFolderPrefs(prefs);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [imapConfig, initialFolderPrefs]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    onChange({ syncMode, syncDays, syncSince, folderPrefs });
  }, [syncMode, syncDays, syncSince, folderPrefs, onChange]);

  const filteredFolders = useMemo(() => {
    const q = folderFilter.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q),
    );
  }, [folders, folderFilter]);

  const enabledCount = useMemo(
    () => Object.values(folderPrefs).filter(Boolean).length,
    [folderPrefs],
  );

  const setAllFolders = (enabled: boolean) => {
    setFolderPrefs((prev) => {
      const next = { ...prev };
      for (const f of folders) {
        next[f.raw_path] = enabled;
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading folders from server...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-danger">{loadError}</div>
        <button
          type="button"
          onClick={() => void loadFolders()}
          className="text-sm text-accent hover:text-accent-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm font-medium text-text-primary mb-2">
          Sync time range
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="radio"
              name="sync-mode"
              checked={syncMode === "days"}
              onChange={() => setSyncMode("days")}
            />
            Last
            <select
              value={syncDays}
              disabled={syncMode !== "days"}
              onChange={(e) => setSyncDays(e.target.value)}
              className="bg-bg-secondary border border-border-primary rounded px-2 py-0.5 text-sm"
            >
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">1 year</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="radio"
              name="sync-mode"
              checked={syncMode === "since"}
              onChange={() => setSyncMode("since")}
            />
            Since date
            <input
              type="date"
              value={syncSince}
              disabled={syncMode !== "since"}
              onChange={(e) => setSyncSince(e.target.value)}
              className="bg-bg-secondary border border-border-primary rounded px-2 py-0.5 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="radio"
              name="sync-mode"
              checked={syncMode === "all"}
              onChange={() => setSyncMode("all")}
            />
            All mail (may take a long time)
          </label>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-text-primary">
            Folders to sync ({enabledCount}/{folders.length})
          </div>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setAllFolders(true)}
              className="text-accent hover:text-accent-hover"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setAllFolders(false)}
              className="text-accent hover:text-accent-hover"
            >
              Select none
            </button>
          </div>
        </div>
        <p className="text-xs text-text-tertiary mb-2">
          Uncheck folders you don&apos;t need (e.g. mailing lists). Only selected
          folders are downloaded during sync.
        </p>
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-text-tertiary" />
          <input
            type="text"
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            placeholder="Filter folders..."
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="max-h-52 overflow-y-auto rounded-lg border border-border-primary divide-y divide-border-primary">
          {filteredFolders.map((folder) => (
            <label
              key={folder.raw_path}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-bg-hover cursor-pointer"
            >
              <input
                type="checkbox"
                checked={folderPrefs[folder.raw_path] ?? false}
                onChange={(e) =>
                  setFolderPrefs((prev) => ({
                    ...prev,
                    [folder.raw_path]: e.target.checked,
                  }))
                }
                className="rounded border-border-primary text-accent focus:ring-accent"
              />
              <span className="flex-1 truncate text-text-primary">{folder.path}</span>
              {folder.exists > 0 && (
                <span className="text-xs text-text-tertiary shrink-0">
                  {folder.exists}
                </span>
              )}
            </label>
          ))}
          {filteredFolders.length === 0 && (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              No folders match your filter
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function buildImapConfigFromForm(form: {
  imapHost: string;
  imapPort: number;
  imapSecurity: string;
  email: string;
  imapUsername: string;
  password: string;
  authMode: "password" | "oauth2";
  oauthAccessToken: string | null;
  oauthEmail: string | null;
  acceptInvalidCerts: boolean;
}): ImapConfig {
  const mapSecurity = (security: string): string => {
    if (security === "ssl") return "tls";
    return security;
  };
  const isOAuth = form.authMode === "oauth2";
  return {
    host: form.imapHost.trim(),
    port: form.imapPort,
    security: mapSecurity(form.imapSecurity) as ImapConfig["security"],
    username: form.imapUsername || (isOAuth ? (form.oauthEmail ?? form.email) : form.email),
    password: isOAuth ? (form.oauthAccessToken ?? "") : form.password,
    auth_method: isOAuth ? "oauth2" : "password",
    accept_invalid_certs: form.acceptInvalidCerts,
  };
}
