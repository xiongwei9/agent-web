import { MastraAgent as AGUIMastraAgent } from "@ag-ui/mastra";
import type { BaseEvent } from "@ag-ui/client";
import type { Context, RunAgentInput } from "@ag-ui/core";
import { Mastra } from "@mastra/core";
import { Agent as LocalMastraAgent, type ToolsInput as MastraToolsInput } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { PublicSchema } from "@mastra/core/schema";
import { createTool as createMastraTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { from, mergeMap, type Observable } from "rxjs";

import { LocalSkillSource, Workspace } from "@mastra/core/workspace";

import { agentSpecs, defaultAgentId, type AgentSpec } from "../../agents/index.ts";
import { SKILLS_BASE_PATH, SKILL_DEFINITION_PATHS } from "../../skills/index.ts";
import { AgentNotFoundError } from "../../errors.ts";
import type {
  AgentConfig,
  AgentExecutionConfig,
  AgentProvider,
  AgentRunner,
  LanguageModelConfig,
  MastraProviderConfig,
  McpConfig,
} from "../../types.ts";
import {
  createLanguageModel,
  isLanguageModelConfigured,
  resolveLanguageModelConfig,
  type ResolvedLanguageModelConfig,
} from "../../models/index.ts";
import { createMcpToolRegistry, type McpToolRegistry } from "./mcp.ts";
import { contextToText, isRecord, localAgentTools, normalizeToolParameters } from "../shared.ts";

const AGUI_CONTEXT_KEY = "ag-ui";

type MastraToolSchema = PublicSchema<Record<string, unknown>>;

type ModelBackedAgentOptions = LanguageModelConfig & {
  apiKey: string;
  execution?: AgentExecutionConfig;
  mastra?: MastraProviderConfig;
  mcp?: McpConfig;
};

export const mastraAgentProvider: AgentProvider = {
  id: "mastra",
  label: "Mastra Agent",
  description: "Mastra agent runner via @ag-ui/mastra adapter.",
  configurationHint:
    "Set MODEL_API_KEY to enable it. Optionally set MASTRA_STORAGE_URL for persistent memory/HITL.",
  create: ({ config }) => createMastraAgentFromConfig(config),
};

function createMastraAgent(options: ModelBackedAgentOptions): AgentRunner {
  const languageModel = resolveLanguageModelConfig(options);
  const defaultModel = languageModel.model;
  const mcpTools = createMcpToolRegistry(options.mcp);

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

  const agents: Record<string, LocalMastraAgent> = {};
  for (const spec of agentSpecs) {
    agents[spec.id] = buildLocalAgent({
      spec,
      defaultModel,
      languageModel,
      memory,
      mcpTools,
      execution: options.execution,
    });
  }
  const agentIds = Object.keys(agents);

  // One Mastra instance per provider (per process). Keeps storage, agent
  // registry, and memory long-lived; per-request work happens in the runner
  // below via MastraAgent.getLocalAgent.
  //
  // Agent Skills are handled by Mastra's native workspace support: the workspace
  // discovers SKILL.md folders under the skills package and every agent inherits
  // it, automatically gaining the `skill` / `skill_search` / `skill_read` tools
  // and a system-message catalog. The skills package owns only the documents;
  // this provider does the framework-specific wiring.
  const mastra = new Mastra({
    agents,
    workspace: createSkillsWorkspace(),
    ...(storage ? { storage } : {}),
  });

  return (input, runnerOptions): Observable<BaseEvent> => {
    const requestContext = new RequestContext();
    if (runnerOptions?.requestContext) {
      for (const [key, value] of Object.entries(runnerOptions.requestContext)) {
        requestContext.set(key, value);
      }
    }

    const requestedAgentId = runnerOptions?.agentId;
    if (requestedAgentId && !agents[requestedAgentId]) {
      throw new AgentNotFoundError(requestedAgentId, agentIds);
    }
    const agentId = requestedAgentId ?? defaultAgentId;

    const aguiAgent = AGUIMastraAgent.getLocalAgent({
      mastra,
      agentId,
      resourceId: runnerOptions?.resourceId ?? input.threadId,
      requestContext,
    });

    // Tools we execute server-side via Mastra's tool registry must not be
    // re-sent as clientTools — otherwise Mastra would emit AG-UI tool calls
    // for them and stall waiting on the client to respond.
    return from(getServerSideToolNames(mcpTools)).pipe(
      mergeMap((serverSideToolNames) => {
        const filteredInput: RunAgentInput = {
          ...input,
          tools: input.tools.filter((tool) => !serverSideToolNames.has(tool.name)),
        };

        return aguiAgent.run(filteredInput);
      }),
    );
  };
}

function buildLocalAgent(args: {
  spec: AgentSpec;
  defaultModel: string;
  languageModel: ResolvedLanguageModelConfig;
  memory: Memory | undefined;
  mcpTools: McpToolRegistry | undefined;
  execution: AgentExecutionConfig | undefined;
}): LocalMastraAgent {
  const { spec, defaultModel, languageModel, memory, mcpTools, execution } = args;
  const persona = spec.instructions;
  const defaultOptions = execution?.maxToolIterations
    ? { maxSteps: execution.maxToolIterations }
    : undefined;

  return new LocalMastraAgent({
    id: spec.id,
    name: spec.name ?? spec.id,
    instructions: async ({ requestContext }) => {
      const aguiCtx = requestContext.get(AGUI_CONTEXT_KEY);
      const ctxText =
        isRecord(aguiCtx) && Array.isArray(aguiCtx.context)
          ? contextToText(aguiCtx.context as Context[])
          : undefined;
      if (persona) {
        return ctxText ? `${persona}\n\n${ctxText}` : persona;
      }
      return ctxText ?? "You are a helpful assistant.";
    },
    model: createLanguageModel({
      ...languageModel,
      model: spec.model ?? defaultModel,
    }).model,
    tools: mcpTools
      ? async () => ({
          ...toMastraLocalTools(),
          ...(await mcpTools.getTools()),
        })
      : toMastraLocalTools(),
    ...(defaultOptions ? { defaultOptions, defaultStreamOptionsLegacy: defaultOptions } : {}),
    ...(memory ? { memory } : {}),
  });
}

/**
 * Builds the Mastra workspace that exposes Agent Skills. It scans the skills
 * package's `definitions/` folders for `SKILL.md` files via a read-only
 * `LocalSkillSource` — no full workspace filesystem is needed. If there are no
 * skill folders, Mastra simply registers no skill tools.
 */
function createSkillsWorkspace(): Workspace {
  return new Workspace({
    skillSource: new LocalSkillSource({ basePath: SKILLS_BASE_PATH }),
    skills: [...SKILL_DEFINITION_PATHS],
  });
}

function createMastraAgentFromConfig(config: AgentConfig): AgentRunner | undefined {
  const languageModel = config.languageModel;
  if (!isLanguageModelConfigured(languageModel)) {
    return undefined;
  }

  return createMastraAgent({
    apiKey: languageModel.apiKey,
    provider: languageModel.provider,
    baseURL: languageModel.baseURL,
    headers: languageModel.headers,
    model: languageModel.model,
    api: languageModel.api,
    execution: config.execution,
    mastra: config.mastra,
    mcp: config.mcp,
  });
}

async function getServerSideToolNames(mcpTools: McpToolRegistry | undefined): Promise<Set<string>> {
  const names = new Set(localAgentTools.keys());
  if (mcpTools) {
    for (const name of await mcpTools.getToolNames()) {
      names.add(name);
    }
  }

  return names;
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
