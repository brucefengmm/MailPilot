import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  });
  return { default: MockOpenAI };
});

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import { createKimiProvider, clearKimiProvider } from "./kimiProvider";

describe("kimiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearKimiProvider();
  });

  it("creates OpenAI client with Moonshot CN baseURL, Tauri fetch, and extended timeout", () => {
    createKimiProvider("sk-kimi", "kimi-k2.6");

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "sk-kimi",
      baseURL: "https://api.moonshot.cn/v1",
      dangerouslyAllowBrowser: true,
      fetch,
      timeout: 120_000,
    });
  });

  it("uses max_completion_tokens for k2.6 chat completions", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "你好" } }],
    });

    const provider = createKimiProvider("sk-kimi", "kimi-k2.6");
    const result = await provider.complete({
      systemPrompt: "sys",
      userContent: "hi",
      maxTokens: 512,
    });

    expect(result).toBe("你好");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "kimi-k2.6",
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("uses reasoning_effort for k3 chat completions", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "你好" } }],
    });

    const provider = createKimiProvider("sk-kimi", "kimi-k3");
    await provider.complete({
      systemPrompt: "sys",
      userContent: "hi",
      maxTokens: 512,
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "kimi-k3",
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      extra_body: { reasoning_effort: "low" },
    });
  });

  it("falls back to reasoning_content when content is empty", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: null, reasoning_content: "thought" } }],
    });

    const provider = createKimiProvider("sk-kimi", "kimi-k3");
    const result = await provider.complete({
      systemPrompt: "sys",
      userContent: "hi",
    });

    expect(result).toBe("thought");
  });

  it("disables thinking for k2.6 connection test", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    const provider = createKimiProvider("sk-kimi", "kimi-k2.6");
    expect(await provider.testConnection()).toBe(true);

    expect(mockCreate).toHaveBeenCalledWith({
      model: "kimi-k2.6",
      max_completion_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      extra_body: { thinking: { type: "disabled" } },
    });
  });

  it("uses reasoning_effort without tiny max_completion_tokens for k3 connection test", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    const provider = createKimiProvider("sk-kimi", "kimi-k3");
    expect(await provider.testConnection()).toBe(true);

    expect(mockCreate).toHaveBeenCalledWith({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      extra_body: { reasoning_effort: "low" },
    });
  });

  it("returns false when connection test throws", async () => {
    mockCreate.mockRejectedValue(new Error("401"));

    const provider = createKimiProvider("sk-kimi", "kimi-k3");
    expect(await provider.testConnection()).toBe(false);
  });
});
