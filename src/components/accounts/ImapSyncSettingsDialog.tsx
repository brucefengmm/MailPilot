import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { getAccount } from "@/services/db/accounts";
import { buildImapConfig } from "@/services/imap/imapConfigBuilder";
import {
  getFolderSyncPrefs,
  saveFolderSyncPrefs,
  updateAccountImapSyncSettings,
  type ImapSyncMode,
} from "@/services/db/imapSyncPrefs";
import { getSetting } from "@/services/db/settings";
import { resyncAccount } from "@/services/gmail/syncManager";
import {
  ImapSyncConfigPanel,
  type ImapSyncConfigState,
} from "./ImapSyncConfigPanel";

interface ImapSyncSettingsDialogProps {
  accountId: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function ImapSyncSettingsDialog({
  accountId,
  onClose,
  onSaved,
}: ImapSyncSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configState, setConfigState] = useState<ImapSyncConfigState | null>(null);
  const [initialPrefs, setInitialPrefs] = useState<Record<string, boolean>>({});
  const [initialMode, setInitialMode] = useState<ImapSyncMode>("days");
  const [initialDays, setInitialDays] = useState("365");
  const [initialSince, setInitialSince] = useState("");
  const [imapConfig, setImapConfig] = useState<ReturnType<typeof buildImapConfig> | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const account = await getAccount(accountId);
        if (!account) throw new Error("Account not found");
        setImapConfig(buildImapConfig(account));
        const prefs = await getFolderSyncPrefs(accountId);
        const prefMap: Record<string, boolean> = {};
        for (const p of prefs) {
          prefMap[p.folder_path] = !!p.sync_enabled;
        }
        setInitialPrefs(prefMap);
        const mode = (account.imap_sync_mode as ImapSyncMode | null) ?? "days";
        setInitialMode(mode);
        const globalDays = await getSetting("sync_period_days");
        setInitialDays(String(account.imap_sync_days ?? globalDays ?? "365"));
        setInitialSince(account.imap_sync_since ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [accountId]);

  const handleChange = useCallback((state: ImapSyncConfigState) => {
    setConfigState(state);
  }, []);

  const handleSave = async (andResync: boolean) => {
    if (!configState) return;
    const enabledCount = Object.values(configState.folderPrefs).filter(Boolean).length;
    if (enabledCount === 0) {
      setError("Select at least one folder to sync");
      return;
    }
    if (configState.syncMode === "since" && !configState.syncSince) {
      setError("Choose a start date or pick another sync range");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateAccountImapSyncSettings(accountId, {
        mode: configState.syncMode,
        days:
          configState.syncMode === "days"
            ? parseInt(configState.syncDays, 10) || 365
            : null,
        sinceDate:
          configState.syncMode === "since" ? configState.syncSince : null,
      });
      await saveFolderSyncPrefs(
        accountId,
        Object.entries(configState.folderPrefs).map(([folderPath, enabled]) => ({
          folderPath,
          enabled,
        })),
      );
      onSaved?.();
      onClose();
      if (andResync) {
        void resyncAccount(accountId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="IMAP Sync Settings" width="w-full max-w-lg">
      <div className="p-4 space-y-4">
        {loading && (
          <p className="text-sm text-text-secondary">Loading account settings...</p>
        )}
        {error && (
          <div className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg p-3">
            {error}
          </div>
        )}
        {!loading && imapConfig && (
          <ImapSyncConfigPanel
            imapConfig={imapConfig}
            initialSyncMode={initialMode}
            initialSyncDays={initialDays}
            initialSyncSince={initialSince}
            initialFolderPrefs={
              Object.keys(initialPrefs).length > 0 ? initialPrefs : undefined
            }
            onChange={handleChange}
          />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleSave(false)}
            disabled={saving || loading || !configState}
          >
            Save
          </Button>
          <Button
            onClick={() => void handleSave(true)}
            disabled={saving || loading || !configState}
          >
            {saving ? "Saving..." : "Save & resync"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
