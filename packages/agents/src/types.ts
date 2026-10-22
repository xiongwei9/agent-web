import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { Observable } from "rxjs";

export type AgentRunner = (input: RunAgentInput) => Observable<BaseEvent>;

export const LANGUAGE_MODEL_PROVIDERS = [
  "openai",
  "openai-compatible",
  "anthropic",
  "google",
] as const;

export type LanguageModelProvider = (typeof LANGUAGE_MODEL_PROVIDERS)[number];
export type OpenAIModelApi = "responses" | "chat";

export interface LanguageModelConfig {
  /**
   * Selects the `@ai-sdk/*` package used to create the model. When unset, it is
   * inferred from the config shape (`baseURL` → `openai-compatible`).
   */
  provider?: LanguageModelProvider;
  /**
   * OpenAI SDK API mode. Defaults to `responses` for official OpenAI and
   * `chat` for OpenAI-compatible gateways.
   */
  api?: OpenAIModelApi;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  model?: string;
}

export interface AgentExecutionConfig {
  maxToolIterations?: number;
  /**
   * Context compaction ("prompt optimization"): summarize older messages once
   * the prompt grows past a token threshold, keeping recent turns verbatim.
   * Omit fields to inherit defaults.
   */
  contextCompaction?: ContextCompactionConfig;
}

export interface ContextCompactionConfig {
  /** Master switch. Defaults to enabled. */
  enabled?: boolean;
  /** Compact once the estimated prompt token count exceeds this. */
  maxTokens?: number;
  /** Always keep at least this many of the most recent messages verbatim. */
  keepRecentMessages?: number;
}

export interface McpConfig {
  /**
   * MCP servers exposed to the agent as server-side tools. Object
   * keys become the server namespace used in generated tool names.
   */
  servers?: Record<string, McpServerConfig>;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpStreamableHttpServerConfig
  | McpSseServerConfig;

export interface McpBaseServerConfig {
  /** Per-request MCP protocol timeout in milliseconds. */
  timeoutMs?: number;
}

export interface McpStdioServerConfig extends McpBaseServerConfig {
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpStreamableHttpServerConfig extends McpBaseServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface McpSseServerConfig extends McpBaseServerConfig {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface AgentConfig {
  /**
   * The agent's system prompt (persona/instructions). Defaults to the bundled
   * `src/system-prompt.md`; skills, A2UI, and HITL guidance are appended to it.
   */
  systemPrompt?: string;
  languageModel?: LanguageModelConfig;
  execution?: AgentExecutionConfig;
  mcp?: McpConfig;
}
