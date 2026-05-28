import {
  AGENT_PROVIDER_SELECTIONS,
  AUTO_AGENT_PROVIDER,
  isAgentProviderSelection,
  type AgentConfig,
  type AgentProviderSelection,
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
        apiKey: emptyToUndefined(env.OPENAI_API_KEY),
        baseURL: emptyToUndefined(env.OPENAI_BASE_URL),
        model: emptyToUndefined(env.OPENAI_MODEL),
      },
      execution: {
        maxToolIterations: readOptionalPositiveInteger(
          env.AGENT_MAX_TOOL_ITERATIONS ?? env.OPENAI_MAX_TOOL_ITERATIONS,
        ),
      },
      mastra: {
        storageUrl: emptyToUndefined(env.MASTRA_STORAGE_URL),
      },
      agno: {
        baseURL: emptyToUndefined(env.AGNO_BASE_URL),
        path: emptyToUndefined(env.AGNO_PATH),
      },
    },
  };
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

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}
