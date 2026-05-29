import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolsInput as MastraToolsInput } from "@mastra/core/agent";
import type { PublicSchema } from "@mastra/core/schema";
import { createTool as createMastraTool } from "@mastra/core/tools";

import type { McpConfig, McpServerConfig, McpStdioServerConfig } from "../types.ts";
import { isRecord, normalizeToolParameters } from "./shared.ts";

const MCP_CLIENT_VERSION = "0.1.0";
const MAX_TOOL_NAME_LENGTH = 64;

type MastraToolSchema = PublicSchema<Record<string, unknown>>;
type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type McpToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface McpServerEntry {
  id: string;
  config: McpServerConfig;
}

export function createMcpToolRegistry(config: McpConfig | undefined): McpToolRegistry | undefined {
  const servers = config?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }

  return new McpToolRegistry(servers);
}

export class McpToolRegistry {
  private readonly entries: McpServerEntry[];
  private readonly clients = new Map<string, Promise<Client>>();
  private toolsPromise: Promise<MastraToolsInput> | undefined;

  constructor(servers: Record<string, McpServerConfig>) {
    this.entries = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, config]) => ({ id, config }));
  }

  async getTools(): Promise<MastraToolsInput> {
    this.toolsPromise ??= this.loadTools().catch((error) => {
      this.toolsPromise = undefined;
      throw error;
    });

    return this.toolsPromise;
  }

  async getToolNames(): Promise<Set<string>> {
    const tools = await this.getTools();
    return new Set(Object.keys(tools));
  }

  private async loadTools(): Promise<MastraToolsInput> {
    const tools: MastraToolsInput = {};
    const usedNames = new Set<string>();

    for (const entry of this.entries) {
      const client = await this.getClient(entry);
      for (const mcpTool of await listAllTools(client, entry.config)) {
        const toolName = uniqueToolName(`${entry.id}__${mcpTool.name}`, usedNames);
        tools[toolName] = this.toMastraTool(entry, mcpTool, toolName);
      }
    }

    return tools;
  }

  private toMastraTool(entry: McpServerEntry, mcpTool: McpTool, toolName: string) {
    return createMastraTool({
      id: toolName,
      description: describeMcpTool(entry.id, mcpTool),
      inputSchema: toMastraToolSchema(mcpTool.inputSchema),
      execute: async (args) => {
        const client = await this.getClient(entry);
        const result = await client.callTool(
          {
            name: mcpTool.name,
            arguments: isRecord(args) ? args : {},
          },
          undefined,
          toRequestOptions(entry.config),
        );

        return formatMcpToolResult(result);
      },
    });
  }

  private getClient(entry: McpServerEntry): Promise<Client> {
    const existing = this.clients.get(entry.id);
    if (existing) {
      return existing;
    }

    const clientPromise = connectClient(entry).catch((error) => {
      this.clients.delete(entry.id);
      throw error;
    });
    this.clients.set(entry.id, clientPromise);
    return clientPromise;
  }
}

async function connectClient(entry: McpServerEntry): Promise<Client> {
  const client = new Client({
    name: `ai-chat-${entry.id}`,
    version: MCP_CLIENT_VERSION,
  });

  await client.connect(createTransport(entry.config), toRequestOptions(entry.config));
  return client;
}

function createTransport(config: McpServerConfig): Transport {
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
    return new SSEClientTransport(url, { requestInit });
  }

  return new StreamableHTTPClientTransport(url, { requestInit });
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

function toMastraToolSchema(value: unknown): MastraToolSchema {
  const schema = normalizeToolParameters(value);

  return {
    ...schema,
    type: "object" as const,
    properties: isRecord(schema.properties) ? schema.properties : {},
  } as MastraToolSchema;
}
