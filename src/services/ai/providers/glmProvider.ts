import { createOpenAiCompatibleProviderFactory } from "./openaiCompatibleProvider";

/** @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction */
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";

const factory = createOpenAiCompatibleProviderFactory(GLM_BASE_URL);

export function createGlmProvider(apiKey: string, model: string) {
  return factory.createProvider(apiKey, model);
}

export function clearGlmProvider(): void {
  factory.clear();
}
