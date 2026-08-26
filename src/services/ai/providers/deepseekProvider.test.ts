import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  });
  return { default: MockOpenAI };
});

import OpenAI from "openai";
import { createDeepSeekProvider, clearDeepSeekProvider } from "./deepseekProvider";

describe("deepseekProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDeepSeekProvider();
  });

  it("creates OpenAI client with DeepSeek baseURL", () => {
    createDeepSeekProvider("sk-test", "deepseek-v4-flash");

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com",
      dangerouslyAllowBrowser: true,
    });
  });

  it("calls chat.completions.create with model and messages", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "你好" } }],
    });

    const provider = createDeepSeekProvider("sk-test", "deepseek-v4-pro");
    const result = await provider.complete({
      systemPrompt: "You are helpful",
      userContent: "Hi",
    });

    expect(result).toBe("你好");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "deepseek-v4-pro",
      max_tokens: 1024,
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    });
  });

  it("returns true from testConnection on success", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
    });

    const provider = createDeepSeekProvider("sk-test", "deepseek-v4-flash");
    expect(await provider.testConnection()).toBe(true);
  });

  it("returns false from testConnection on error", async () => {
    mockCreate.mockRejectedValue(new Error("Unauthorized"));

    const provider = createDeepSeekProvider("sk-test", "deepseek-v4-flash");
    expect(await provider.testConnection()).toBe(false);
  });
});
