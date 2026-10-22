import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import type { LanguageModelConfig, LanguageModelProvider, OpenAIModelApi } from "../types.ts";
import type { LanguageModel } from "./types.ts";

const DEFAULT_MODEL_BY_PROVIDER: Record<LanguageModelProvider, string> = {
  openai: "gpt-4.1-mini",
  "openai-compatible": "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

export interface ResolvedLanguageModelConfig {
  api?: OpenAIModelApi;
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
  model: string;
  provider: LanguageModelProvider;
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
      return createOpenAIModel(config, config.api ?? "responses");

    case "openai-compatible":
      if (!config.baseURL) {
        throw new Error("MODEL_BASE_URL is required for openai-compatible.");
      }
      return createOpenAIModel(config, config.api ?? "chat");

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

  const provider = config.provider ?? inferLanguageModelProvider(config);

  return {
    api: config.api,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: config.headers,
    model: config.model ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    provider,
  };
}

function inferLanguageModelProvider(config: LanguageModelConfig): LanguageModelProvider {
  if (config.baseURL) {
    return "openai-compatible";
  }

  return "openai";
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
