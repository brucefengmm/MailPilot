import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAiTriggerMode,
  parseAiOutputLanguage,
  getSummarizeMode,
  getSmartRepliesMode,
  getSummaryLanguage,
  getRepliesLanguage,
  languageInstruction,
} from "./aiPreferences";
import { getSetting } from "@/services/db/settings";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(),
}));

const mockGetSetting = vi.mocked(getSetting);

describe("aiPreferences", () => {
  beforeEach(() => {
    mockGetSetting.mockReset();
  });

  describe("parseAiTriggerMode", () => {
    it("returns manual only for explicit manual value", () => {
      expect(parseAiTriggerMode("manual")).toBe("manual");
      expect(parseAiTriggerMode("auto")).toBe("auto");
      expect(parseAiTriggerMode(null)).toBe("auto");
      expect(parseAiTriggerMode(undefined)).toBe("auto");
    });
  });

  describe("parseAiOutputLanguage", () => {
    it("parses zh, ru, and defaults to en", () => {
      expect(parseAiOutputLanguage("zh")).toBe("zh");
      expect(parseAiOutputLanguage("ru")).toBe("ru");
      expect(parseAiOutputLanguage("en")).toBe("en");
      expect(parseAiOutputLanguage(null)).toBe("en");
    });
  });

  describe("languageInstruction", () => {
    it("returns language-specific instructions", () => {
      expect(languageInstruction("zh")).toContain("Chinese");
      expect(languageInstruction("ru")).toContain("Russian");
      expect(languageInstruction("en")).toContain("English");
    });
  });

  describe("getSummarizeMode", () => {
    it("uses ai_summarize_mode when set", async () => {
      mockGetSetting.mockImplementation(async (key) =>
        key === "ai_summarize_mode" ? "manual" : null,
      );
      await expect(getSummarizeMode()).resolves.toBe("manual");
    });

    it("falls back to legacy ai_auto_summarize", async () => {
      mockGetSetting.mockImplementation(async (key) => {
        if (key === "ai_summarize_mode") return null;
        if (key === "ai_auto_summarize") return "false";
        return null;
      });
      await expect(getSummarizeMode()).resolves.toBe("manual");
    });
  });

  describe("getSmartRepliesMode", () => {
    it("defaults to auto when unset", async () => {
      mockGetSetting.mockResolvedValue(null);
      await expect(getSmartRepliesMode()).resolves.toBe("auto");
    });
  });

  describe("getSummaryLanguage", () => {
    it("reads ai_summary_language", async () => {
      mockGetSetting.mockResolvedValue("zh");
      await expect(getSummaryLanguage()).resolves.toBe("zh");
    });
  });

  describe("getRepliesLanguage", () => {
    it("reads ai_replies_language", async () => {
      mockGetSetting.mockResolvedValue("ru");
      await expect(getRepliesLanguage()).resolves.toBe("ru");
    });
  });
});
