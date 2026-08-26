import { createOpenAiCompatibleProviderFactory } from "./openaiCompatibleProvider";

/** @see https://api-docs.deepseek.com/ */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const factory = createOpenAiCompatibleProviderFactory(DEEPSEEK_BASE_URL);

export function createDeepSeekProvider(apiKey: string, model: string) {
  return factory.createProvider(apiKey, model);
}

export function clearDeepSeekProvider(): void {
  factory.clear();
}
