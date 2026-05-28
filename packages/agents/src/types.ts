import type { AGUIEvent, RunAgentInput } from "@ag-ui/core";
import type {
  AgentProviderId,
  AgentProviderSelection,
} from "./providers/ids.js";

export type AgentRunner = (input: RunAgentInput) => AsyncIterable<AGUIEvent>;

export interface LanguageModelConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface AgentExecutionConfig {
  maxToolIterations?: number;
}

export interface AgentConfig {
  provider?: AgentProviderSelection;
  languageModel?: LanguageModelConfig;
  execution?: AgentExecutionConfig;
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
