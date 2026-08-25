import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { hasFolderSyncPrefs } from "@/services/db/imapSyncPrefs";

export function ImapSyncPromptBanner() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const [show, setShow] = useState(false);

  useEffect(() => {
    async function check() {
      if (!activeAccountId) {
        setShow(false);
        return;
      }
      const storeAcct = accounts.find((a) => a.id === activeAccountId);
      if (!storeAcct || storeAcct.provider !== "imap") {
        setShow(false);
        return;
      }
      const configured = await hasFolderSyncPrefs(activeAccountId);
      setShow(!configured);
    }

    void check();
    window.addEventListener("mailpilot-imap-sync-configured", check);
    return () => window.removeEventListener("mailpilot-imap-sync-configured", check);
  }, [activeAccountId, accounts]);

  if (!show) return null;

  return (
    <div className="fixed top-8 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-accent/90 text-white text-xs px-4 py-1.5 backdrop-blur-sm">
      <Download size={14} />
      <span>
        Configure sync in Settings → Accounts → Sync settings, then click Sync now to download mail.
      </span>
    </div>
  );
}
