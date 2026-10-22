import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { Observable } from "rxjs";

export type AgentRunner = (input: RunAgentInput) => Observable<BaseEvent>;

export interface Agent {
  run: AgentRunner;
  /** MCP connection status and OAuth control; undefined when no MCP servers are configured. */
  mcp: McpConnections | undefined;
}

/** What the app needs to surface MCP connection state and finish OAuth flows. */
export interface McpConnections {
  /**
   * Connects every server that isn't connected yet (failed ones are retried
   * after a short delay; ones waiting for authorization are left alone).
   */
  connect(): Promise<void>;
  status(): McpServerInfo[];
  /**
   * Completes an authorization: exchanges the `code` from the OAuth redirect
   * for tokens, then connects the server whose request carried `state`.
   * Rejects when `state` matches no pending authorization.
   */
  finishAuth(state: string, code: string): Promise<McpServerInfo>;
  close(): Promise<void>;
}

/**
 * - `pending` — not connected yet; the next run or {@link McpConnections.connect} tries
 * - `connected` — tools are available
 * - `needs_auth` — waiting for the user to approve at `authorizationUrl`
 * - `failed` — couldn't connect (see `error`); retried after a short delay
 */
export type McpServerStatus = "pending" | "connected" | "needs_auth" | "failed";

export interface McpServerInfo {
  id: string;
  status: McpServerStatus;
  toolCount: number;
  authorizationUrl?: string;
  error?: string;
}

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
  /**
   * Enables OAuth for remote (HTTP / SSE) servers. A server that answers 401
   * moves to `needs_auth` with an authorization URL; the app sends the user
   * there and routes the redirect back to {@link McpConnections.finishAuth}.
   */
  oauth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
  /** The app's OAuth callback, e.g. `http://localhost:3000/mcp/oauth/callback`. */
  redirectUrl: string;
  /** `client_name` sent during dynamic client registration. */
  clientName?: string;
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

/** The preferred remote transport; a `url` without `transport` uses it. */
export interface McpStreamableHttpServerConfig extends McpBaseServerConfig {
  transport?: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Legacy HTTP+SSE transport, for servers that predate Streamable HTTP. */
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
