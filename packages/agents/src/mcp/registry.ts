import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type {
  AgentLogger,
  McpConfig,
  McpConnections,
  McpOAuthConfig,
  McpServerConfig,
  McpServerInfo,
  McpServerStatus,
} from "../types.ts";
import { consoleLogger } from "../shared/logger.ts";
import { McpOAuthClientProvider } from "./oauth/provider.ts";
import { MemoryMcpOAuthStore } from "./oauth/store.ts";
import {
  describeMcpTool,
  formatMcpToolResult,
  mcpToolResultValue,
  type McpTool,
  type McpToolResult,
} from "./results.ts";
import { uniqueToolName } from "./tool-names.ts";
import { connectClient, isStdioServerConfig, listAllTools, toRequestOptions } from "./transport.ts";
import { isRecord, normalizeToolParameters } from "../shared/utils.ts";
import type { ServerTool, ToolExecutionContext } from "../tools/types.ts";

const DEFAULT_RETRY_DELAY_MS = 5_000;

const DEFAULT_AUTHORIZATION_HINT = "Ask the user to authorize it, then try again.";

interface McpServerEntry {
  id: string;
  config: McpServerConfig;
  /** OAuth client state; only for remote servers when OAuth is enabled. */
  oauth: McpOAuthClientProvider | undefined;
  client: Promise<Client> | undefined;
  status: McpServerStatus;
  tools: McpTool[];
  error: string | undefined;
  /** When a `failed` server may be tried again (ms since epoch). */
  retryAt: number;
  /** The in-flight connect + tool listing, shared by concurrent callers. */
  loading: Promise<void> | undefined;
}

export interface McpToolRegistryOptions {
  oauth?: McpOAuthConfig;
  /** How long a server that failed to connect is left alone before retrying. */
  retryDelayMs?: number;
  logger?: AgentLogger;
}

export function createMcpToolRegistry(
  config: McpConfig | undefined,
  logger?: AgentLogger,
): McpToolRegistry | undefined {
  const servers = config?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }

  return new McpToolRegistry(servers, { oauth: config.oauth, logger });
}

/**
 * Connects to the configured MCP servers and exposes their tools as plain
 * {@link ServerTool}s the agent loop can execute directly.
 *
 * Each server is tracked independently: it connects lazily, its tool list is
 * loaded once and cached while connected, and a server that fails is skipped
 * (with a warning) rather than aborting the run, then retried after
 * `retryDelayMs`. A server that needs OAuth waits in `needs_auth` until
 * {@link finishAuth} completes the flow; if it was connected before (its token
 * stopped working), its tools stay listed and fail with an "ask the user to
 * authorize" error, so the model can say why instead of losing them silently.
 */
export class McpToolRegistry implements McpConnections {
  private readonly entries: McpServerEntry[];
  private readonly retryDelayMs: number;
  private readonly authorizationHint: string;
  private readonly logger: AgentLogger;

