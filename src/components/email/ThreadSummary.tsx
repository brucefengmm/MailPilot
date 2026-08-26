import { useState, useCallback, useRef, useEffect } from "react";
import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { isAiAvailable } from "@/services/ai/providerManager";
import { getSummarizeMode, getSummaryLanguage, type AiTriggerMode } from "@/services/ai/aiPreferences";
import { summarizeThread } from "@/services/ai/aiService";
import { computeThreadMessageFingerprint } from "@/services/ai/threadFingerprint";
import { deleteAiCache, getValidAiCacheContent } from "@/services/db/aiCache";
import type { DbMessage } from "@/services/db/messages";

interface ThreadSummaryProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
  /** Increment to request summary generation (manual mode). */
  trigger?: number;
  /** Hide manual toolbar button while summary is shown or loading. */
  onToolbarHideChange?: (hide: boolean) => void;
}

export function ThreadSummary({ threadId, accountId, messages, trigger = 0, onToolbarHideChange }: ThreadSummaryProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<AiTriggerMode>("auto");
  const [modeLoaded, setModeLoaded] = useState(false);
  const [activated, setActivated] = useState(false);
  const loadingRef = useRef(false);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (messages.length === 0) return;
    void Promise.all([isAiAvailable(), getSummarizeMode()]).then(([aiOk, triggerMode]) => {
      setAvailable(aiOk);
      setMode(triggerMode);
      setModeLoaded(true);
    });
  }, [threadId, messages.length]);

  useEffect(() => {
    if (!modeLoaded || !available || messages.length === 0) return;

    const fingerprint = computeThreadMessageFingerprint(messages);
    let cancelled = false;

    void (async () => {
      const lang = await getSummaryLanguage();
      const cached = await getValidAiCacheContent(
        accountId,
        threadId,
        `summary_${lang}`,
        fingerprint,
      );
      if (cancelled) return;

      if (cached) {
        setSummary(cached);
        setActivated(true);
        return;
      }

      setSummary(null);
      setActivated(mode === "auto");
    })();

    return () => {
      cancelled = true;
    };
  }, [modeLoaded, available, mode, messages, threadId, accountId]);

  const loadSummary = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await summarizeThread(threadId, accountId, messages);
      setSummary(result);
    } catch (err) {
      console.error("Failed to summarize thread:", err);
      setSummary(null);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  useEffect(() => {
    if (!available || messages.length === 0 || !activated) return;
    if (summary !== null || loadingRef.current) return;
    void loadSummary();
  }, [available, messages.length, activated, summary, loadSummary]);

  useEffect(() => {
    if (trigger <= 0 || trigger === lastTriggerRef.current) return;
    lastTriggerRef.current = trigger;
    setActivated(true);
    if (summary !== null) return;
    void loadSummary();
  }, [trigger, summary, loadSummary]);

  useEffect(() => {
    const hideToolbar =
      mode === "manual" && activated && (summary !== null || loading);
    onToolbarHideChange?.(hideToolbar);
  }, [mode, activated, summary, loading, onToolbarHideChange]);

  const handleRefresh = useCallback(async () => {
    const lang = await getSummaryLanguage();
    await deleteAiCache(accountId, threadId, `summary_${lang}`);
    setSummary(null);
    setActivated(true);
    await loadSummary();
  }, [accountId, threadId, loadSummary]);

  if (!available || messages.length === 0) return null;
  if (mode === "manual" && !activated && !summary && !loading) return null;

  return (
    <div className="mx-4 my-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-accent flex-1">AI Summary</span>
        {summary && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); void handleRefresh(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); void handleRefresh(); } }}
            className="p-0.5 text-text-tertiary hover:text-accent transition-colors cursor-pointer"
            title="Refresh summary"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </span>
        )}
        {collapsed ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronUp size={14} className="text-text-tertiary" />}
      </button>
      {!collapsed && (
        <div className="mt-2 text-sm text-text-secondary">
          {loading && !summary && (
            <div className="flex items-center gap-2 text-text-tertiary">
              <div className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-xs">Generating summary...</span>
            </div>
          )}
          {summary && <p className="text-xs leading-relaxed">{summary}</p>}
        </div>
      )}
    </div>
  );
}
