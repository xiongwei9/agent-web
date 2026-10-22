import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpServerConfig, McpStdioServerConfig } from "../types.ts";
import type { McpTool } from "./results.ts";

const MCP_CLIENT_VERSION = "0.1.0";

/** Connects a client for one configured server; `authProvider` enables OAuth (remote only). */
export async function connectClient(
  id: string,
  config: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
): Promise<Client> {
  const client = new Client({ name: `ai-chat-${id}`, version: MCP_CLIENT_VERSION });
  await client.connect(createTransport(config, authProvider), toRequestOptions(config));
  return client;
}

export function createTransport(
  config: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
): Transport {
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
    return new SSEClientTransport(url, { requestInit, authProvider });
  }

  return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
}

export async function listAllTools(client: Client, config: McpServerConfig): Promise<McpTool[]> {
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

export function toRequestOptions(config: McpServerConfig) {
  return config.timeoutMs ? { timeout: config.timeoutMs } : undefined;
}

export function isStdioServerConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return config.transport === "stdio" || "command" in config;
}
