import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { hasFolderSyncPrefs, needsImapSyncSetup } from "@/services/db/imapSyncPrefs";

export function ImapSyncPromptBanner() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    async function check() {
      if (!activeAccountId) {
        setNeedsSetup(false);
        return;
      }
      const storeAcct = accounts.find((a) => a.id === activeAccountId);
      if (!storeAcct || storeAcct.provider !== "imap") {
        setNeedsSetup(false);
        return;
      }
      const setup = await needsImapSyncSetup(activeAccountId);
      setNeedsSetup(setup);
      setConfigured(await hasFolderSyncPrefs(activeAccountId));
    }

    void check();
    window.addEventListener("mailpilot-imap-sync-configured", check);
    window.addEventListener("mailpilot-sync-done", check);
    return () => {
      window.removeEventListener("mailpilot-imap-sync-configured", check);
      window.removeEventListener("mailpilot-sync-done", check);
    };
  }, [activeAccountId, accounts]);

  if (!needsSetup) return null;

  return (
    <div className="fixed top-8 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-accent/90 text-white text-xs px-4 py-1.5 backdrop-blur-sm">
      <Download size={14} />
      <span>
        {configured
          ? "Sync settings saved. Click Sync now in Settings → Accounts to download mail."
          : "Configure sync in Settings → Accounts → Sync settings, then click Sync now to download mail."}
      </span>
    </div>
  );
}
