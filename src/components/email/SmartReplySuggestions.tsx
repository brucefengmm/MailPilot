import { useState, useCallback, useRef, useEffect } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { isAiAvailable } from "@/services/ai/providerManager";
import { getSmartRepliesMode, getRepliesLanguage, type AiTriggerMode } from "@/services/ai/aiPreferences";
import { generateSmartReplies } from "@/services/ai/aiService";
import { computeThreadMessageFingerprint } from "@/services/ai/threadFingerprint";
import { deleteAiCache, getValidAiCacheContent } from "@/services/db/aiCache";
import { useComposerStore } from "@/stores/composerStore";
import type { DbMessage } from "@/services/db/messages";

interface SmartReplySuggestionsProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
  noReply?: boolean;
  /** Increment to request reply generation (manual mode). */
  trigger?: number;
  /** Hide manual toolbar button while replies are shown or loading. */
  onToolbarHideChange?: (hide: boolean) => void;
}

function parseRepliesCache(cached: string): string[] | null {
  try {
    const parsed = JSON.parse(cached) as unknown;
    if (!Array.isArray(parsed)) return null;
    const replies = parsed.filter((r): r is string => typeof r === "string");
    return replies.length > 0 ? replies : null;
  } catch {
    return null;
  }
}

export function SmartReplySuggestions({
  threadId,
  accountId,
  messages,
  noReply,
  trigger = 0,
  onToolbarHideChange,
}: SmartReplySuggestionsProps) {
  const [replies, setReplies] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<AiTriggerMode>("auto");
  const [modeLoaded, setModeLoaded] = useState(false);
  const [activated, setActivated] = useState(false);
  const loadingRef = useRef(false);
  const lastTriggerRef = useRef(0);
  const openComposer = useComposerStore((s) => s.openComposer);

  useEffect(() => {
    void Promise.all([isAiAvailable(), getSmartRepliesMode()]).then(([aiOk, triggerMode]) => {
      setAvailable(aiOk);
      setMode(triggerMode);
      setModeLoaded(true);
    });
  }, [threadId]);

  useEffect(() => {
    if (!modeLoaded || !available || messages.length === 0) return;

    const fingerprint = computeThreadMessageFingerprint(messages);
    let cancelled = false;

    void (async () => {
      const lang = await getRepliesLanguage();
      const cached = await getValidAiCacheContent(
        accountId,
        threadId,
        `smart_replies_${lang}`,
        fingerprint,
      );
      if (cancelled) return;

      if (cached) {
        const parsed = parseRepliesCache(cached);
        if (parsed) {
          setReplies(parsed);
          setActivated(true);
          return;
        }
      }

      setReplies(null);
      setActivated(mode === "auto");
    })();

    return () => {
      cancelled = true;
    };
  }, [modeLoaded, available, mode, messages, threadId, accountId]);

  const loadReplies = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await generateSmartReplies(threadId, accountId, messages);
      setReplies(result);
    } catch (err) {
      console.error("Failed to generate smart replies:", err);
      setReplies(null);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  useEffect(() => {
    if (!available || messages.length === 0 || !activated) return;
    if (replies !== null || loadingRef.current) return;
    void loadReplies();
  }, [available, messages.length, activated, replies, loadReplies]);

  useEffect(() => {
    if (trigger <= 0 || trigger === lastTriggerRef.current) return;
    lastTriggerRef.current = trigger;
    setActivated(true);
    if (replies !== null) return;
    void loadReplies();
  }, [trigger, replies, loadReplies]);

  useEffect(() => {
    const hideToolbar =
      mode === "manual" && activated && (replies !== null || loading);
    onToolbarHideChange?.(hideToolbar);
  }, [mode, activated, replies, loading, onToolbarHideChange]);

  const handleRefresh = useCallback(async () => {
    const lang = await getRepliesLanguage();
    await deleteAiCache(accountId, threadId, `smart_replies_${lang}`);
    setReplies(null);
    setActivated(true);
    await loadReplies();
  }, [accountId, threadId, loadReplies]);

  const handleReplyClick = useCallback((replyText: string) => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return;

    const replyTo = lastMessage.reply_to ?? lastMessage.from_address;
    openComposer({
      mode: "reply",
      to: replyTo ? [replyTo] : [],
      subject: `Re: ${lastMessage.subject ?? ""}`,
      bodyHtml: `<p>${replyText}</p>`,
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
    });
  }, [messages, openComposer]);

  if (!available || messages.length === 0 || noReply) return null;
  if (mode === "manual" && !activated && !replies && !loading) return null;

  return (
    <div className="mx-4 my-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-accent flex-1">Quick Replies</span>
        <button
          onClick={() => void handleRefresh()}
          className="p-0.5 text-text-tertiary hover:text-accent transition-colors"
          title="Refresh suggestions"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {loading && !replies && (
        <div className="flex items-center gap-2 text-text-tertiary">
          <div className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-xs">Generating suggestions...</span>
        </div>
      )}
      {replies && (
        <div className="flex flex-wrap gap-2">
          {replies.map((reply, i) => (
            <button
              key={i}
              onClick={() => handleReplyClick(reply)}
              className="px-3 py-1.5 text-xs text-text-primary bg-bg-primary border border-border-primary rounded-full hover:bg-bg-hover hover:border-accent/40 transition-colors max-w-[280px] truncate"
              title={reply}
            >
              {reply}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
