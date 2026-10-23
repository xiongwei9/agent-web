import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Observable } from "rxjs";

export type AgentRunner = (input: RunAgentInput, context?: RunContext) => Observable<BaseEvent>;

export interface RunContext {
  /**
   * Who the run is for. MCP connections and OAuth tokens are kept per user, so
   * one user's authorization never serves another. Omitted, the run uses a
   * single shared scope (fine for one-user setups and tests).
   */
  userId?: string;
}

export interface Agent {
  run: AgentRunner;
  /** MCP connection status and OAuth control; undefined when no MCP servers are configured. */
  mcp: McpConnections | undefined;
  /** The installed Agent Skills, e.g. to offer `/skill-name` commands. */
  skills: SkillInfo[];
}

/** An installed Agent Skill, as a user picks it. */
export interface SkillInfo {
  name: string;
  description: string;
}

export interface SkillsConfig {
  /**
   * Directories holding skill folders (each a folder with a `SKILL.md`).
   * A skill in an earlier directory wins a name clash with a later one.
   * Default: none, so the agent has no skills.
   */
  dirs?: string[];
}

/**
 * What the app needs to surface MCP connection state and finish OAuth flows.
 * Everything is per user (see {@link RunContext.userId}); omitting `userId`
 * means the shared scope.
 */
export interface McpConnections {
  /**
   * Connects every server that isn't connected yet for this user (failed ones
   * are retried after a short delay; ones waiting for authorization are left
   * alone).
   */
  connect(userId?: string): Promise<void>;
  status(userId?: string): McpServerInfo[];
  /**
   * Completes an authorization: exchanges the `code` from the OAuth redirect
   * for tokens, then connects the server whose request carried `state` — for
   * whichever user started it, so the callback needs no session. Rejects when
   * `state` matches no pending authorization.
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
  /**
   * The model's context window in tokens. Context compaction triggers at 80% of
   * it unless `contextCompaction.maxTokens` is set. Defaults by provider: 1M for
   * `openai` and `google`, 200k for `anthropic`, 128k for `openai-compatible`.
   */
  contextWindow?: number;
}

export interface AgentExecutionConfig {
  /**
   * How many rounds of tool calls one run may make (default 16). Once spent,
   * the model gets one more turn with tools disabled to answer from what it
   * has, so the run always ends with a reply.
   */
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
  /**
   * Compact once the estimated prompt token count exceeds this. Defaults to 80%
   * of `languageModel.contextWindow`.
   */
  maxTokens?: number;
  /** Always keep at least this many of the most recent messages verbatim. */
  keepRecentMessages?: number;
}

/**
 * Code mode: the model calls the server tools (builtins, MCP) by writing
 * JavaScript for one `execute_code` tool instead of calling each tool itself.
 * The code runs in a QuickJS sandbox with no network, file system, or process
 * access — only the tools.
 */
export interface CodeModeConfig {
  /** Master switch. Defaults to disabled: every tool is offered directly. */
  enabled?: boolean;
  /** Wall-clock limit for one `execute_code` call, its tool calls included (default 30s). */
  timeoutMs?: number;
  /**
   * Type-check the code against the tools' declarations before running it
   * (default true), so a call that can't work fails before any tool runs.
   */
  typeCheck?: boolean;
  /**
   * How the model learns the tools' signatures:
   * - `auto` (default) — `inline` while their declarations are short, else `search`
   * - `inline` — every declaration is in the `execute_code` description
   * - `search` — the description only names the tools; the model looks up the
   *   declarations it needs with the `search_tools` tool, so the prompt stays
   *   small however many MCP tools there are
   */
  toolDiscovery?: "auto" | "inline" | "search";
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
  /**
   * Close a user's MCP connections after this long unused (default 30
   * minutes). Their OAuth tokens stay in the store, so they reconnect on the
   * next run without authorizing again.
   */
  idleTimeoutMs?: number;
}

export interface McpOAuthConfig {
  /** The app's OAuth callback, e.g. `http://localhost:3000/mcp/oauth/callback`. */
  redirectUrl: string;
  /** `client_name` sent during dynamic client registration. */
  clientName?: string;
  /**
   * Where client registrations and tokens persist. Defaults to memory, so a
   * restart means authorizing again; see `createFileMcpOAuthStore`.
   */
  store?: McpOAuthStore;
  /**
   * Tells the model how the user authorizes a server in this app, e.g.
   * `The user authorizes it with the "Authorize" button above the chat.`
   * Shown in the system prompt and in the error a tool call returns while its
   * server waits for authorization.
   */
  authorizationHint?: string;
}

/** What an MCP OAuth client persists for one server. */
export interface McpOAuthCredentials {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

/**
 * Persists {@link McpOAuthCredentials}. A key identifies one server (its id and
 * URL), so changing a server's URL starts over instead of reusing credentials.
 */
export interface McpOAuthStore {
  load(key: string): Promise<McpOAuthCredentials | undefined>;
  /** `undefined` deletes the entry. */
  save(key: string, credentials: McpOAuthCredentials | undefined): Promise<void>;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpStreamableHttpServerConfig
  | McpSseServerConfig;

export interface McpBaseServerConfig {
  /** Per-request MCP protocol timeout in milliseconds. */
  timeoutMs?: number;
  /** Which of the server's tools wait for the user's approval before each call (default `destructive`). */
  approval?: McpToolApproval;
}

/**
 * Which of a server's tools need the user's approval before each call:
 * - `destructive` (default) — the tools whose annotations say they are
 *   destructive: `destructiveHint: true`, or `readOnlyHint: false` without
 *   `destructiveHint: false` (the MCP spec's default for a tool that writes).
 *   Tools without these hints run freely, so use `always` for a server that
 *   doesn't annotate its tools.
 * - `always` — every tool
 * - `never` — none
 */
export type McpToolApproval = "destructive" | "always" | "never";

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
  codeMode?: CodeModeConfig;
  mcp?: McpConfig;
  skills?: SkillsConfig;
  /**
   * Where the agent logs. Defaults to the console with `debug` off. `debug`
   * includes every full prompt and response, tool results included, so enable
   * it only where those may be logged.
   */
  logger?: AgentLogger;
}

/** Structurally compatible with pino / Fastify's `request.log`. */
export interface AgentLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
