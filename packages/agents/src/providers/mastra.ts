import { createOpenAI } from "@ai-sdk/openai";
import { MastraAgent as AGUIMastraAgent } from "@ag-ui/mastra";
import type { BaseEvent } from "@ag-ui/client";
import type { Context, RunAgentInput } from "@ag-ui/core";
import { Mastra } from "@mastra/core";
import {
  Agent as LocalMastraAgent,
  type ToolsInput as MastraToolsInput,
} from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { PublicSchema } from "@mastra/core/schema";
import { createTool as createMastraTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import type { Observable } from "rxjs";

import type {
  AgentConfig,
  AgentProvider,
  AgentRunner,
  LanguageModelConfig,
  MastraProviderConfig,
} from "../types.js";
import {
  contextToText,
  DEFAULT_OPENAI_MODEL,
  isRecord,
  localAgentTools,
  normalizeToolParameters,
} from "./shared.js";

const AGENT_ID = "agui-mastra-agent";
const AGUI_CONTEXT_KEY = "ag-ui";

type MastraToolSchema = PublicSchema<Record<string, unknown>>;

type ModelBackedAgentOptions = LanguageModelConfig & {
  apiKey: string;
  mastra?: MastraProviderConfig;
};

export const mastraAgentProvider: AgentProvider = {
  id: "mastra",
  label: "Mastra Agent",
  description: "Mastra agent runner via @ag-ui/mastra adapter.",
  configurationHint:
    "Set OPENAI_API_KEY to enable it. Optionally set MASTRA_STORAGE_URL for persistent memory/HITL.",
  create: ({ config }) => createMastraAgentFromConfig(config),
};

function createMastraAgent(options: ModelBackedAgentOptions): AgentRunner {
  const openai = createOpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
  const model = options.model ?? DEFAULT_OPENAI_MODEL;

  const storageUrl = options.mastra?.storageUrl;
  const storage = storageUrl
    ? new LibSQLStore({ id: "agui-mastra-storage", url: storageUrl })
    : undefined;
  const memory = storage
    ? new Memory({
        storage,
        options: { workingMemory: { enabled: true } },
      })
    : undefined;

  const localAgent = new LocalMastraAgent({
    id: AGENT_ID,
    name: "AG-UI Mastra Agent",
    instructions: async ({ requestContext }) => {
      const aguiCtx = requestContext.get(AGUI_CONTEXT_KEY);
      const ctxText =
        isRecord(aguiCtx) && Array.isArray(aguiCtx.context)
          ? contextToText(aguiCtx.context as Context[])
          : undefined;
      return ctxText ?? "You are a helpful assistant.";
    },
    model: openai(model),
    tools: toMastraLocalTools(),
    ...(memory ? { memory } : {}),
  });

  // One Mastra instance per provider (per process). Keeps storage, agent
  // registry, and memory long-lived; per-request work happens in the runner
  // below via MastraAgent.getLocalAgent.
  const mastra = new Mastra({
    agents: { [AGENT_ID]: localAgent },
    ...(storage ? { storage } : {}),
  });

  return (input, runnerOptions): Observable<BaseEvent> => {
    const requestContext = new RequestContext();
    if (runnerOptions?.requestContext) {
      for (const [key, value] of Object.entries(runnerOptions.requestContext)) {
        requestContext.set(key, value);
      }
    }

    const aguiAgent = AGUIMastraAgent.getLocalAgent({
      mastra,
      agentId: AGENT_ID,
      resourceId: runnerOptions?.resourceId ?? input.threadId,
      requestContext,
    });

    // Tools we execute server-side via Mastra's tool registry must not be
    // re-sent as clientTools — otherwise Mastra would emit AG-UI tool calls
    // for them and stall waiting on the client to respond.
    const filteredInput: RunAgentInput = {
      ...input,
      tools: input.tools.filter((tool) => !localAgentTools.has(tool.name)),
    };

    return aguiAgent.run(filteredInput);
  };
}

function createMastraAgentFromConfig(
  config: AgentConfig,
): AgentRunner | undefined {
  const languageModel = config.languageModel;
  if (!languageModel?.apiKey) {
    return undefined;
  }

  return createMastraAgent({
    apiKey: languageModel.apiKey,
    baseURL: languageModel.baseURL,
    model: languageModel.model,
    mastra: config.mastra,
  });
}

function toMastraLocalTools(): MastraToolsInput {
  const tools: MastraToolsInput = {};

  for (const localTool of localAgentTools.values()) {
    tools[localTool.name] = createMastraTool({
      id: localTool.name,
      description: localTool.description,
      inputSchema: toMastraToolSchema(localTool.parameters),
      execute: async (args) => localTool.execute(args),
    });
  }

  return tools;
}

function toMastraToolSchema(value: unknown): MastraToolSchema {
  const schema = normalizeToolParameters(value);

  return {
    ...schema,
    type: "object" as const,
    properties: isRecord(schema.properties) ? schema.properties : {},
  } as MastraToolSchema;
}
