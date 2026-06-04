import type { BaseEvent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import type { Observable } from "rxjs";
import type { AgentProviderId, AgentProviderSelection } from "./providers/ids.ts";

export interface AgentRunnerOptions {
  /**
   * Mastra `resourceId` — the cross-thread identity (e.g. user id). Providers
   * that don't use Mastra ignore this field. Falls back to `input.threadId`
   * downstream when unset.
   */
  resourceId?: string;
  /**
   * Selects which registered agent should handle this run. Currently honored
   * by the Mastra provider when `MastraProviderConfig.agents` is configured.
   * Unknown ids cause the runner to error so misconfiguration surfaces fast.
   */
  agentId?: string;
  /**
   * Free-form per-request key/value bag exposed to Mastra tools via
   * `RequestContext`. Other providers may ignore it.
   */
  requestContext?: Record<string, unknown>;
}

export type AgentRunner = (
  input: RunAgentInput,
  options?: AgentRunnerOptions,
) => Observable<BaseEvent>;

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
   * Selects the SDK/provider used to create the Mastra model. When unset,
   * applications may infer it from environment variables or config shape.
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
   * Honored by the native provider. Omit fields to inherit defaults.
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

export interface MastraProviderConfig {
  /**
   * libsql connection URL passed to `LibSQLStore`. Examples:
   * `file:./mastra.db`, `:memory:`, `libsql://<host>?authToken=...`.
   * When unset, Mastra is constructed without storage and the agent runs
   * without thread/working-memory persistence.
   */
  storageUrl?: string;
}

export interface McpConfig {
  /**
   * MCP servers exposed to model-backed agents as server-side tools. Object
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

export interface AgnoProviderConfig {
  /**
   * Base URL of the Python agno service exposing an AG-UI endpoint. The
   * provider POSTs `RunAgentInput` to `${baseURL}${path}` and streams the
   * resulting AG-UI events.
   */
  baseURL?: string;
  /** Path on the agno service. Defaults to `/agui`. */
  path?: string;
  /** Extra headers forwarded with each request (e.g. auth tokens). */
  headers?: Record<string, string>;
}

export interface AgentConfig {
  provider?: AgentProviderSelection;
  languageModel?: LanguageModelConfig;
  execution?: AgentExecutionConfig;
  mastra?: MastraProviderConfig;
  mcp?: McpConfig;
  agno?: AgnoProviderConfig;
}

export interface AgentProviderCreateContext {
  config: AgentConfig;
}

export interface AgentProvider {
  id: AgentProviderId;
  label: string;
  description: string;
  configurationHint?: string;
  create: (context: AgentProviderCreateContext) => AgentRunner | undefined;
}

export interface AgentProviderSummary {
  id: AgentProviderId;
  label: string;
  description: string;
  configurationHint?: string;
}

export interface CreateAgentRunnerOptions {
  config?: AgentConfig;
}
