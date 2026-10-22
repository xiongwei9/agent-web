import { createHash } from "node:crypto";

import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type {
  McpConfig,
  McpConnections,
  McpOAuthConfig,
  McpServerConfig,
  McpServerInfo,
  McpServerStatus,
  McpStdioServerConfig,
} from "../types.ts";
import { McpOAuthClientProvider } from "./mcp-oauth.ts";
import { isRecord, normalizeToolParameters } from "./utils.ts";
import type { ServerTool } from "./types.ts";

const MCP_CLIENT_VERSION = "0.1.0";
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type McpToolResult = Awaited<ReturnType<Client["callTool"]>>;

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
}

export function createMcpToolRegistry(config: McpConfig | undefined): McpToolRegistry | undefined {
  const servers = config?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }

  return new McpToolRegistry(servers, { oauth: config.oauth });
}

/**
 * Connects to the configured MCP servers and exposes their tools as plain
 * {@link ServerTool}s the agent loop can execute directly.
 *
 * Each server is tracked independently: it connects lazily, its tool list is
 * loaded once and cached while connected, and a server that fails is skipped
 * (with a warning) rather than aborting the run, then retried after
 * `retryDelayMs`. A server that needs OAuth waits in `needs_auth` until
 * {@link finishAuth} completes the flow.
 */
export class McpToolRegistry implements McpConnections {
  private readonly entries: McpServerEntry[];
  private readonly retryDelayMs: number;

  constructor(servers: Record<string, McpServerConfig>, options: McpToolRegistryOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.entries = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, config]) => ({
        id,
        config,
        oauth:
          options.oauth && !isStdioServerConfig(config)
            ? new McpOAuthClientProvider(options.oauth)
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
      if (entry.status !== "connected") {
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
        console.warn(
          `[mcp] server "${entry.id}" needs authorization; open ${entry.oauth.authorizationUrl.href}`,
        );
        return;
      }

      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.retryAt = Date.now() + this.retryDelayMs;
      console.warn(`[mcp] skipping server "${entry.id}": ${entry.error}`);
    }
  }

  private toServerTool(entry: McpServerEntry, mcpTool: McpTool, toolName: string): ServerTool {
    return {
      name: toolName,
      description: describeMcpTool(entry.id, mcpTool),
      parameters: normalizeToolParameters(mcpTool.inputSchema),
      execute: async (args) => {
        try {
          const client = await this.getClient(entry);
          const result = await client.callTool(
            { name: mcpTool.name, arguments: isRecord(args) ? args : {} },
            undefined,
            toRequestOptions(entry.config),
          );
          return formatMcpToolResult(result);
        } catch (error) {
          this.handleCallError(entry, error);
          throw error;
        }
      },
    };
  }

  /**
   * A JSON-RPC error (tool failure, timeout) leaves the session usable. Anything
   * else is a transport failure — e.g. the server restarted and forgot the
   * session — so drop the client and let the next call reconnect. A rejected
   * token parks the server in `needs_auth` until the user authorizes again.
   */
  private handleCallError(entry: McpServerEntry, error: unknown): void {
    if (error instanceof McpError) {
      return;
    }
    this.dropClient(entry);
    if (error instanceof UnauthorizedError && entry.oauth?.authorizationUrl) {
      entry.status = "needs_auth";
      entry.tools = [];
    }
  }

  private getClient(entry: McpServerEntry): Promise<Client> {
    entry.client ??= connectClient(entry).catch((error) => {
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

async function connectClient(entry: McpServerEntry): Promise<Client> {
  const client = new Client({ name: `ai-chat-${entry.id}`, version: MCP_CLIENT_VERSION });
  await client.connect(createTransport(entry), toRequestOptions(entry.config));
  return client;
}

function createTransport({ config, oauth }: McpServerEntry): Transport {
  if (isStdioServerConfig(config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
    });
  }

  const requestInit = config.headers ? { headers: config.headers } : undefined;
  const url = new URL(config.url);
  if (config.transport === "sse") {
    return new SSEClientTransport(url, { requestInit, authProvider: oauth });
  }

  return new StreamableHTTPClientTransport(url, { requestInit, authProvider: oauth });
}

async function listAllTools(client: Client, config: McpServerConfig): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      toRequestOptions(config),
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

function toRequestOptions(config: McpServerConfig) {
  return config.timeoutMs ? { timeout: config.timeoutMs } : undefined;
}

function isStdioServerConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return config.transport === "stdio" || "command" in config;
}

function describeMcpTool(serverId: string, tool: McpTool): string {
  const prefix = `MCP ${serverId}/${tool.name}`;
  return tool.description ? `${prefix}: ${tool.description}` : prefix;
}

function formatMcpToolResult(result: McpToolResult): string {
  if ("toolResult" in result) {
    return stringifyToolOutput(result.toolResult);
  }

  const textParts = result.content.filter((part) => part.type === "text");
  if (
    textParts.length === result.content.length &&
    textParts.length > 0 &&
    !result.structuredContent &&
    !result.isError
  ) {
    return textParts.map((part) => part.text).join("\n");
  }

  return stringifyToolOutput(result);
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const json = JSON.stringify(value);
  return json ?? String(value);
}

function uniqueToolName(rawName: string, usedNames: Set<string>): string {
  let candidate = normalizeToolName(rawName);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  const hash = createHash("sha1").update(rawName).digest("hex").slice(0, 8);
  candidate = withHashSuffix(candidate, hash);
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = withHashSuffix(normalizeToolName(rawName), `${hash}_${counter}`);
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function normalizeToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  const fallback = normalized.replace(/^_+|_+$/g, "") || "mcp_tool";
  return fallback.length <= MAX_TOOL_NAME_LENGTH
    ? fallback
    : withHashSuffix(fallback, createHash("sha1").update(value).digest("hex").slice(0, 8));
}

function withHashSuffix(value: string, hash: string): string {
  const suffix = `_${hash}`;
  return `${value.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
