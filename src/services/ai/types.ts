export type AiProvider =
  | "claude"
  | "openai"
  | "gemini"
  | "ollama"
  | "copilot"
  | "deepseek"
  | "glm"
  | "kimi";

export type ApiKeyAiProvider = Exclude<AiProvider, "ollama">;

export interface AiCompletionRequest {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
}

export interface AiProviderClient {
  complete(req: AiCompletionRequest): Promise<string>;
  testConnection(): Promise<boolean>;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash-preview-05-20",
  ollama: "llama3.2",
  copilot: "openai/gpt-4o-mini",
  deepseek: "deepseek-v4-flash",
  glm: "glm-5.2",
  kimi: "kimi-k2.6",
};

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<ApiKeyAiProvider, ModelOption[]> = {
  claude: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro-preview-05-06", label: "Gemini 2.5 Pro" },
  ],
  copilot: [
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (Low)" },
    { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano (Low)" },
    { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini (High)" },
    { id: "openai/gpt-4o", label: "GPT-4o (High)" },
    { id: "openai/gpt-4.1", label: "GPT-4.1 (High)" },
  ],
  deepseek: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ],
  glm: [
    { id: "glm-5.3", label: "GLM-5.3" },
    { id: "glm-5.2", label: "GLM-5.2" },
    { id: "glm-5.1", label: "GLM-5.1" },
  ],
  kimi: [
    { id: "kimi-k2.6", label: "Kimi K2.6" },
    { id: "kimi-k3", label: "Kimi 3.0 (K3)" },
  ],
};

export const MODEL_SETTINGS: Record<ApiKeyAiProvider, string> = {
  claude: "claude_model",
  openai: "openai_model",
  gemini: "gemini_model",
  copilot: "copilot_model",
  deepseek: "deepseek_model",
  glm: "glm_model",
  kimi: "kimi_model",
};

export const API_KEY_SETTINGS: Record<ApiKeyAiProvider, string> = {
  claude: "claude_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
  copilot: "copilot_api_key",
  deepseek: "deepseek_api_key",
  glm: "glm_api_key",
  kimi: "kimi_api_key",
};

const API_KEY_PROVIDER_SET = new Set<string>(
  Object.keys(API_KEY_SETTINGS).filter((p) => p !== "ollama"),
);

export function isApiKeyAiProvider(value: string | null | undefined): value is ApiKeyAiProvider {
  return !!value && API_KEY_PROVIDER_SET.has(value);
}

export function isAiProvider(value: string | null | undefined): value is AiProvider {
  return value === "ollama" || isApiKeyAiProvider(value);
}

export const API_KEY_LABELS: Record<ApiKeyAiProvider, string> = {
  claude: "Anthropic API Key",
  openai: "OpenAI API Key",
  gemini: "Google AI API Key",
  copilot: "GitHub Personal Access Token",
  deepseek: "DeepSeek API Key",
  glm: "智谱 API Key",
  kimi: "Moonshot API Key",
};

export const API_KEY_PLACEHOLDERS: Record<ApiKeyAiProvider, string> = {
  claude: "sk-ant-...",
  openai: "sk-...",
  gemini: "AI...",
  copilot: "ghp_...",
  deepseek: "sk-...",
  glm: "xxxxxxxx.xxxxxxxx",
  kimi: "sk-...",
};
