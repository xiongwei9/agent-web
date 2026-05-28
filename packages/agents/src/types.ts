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

export interface LanguageModelConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface AgentExecutionConfig {
  maxToolIterations?: number;
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
