import { resolve } from "node:path";

import {
  createFileMcpOAuthStore,
  LANGUAGE_MODEL_PROVIDERS,
  type AgentConfig,
  type CodeModeConfig,
  type LanguageModelProvider,
  type McpConfig,
  type McpOAuthConfig,
  type McpOAuthStore,
  type McpServerConfig,
  type OpenAIModelApi,
} from "@ai-chat/agents";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_PORT = 3000;
const MCP_OAUTH_CLIENT_NAME = "ai-chat";
const DEFAULT_MCP_OAUTH_STORE_PATH = ".mcp-oauth.json";
const MCP_OAUTH_AUTHORIZATION_HINT =
  'In this app the user authorizes it with the "Authorize" button on the banner above the chat.';
export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

const DEFAULT_SESSION_SECRET_PATH = ".session-secret";

export interface AppConfig {
  agent: AgentConfig;
  host: string;
  logLevel: string;
  port: number;
  session: {
    /** `SESSION_SECRET`; when unset, one is generated and kept in `secretPath`. */
    secret: string | undefined;
    secretPath: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPort(env.PORT, DEFAULT_PORT);
  return {
    host: emptyToUndefined(env.HOST) ?? DEFAULT_HOST,
    port,
    session: {
      secret: emptyToUndefined(env.SESSION_SECRET),
      secretPath: resolve(DEFAULT_SESSION_SECRET_PATH),
    },
    logLevel: emptyToUndefined(env.LOG_LEVEL) ?? DEFAULT_LOG_LEVEL,
    agent: {
      systemPrompt: emptyToUndefined(env.SYSTEM_PROMPT),
      languageModel: {
        provider: readLanguageModelProvider(env.MODEL_PROVIDER),
        api: readLanguageModelApi(env.MODEL_API),
        apiKey: emptyToUndefined(env.MODEL_API_KEY),
        baseURL: emptyToUndefined(env.MODEL_BASE_URL),
        model: emptyToUndefined(env.MODEL_NAME),
        contextWindow: readOptionalPositiveInteger(env.MODEL_CONTEXT_WINDOW),
        headers: readModelHeaders(env.MODEL_HEADERS),
      },
      execution: {
        maxToolIterations: readOptionalPositiveInteger(env.AGENT_MAX_TOOL_ITERATIONS),
      },
      codeMode: {
        enabled: readBoolean(env.AGENT_CODE_MODE, "AGENT_CODE_MODE"),
        timeoutMs: readOptionalPositiveInteger(env.AGENT_CODE_MODE_TIMEOUT_MS),
        toolDiscovery: readToolDiscovery(env.AGENT_CODE_MODE_TOOL_DISCOVERY),
      },
      mcp: readMcpConfig(env.MCP_SERVERS, {
        redirectUrl: readMcpOAuthRedirectUrl(env, port),
        clientName: MCP_OAUTH_CLIENT_NAME,
        authorizationHint: MCP_OAUTH_AUTHORIZATION_HINT,
        store: readMcpOAuthStore(env.MCP_OAUTH_STORE_PATH),
      }),
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

function readModelHeaders(value: string | undefined): Record<string, string> | undefined {
  const raw = emptyToUndefined(value);
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid MODEL_HEADERS JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed) || Object.values(parsed).some((header) => typeof header !== "string")) {
    throw new Error("Invalid MODEL_HEADERS: expected a JSON object of string header values.");
  }

  return parsed as Record<string, string>;
}

/**
 * Where MCP authorization servers send the user back (see `routes/mcp.ts`).
 * Defaults to this server's own callback on localhost.
 */
function readMcpOAuthRedirectUrl(env: NodeJS.ProcessEnv, port: number): string {
  const value = emptyToUndefined(env.MCP_OAUTH_REDIRECT_URL);
  if (!value) {
    return `http://localhost:${port}${MCP_OAUTH_CALLBACK_PATH}`;
  }
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`Invalid MCP_OAUTH_REDIRECT_URL: "${value}" is not an absolute URL.`);
  }
}

/**
 * Where MCP OAuth tokens persist, so a restart (e.g. `--watch` on every edit)
 * doesn't mean authorizing again. Relative to the working directory; `off`
 * keeps them in memory only.
 */
function readMcpOAuthStore(value: string | undefined): McpOAuthStore | undefined {
  const path = emptyToUndefined(value) ?? DEFAULT_MCP_OAUTH_STORE_PATH;
  return path === "off" ? undefined : createFileMcpOAuthStore(resolve(path));
}

function readMcpConfig(value: string | undefined, oauth: McpOAuthConfig): McpConfig | undefined {
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

  return { servers, oauth };
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

const TRUE_VALUES = ["1", "true", "on", "yes"];
const FALSE_VALUES = ["0", "false", "off", "no"];

/** An on/off switch; unset means off. Anything unrecognized fails startup. */
function readBoolean(value: string | undefined, name: string): boolean {
  const normalized = emptyToUndefined(value)?.trim().toLowerCase();
  if (normalized === undefined || FALSE_VALUES.includes(normalized)) {
    return false;
  }
  if (TRUE_VALUES.includes(normalized)) {
    return true;
  }
  throw new Error(
    `Invalid ${name} "${value}". Supported values: ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}`,
  );
}

/**
 * Code mode's tool discovery: on → the model looks tools up with
 * `search_tools`; off → every declaration is inlined; unset or `auto` →
 * decided by how long the declarations are.
 */
function readToolDiscovery(value: string | undefined): CodeModeConfig["toolDiscovery"] {
  const normalized = emptyToUndefined(value)?.trim().toLowerCase();
  if (normalized === undefined || normalized === "auto") {
    return "auto";
  }
  if (TRUE_VALUES.includes(normalized)) {
    return "search";
  }
  if (FALSE_VALUES.includes(normalized)) {
    return "inline";
  }
  throw new Error(
    `Invalid AGENT_CODE_MODE_TOOL_DISCOVERY "${value}". Supported values: auto, ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}`,
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
