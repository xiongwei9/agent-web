import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import type { LanguageModelConfig, LanguageModelProvider, OpenAIModelApi } from "../types.ts";
import type { LanguageModel } from "../model/types.ts";

export interface ResolvedLanguageModelConfig {
  api?: OpenAIModelApi;
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
  model: string;
  provider: LanguageModelProvider;
  contextWindow: number;
}

/**
 * Creates the raw `@ai-sdk/*` model. The loop only uses its `doStream`, which
 * the minimal {@link LanguageModel} interface captures (see `types.ts` for why
 * we don't import the SDK's own type).
 */
export function createLanguageModel(config: ResolvedLanguageModelConfig): LanguageModel {
  return createSdkModel(config) as unknown as LanguageModel;
}

function createSdkModel(config: ResolvedLanguageModelConfig): unknown {
  switch (config.provider) {
    case "openai":
      return createOpenAIModel(config, requireApi(config));

    case "openai-compatible":
      if (!config.baseURL) {
        throw new Error("MODEL_BASE_URL is required for openai-compatible.");
      }
      return createOpenAIModel(config, requireApi(config));

    case "anthropic":
      return createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers: config.headers,
      }).chat(config.model);

    case "google":
      return createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers: config.headers,
      }).chat(config.model);
  }
}

export function resolveLanguageModelConfig(
  config: LanguageModelConfig,
): ResolvedLanguageModelConfig {
  if (!config.apiKey) {
    throw new Error("MODEL_API_KEY is required.");
  }

  if (!config.model) {
    throw new Error("MODEL_NAME is required.");
  }

  return { ...config, apiKey: config.apiKey, model: config.model };
}

function requireApi(config: ResolvedLanguageModelConfig): OpenAIModelApi {
  if (!config.api) {
    throw new Error(`MODEL_API is required for ${config.provider}.`);
  }
  return config.api;
}

function createOpenAIModel(config: ResolvedLanguageModelConfig, api: OpenAIModelApi): unknown {
  const openai = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: config.headers,
    name: config.provider === "openai-compatible" ? "openai-compatible" : undefined,
  });

  if (api === "chat") {
    return openai.chat(config.model);
  }

  return openai.responses(config.model);
}
