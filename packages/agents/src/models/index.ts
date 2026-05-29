import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { MastraModelConfig } from "@mastra/core/llm";

import type { LanguageModelConfig, LanguageModelProvider, OpenAIModelApi } from "../types.ts";

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

interface CreatedLanguageModel {
  config: ResolvedLanguageModelConfig;
  model: MastraModelConfig;
}

export function createLanguageModel(config: LanguageModelConfig): CreatedLanguageModel {
  const resolved = resolveLanguageModelConfig(config);

  switch (resolved.provider) {
    case "openai":
      return {
        config: resolved,
        model: createOpenAIModel(resolved, resolved.api ?? "responses"),
      };

    case "openai-compatible":
      if (!resolved.baseURL) {
        throw new Error("MODEL_BASE_URL is required for openai-compatible.");
      }
      return {
        config: resolved,
        model: createOpenAIModel(resolved, resolved.api ?? "chat"),
      };

    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        headers: resolved.headers,
      });
      return { config: resolved, model: anthropic.chat(resolved.model) };
    }

    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        headers: resolved.headers,
      });
      return { config: resolved, model: google.chat(resolved.model) };
    }
  }
}

export function isLanguageModelConfigured(
  config: LanguageModelConfig | undefined,
): config is LanguageModelConfig & { apiKey: string } {
  return Boolean(config?.apiKey);
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

function createOpenAIModel(
  config: ResolvedLanguageModelConfig,
  api: OpenAIModelApi,
): MastraModelConfig {
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
