import { getSetting } from "@/services/db/settings";

export type AiTriggerMode = "auto" | "manual";
export type AiOutputLanguage = "en" | "zh" | "ru";

export const AI_TRIGGER_MODE_OPTIONS: { id: AiTriggerMode; label: string }[] = [
  { id: "auto", label: "Automatic" },
  { id: "manual", label: "Manual" },
];

export const AI_LANGUAGE_OPTIONS: { id: AiOutputLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
  { id: "ru", label: "Русский" },
];

export function parseAiTriggerMode(value: string | null | undefined): AiTriggerMode {
  return value === "manual" ? "manual" : "auto";
}

export function parseAiOutputLanguage(value: string | null | undefined): AiOutputLanguage {
  if (value === "zh" || value === "ru") return value;
  return "en";
}

export async function getSummarizeMode(): Promise<AiTriggerMode> {
  const mode = await getSetting("ai_summarize_mode");
  if (mode === "auto" || mode === "manual") return mode;
  const legacy = await getSetting("ai_auto_summarize");
  return legacy === "false" ? "manual" : "auto";
}

export async function getSmartRepliesMode(): Promise<AiTriggerMode> {
  return parseAiTriggerMode(await getSetting("ai_smart_replies_mode"));
}

export async function getSummaryLanguage(): Promise<AiOutputLanguage> {
  return parseAiOutputLanguage(await getSetting("ai_summary_language"));
}

export async function getRepliesLanguage(): Promise<AiOutputLanguage> {
  return parseAiOutputLanguage(await getSetting("ai_replies_language"));
}

export function languageInstruction(lang: AiOutputLanguage): string {
  switch (lang) {
    case "zh":
      return "Write your entire response in Simplified Chinese (简体中文).";
    case "ru":
      return "Write your entire response in Russian (русский язык).";
    default:
      return "Write your entire response in English.";
  }
}