  constructor(servers: Record<string, McpServerConfig>, options: McpToolRegistryOptions = {}) {
    const { oauth } = options;
    const oauthStore = oauth ? (oauth.store ?? new MemoryMcpOAuthStore()) : undefined;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.logger = options.logger ?? consoleLogger;
    this.authorizationHint = oauth?.authorizationHint ?? DEFAULT_AUTHORIZATION_HINT;
    this.entries = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, config]) => ({
        id,
        config,
        oauth:
          oauth && oauthStore && !isStdioServerConfig(config)
            ? new McpOAuthClientProvider(oauth, oauthStore, `${id} ${config.url}`)
            : undefined,
        client: undefined,
        status: "pending",
        tools: [],
        error: undefined,
        retryAt: 0,
        loading: undefined,
      }));
  }

  async getTools(): Promise<Map<string, ServerTool>> {
    await this.connect();

    const tools = new Map<string, ServerTool>();
    const usedNames = new Set<string>();
    for (const entry of this.entries) {
      // `needs_auth` keeps the tools it had (see toServerTool); a server that
      // never connected has none.
      if (entry.status !== "connected" && entry.status !== "needs_auth") {
        continue;
      }
      for (const mcpTool of entry.tools) {
        const toolName = uniqueToolName(`${entry.id}__${mcpTool.name}`, usedNames);
        tools.set(toolName, this.toServerTool(entry, mcpTool, toolName));
      }
    }

    return tools;
  }

  async getToolNames(): Promise<Set<string>> {
    return new Set((await this.getTools()).keys());
  }

  async connect(): Promise<void> {
    await Promise.all(this.entries.map((entry) => this.load(entry)));
  }

  status(): McpServerInfo[] {
    return this.entries.map(toServerInfo);
  }

  /**
   * A system-prompt section naming the servers that wait for the user's
   * authorization, so the model can point the user there instead of claiming
   * it lacks the capability. Undefined when none wait. Changes as servers get
   * authorized, so build it per run.
   */
  authorizationPromptSection(): string | undefined {
    const waiting = this.entries.filter((entry) => entry.status === "needs_auth");
    if (waiting.length === 0) {
      return undefined;
    }

    const names = waiting.map((entry) => `\`${entry.id}\``).join(", ");
    return [
      "## MCP servers awaiting authorization",
      "",
      `These MCP servers are configured but need the user's authorization before you can use them: ${names}.`,
      "Until then their tools are unavailable or fail. When a request needs one of them, tell the user it has to be authorized first rather than saying you lack the capability.",
      this.authorizationHint,
    ].join("\n");
  }

  /** Whether `state` belongs to an authorization this registry started. */
  hasPendingAuthorization(state: string): boolean {
    return Boolean(state) && this.entries.some((entry) => entry.oauth?.pendingState === state);
  }

  async finishAuth(state: string, code: string): Promise<McpServerInfo> {
    const entry = state
      ? this.entries.find((candidate) => candidate.oauth?.pendingState === state)
      : undefined;
    if (!entry?.oauth || isStdioServerConfig(entry.config)) {
      throw new Error("Unknown or expired OAuth state");
    }

    const result = await auth(entry.oauth, {
      serverUrl: entry.config.url,
      authorizationCode: code,
    });
    if (result !== "AUTHORIZED") {
      throw new Error(`MCP server "${entry.id}" did not authorize the client`);
    }

    entry.status = "pending";
    await this.load(entry);
    return toServerInfo(entry);
  }

  /**
   * Closes every connected client (terminating stdio child processes) and
   * resets every server to `pending`, so the next {@link getTools} reconnects.
   * OAuth tokens are kept.
   */
  async close(): Promise<void> {
    const clients = this.entries.flatMap((entry) => (entry.client ? [entry.client] : []));
    for (const entry of this.entries) {
      entry.client = undefined;
      entry.status = "pending";
      entry.tools = [];
      entry.error = undefined;
      entry.retryAt = 0;
    }
    await Promise.allSettled(clients.map(async (client) => (await client).close()));
  }

  private load(entry: McpServerEntry): Promise<void> {
    if (entry.status === "connected" || entry.status === "needs_auth") {
      return Promise.resolve();
    }
    if (entry.status === "failed" && Date.now() < entry.retryAt) {
      return Promise.resolve();
    }

    entry.loading ??= this.loadServer(entry).finally(() => {
      entry.loading = undefined;
    });
    return entry.loading;
  }

  private async loadServer(entry: McpServerEntry): Promise<void> {
    try {
      const client = await this.getClient(entry);
      entry.tools = await listAllTools(client, entry.config);
      entry.status = "connected";
      entry.error = undefined;
    } catch (error) {
      this.dropClient(entry);
      entry.tools = [];
      if (error instanceof UnauthorizedError && entry.oauth?.authorizationUrl) {
        entry.status = "needs_auth";
        entry.error = undefined;
        this.logger.warn(
          `[mcp] server "${entry.id}" needs authorization; open ${entry.oauth.authorizationUrl.href}`,
        );
        return;
      }

      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.retryAt = Date.now() + this.retryDelayMs;
      this.logger.warn(`[mcp] skipping server "${entry.id}": ${entry.error}`);
    }
  }

  private toServerTool(entry: McpServerEntry, mcpTool: McpTool, toolName: string): ServerTool {
    const call = async (
      args: Record<string, unknown>,
      context: ToolExecutionContext | undefined,
    ): Promise<McpToolResult> => {
      // Don't reconnect while waiting: the 401 would start a new
      // authorization and invalidate the URL the user may be holding.
      if (entry.status === "needs_auth") {
        throw new Error(this.authorizationRequiredMessage(entry));
      }
      try {
        const client = await this.getClient(entry);
        return await client.callTool(
          { name: mcpTool.name, arguments: isRecord(args) ? args : {} },
          undefined,
          // The SDK sends `notifications/cancelled` to the server on abort.
          { ...toRequestOptions(entry.config), signal: context?.signal },
        );
      } catch (error) {
        if (context?.signal.aborted) {
          throw error; // our own cancel: the session is fine
        }
        if (this.handleCallError(entry, error)) {
          throw new Error(this.authorizationRequiredMessage(entry));
        }
        throw error;
      }
    };

    return {
      name: toolName,
      description: describeMcpTool(entry.id, mcpTool),
      parameters: normalizeToolParameters(mcpTool.inputSchema),
      execute: async (args, context) => formatMcpToolResult(await call(args, context)),
      code: {
        outputSchema: mcpTool.outputSchema,
        execute: async (args, context) =>
          mcpToolResultValue(await call(args, context), mcpTool.outputSchema !== undefined),
      },
    };
  }

  /**
   * A JSON-RPC error (tool failure, timeout) leaves the session usable. Anything
   * else is a transport failure — e.g. the server restarted and forgot the
   * session — so drop the client and let the next call reconnect. A rejected
   * token that couldn't be refreshed parks the server in `needs_auth` (keeping
   * its tools) until the user authorizes again; returns true in that case.
   */
  private handleCallError(entry: McpServerEntry, error: unknown): boolean {
    if (error instanceof McpError) {
      return false;
    }
    this.dropClient(entry);
    if (error instanceof UnauthorizedError && entry.oauth?.authorizationUrl) {
      entry.status = "needs_auth";
      this.logger.warn(
        `[mcp] server "${entry.id}" needs authorization again; open ${entry.oauth.authorizationUrl.href}`,
      );
      return true;
    }
    return false;
  }

  private authorizationRequiredMessage(entry: McpServerEntry): string {
    return `MCP server "${entry.id}" needs the user's authorization before its tools can be used. ${this.authorizationHint}`;
  }

  private getClient(entry: McpServerEntry): Promise<Client> {
    entry.client ??= connectClient(entry.id, entry.config, entry.oauth).catch((error) => {
      entry.client = undefined;
      throw error;
    });
    return entry.client;
  }

  private dropClient(entry: McpServerEntry): void {
    const client = entry.client;
    entry.client = undefined;
    void client?.then((connected) => connected.close()).catch(() => {});
  }
}

function toServerInfo(entry: McpServerEntry): McpServerInfo {
  return {
    id: entry.id,
    status: entry.status,
    toolCount: entry.status === "connected" ? entry.tools.length : 0,
    ...(entry.status === "needs_auth" && entry.oauth?.authorizationUrl
      ? { authorizationUrl: entry.oauth.authorizationUrl.href }
      : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}
