import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

/** @see https://platform.kimi.com/docs/api/overview */
const KIMI_BASE_URL = "https://api.moonshot.cn/v1";
/** K3 always reasons; allow enough time for a connectivity check. */
const KIMI_TIMEOUT_MS = 120_000;

const factory = createProviderFactory(
  (apiKey) =>
    new OpenAI({
      apiKey,
      baseURL: KIMI_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch,
      timeout: KIMI_TIMEOUT_MS,
    }),
);

type KimiMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
  reasoning_content?: string | null;
};

function isKimiK3(model: string): boolean {
  return model === "kimi-k3";
}

function extractKimiText(message: KimiMessage | undefined): string {
  if (!message) return "";
  const content = message.content?.trim();
  if (content) return content;
  return message.reasoning_content?.trim() ?? "";
}

function buildMessages(req: AiCompletionRequest): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system", content: req.systemPrompt },
    { role: "user", content: req.userContent },
  ];
}

function buildCompletionParams(
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: { maxCompletionTokens?: number; forTest?: boolean },
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  if (isKimiK3(model)) {
    const params: Record<string, unknown> = {
      model,
      messages,
      extra_body: {
        reasoning_effort: "low",
      },
    };
    if (options?.maxCompletionTokens != null) {
      params.max_completion_tokens = Math.max(options.maxCompletionTokens, 256);
    }
    return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  }

  const params: Record<string, unknown> = {
    model,
    messages,
    max_completion_tokens: options?.forTest ? 16 : (options?.maxCompletionTokens ?? 1024),
  };
  if (options?.forTest && model === "kimi-k2.6") {
    params.extra_body = { thinking: { type: "disabled" } };
  }
  return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

export function createKimiProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.chat.completions.create(
        buildCompletionParams(model, buildMessages(req), {
          maxCompletionTokens: req.maxTokens ?? 1024,
        }),
      );

      return extractKimiText(response.choices[0]?.message as KimiMessage | undefined);
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.chat.completions.create(
          buildCompletionParams(model, [{ role: "user", content: "hi" }], { forTest: true }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function clearKimiProvider(): void {
  factory.clear();
}
