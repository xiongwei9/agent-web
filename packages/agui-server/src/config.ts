import {
  AGENT_PROVIDER_SELECTIONS,
  AUTO_AGENT_PROVIDER,
  LANGUAGE_MODEL_PROVIDERS,
  isAgentProviderSelection,
  type AgentConfig,
  type AgentProviderSelection,
  type LanguageModelProvider,
  type McpConfig,
  type McpServerConfig,
  type OpenAIModelApi,
} from "@ai-chat/agents";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_PORT = 3000;

export interface AppConfig {
  agent: AgentConfig;
  host: string;
  logLevel: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: emptyToUndefined(env.HOST) ?? DEFAULT_HOST,
    port: readPort(env.PORT, DEFAULT_PORT),
    logLevel: emptyToUndefined(env.LOG_LEVEL) ?? DEFAULT_LOG_LEVEL,
    agent: {
      provider: readAgentProvider(env.AGENT_PROVIDER),
      languageModel: {
        provider: readLanguageModelProvider(env.MODEL_PROVIDER),
        api: readLanguageModelApi(env.MODEL_API),
        apiKey: emptyToUndefined(env.MODEL_API_KEY),
        baseURL: emptyToUndefined(env.MODEL_BASE_URL),
        model: emptyToUndefined(env.MODEL_NAME),
      },
      execution: {
        maxToolIterations: readOptionalPositiveInteger(env.AGENT_MAX_TOOL_ITERATIONS),
      },
      mastra: {
        storageUrl: emptyToUndefined(env.MASTRA_STORAGE_URL),
      },
      mcp: readMcpConfig(env.MCP_SERVERS),
      agno: {
        baseURL: emptyToUndefined(env.AGNO_BASE_URL),
        path: emptyToUndefined(env.AGNO_PATH),
      },
    },
  };
}

function readLanguageModelProvider(value: string | undefined): LanguageModelProvider | undefined {
  const provider = emptyToUndefined(value);
  if (!provider) {
    return undefined;
  }

  const normalized = provider === "openai_compatible" ? "openai-compatible" : provider;
  if ((LANGUAGE_MODEL_PROVIDERS as readonly string[]).includes(normalized)) {
    return normalized as LanguageModelProvider;
  }

  throw new Error(
    `Unsupported MODEL_PROVIDER "${provider}". Supported values: ${LANGUAGE_MODEL_PROVIDERS.join(", ")}`,
  );
}

function readLanguageModelApi(value: string | undefined): OpenAIModelApi | undefined {
  const api = emptyToUndefined(value);
  if (!api) {
    return undefined;
  }
  if (api === "responses" || api === "chat") {
    return api;
  }

  throw new Error(`Unsupported MODEL_API "${api}". Supported values: responses, chat`);
}

function readMcpConfig(value: string | undefined): McpConfig | undefined {
  const raw = emptyToUndefined(value);
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid MCP_SERVERS JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const serversValue =
    isRecord(parsed) && isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed) && isRecord(parsed.servers)
        ? parsed.servers
        : parsed;

  if (!isRecord(serversValue)) {
    throw new Error("Invalid MCP_SERVERS: expected a JSON object of MCP server configs.");
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [serverId, serverValue] of Object.entries(serversValue)) {
    if (!serverId.trim()) {
      throw new Error("Invalid MCP_SERVERS: server ids must be non-empty strings.");
    }
    servers[serverId] = readMcpServerConfig(serverId, serverValue);
  }

  return { servers };
}

function readMcpServerConfig(serverId: string, value: unknown): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP server "${serverId}": expected an object.`);
  }

  const transport = readMcpTransport(value);
  const timeoutMs = readOptionalPositiveIntegerValue(value.timeoutMs);

  if (transport === "stdio") {
    const command = readRequiredString(value.command, `MCP server "${serverId}" command`);
    return {
      transport: "stdio",
      command,
      args: readOptionalStringArray(value.args, `MCP server "${serverId}" args`),
      env: readOptionalStringRecord(value.env, `MCP server "${serverId}" env`),
      cwd: readOptionalString(value.cwd),
      timeoutMs,
    };
  }

  const url = readRequiredString(value.url, `MCP server "${serverId}" url`);
  return {
    transport,
    url,
    headers: readOptionalStringRecord(value.headers, `MCP server "${serverId}" headers`),
    timeoutMs,
  };
}

function readMcpTransport(value: Record<string, unknown>): "stdio" | "http" | "sse" {
  const rawTransport = readOptionalString(value.transport ?? value.type);
  if (rawTransport) {
    if (rawTransport === "stdio" || rawTransport === "http" || rawTransport === "sse") {
      return rawTransport;
    }
    if (rawTransport === "streamable-http" || rawTransport === "streamable_http") {
      return "http";
    }
    throw new Error(
      `Invalid MCP server transport "${rawTransport}". Supported values: stdio, http, sse.`,
    );
  }

  if (typeof value.command === "string") {
    return "stdio";
  }
  if (typeof value.url === "string") {
    return "http";
  }

  throw new Error(
    'Invalid MCP server config: expected either "command" for stdio or "url" for HTTP/SSE.',
  );
}

function readAgentProvider(value: string | undefined): AgentProviderSelection {
  const provider = emptyToUndefined(value);
  if (!provider) {
    return AUTO_AGENT_PROVIDER;
  }

  if (isAgentProviderSelection(provider)) {
    return provider;
  }

  throw new Error(
    `Unsupported AGENT_PROVIDER "${provider}". Supported values: ${AGENT_PROVIDER_SELECTIONS.join(", ")}`,
  );
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed;
  }

  return fallback;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
}

function readOptionalPositiveIntegerValue(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function readRequiredString(value: unknown, label: string): string {
  const result = readOptionalString(value);
  if (!result) {
    throw new Error(`Invalid MCP_SERVERS: ${label} must be a non-empty string.`);
  }

  return result;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid MCP_SERVERS: ${label} must be an array of strings.`);
  }

  return value;
}

function readOptionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP_SERVERS: ${label} must be an object of strings.`);
  }

  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== "string") {
      throw new Error(`Invalid MCP_SERVERS: ${label}.${key} must be a string.`);
    }
    result[key] = candidate;
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
