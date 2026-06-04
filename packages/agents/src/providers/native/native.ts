import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

import { agentSpecs, defaultAgentId, type AgentSpec } from "../../agents/index.ts";
import { AgentNotFoundError } from "../../errors.ts";
import {
  createLanguageModel,
  isLanguageModelConfigured,
  resolveLanguageModelConfig,
} from "../../models/index.ts";
import type {
  AgentConfig,
  AgentExecutionConfig,
  AgentProvider,
  AgentRunner,
  LanguageModelConfig,
  McpConfig,
} from "../../types.ts";
import { runNativeAgent } from "./loop.ts";
import { NativeToolset } from "./tools.ts";
import type { NativeLanguageModel } from "./types.ts";

interface NativeAgentOptions {
  languageModel: LanguageModelConfig & { apiKey: string };
  execution?: AgentExecutionConfig;
  mcp?: McpConfig;
}

/**
 * A "build-your-own" agent runner: no agent framework, just the raw model and a
 * hand-written agentic loop (see {@link runNativeAgent}). It mirrors the Mastra
 * provider's surface — same agent definitions, local tools, and MCP servers —
 * but drives the model directly via its `@ai-sdk/*` streaming interface and
 * emits AG-UI events itself.
 *
 * Tools available to the loop: local builtins, Agent Skills (with Claude
 * Code–style progressive disclosure — see {@link NativeToolset}), MCP server
 * tools, and client/HITL tools.
 */
export const nativeAgentProvider: AgentProvider = {
  id: "native",
  label: "Native Agent",
  description: "Self-built agent loop driving @ai-sdk models directly, no framework.",
  configurationHint:
    "Set MODEL_API_KEY to enable it (set AGENT_PROVIDER=native to select it over Mastra).",
  create: ({ config }) => createNativeAgentFromConfig(config),
};

function createNativeAgentFromConfig(config: AgentConfig): AgentRunner | undefined {
  const languageModel = config.languageModel;
  if (!isLanguageModelConfigured(languageModel)) {
    return undefined;
  }

  return createNativeAgent({
    languageModel,
    execution: config.execution,
    mcp: config.mcp,
  });
}

function createNativeAgent(options: NativeAgentOptions): AgentRunner {
  const baseConfig = resolveLanguageModelConfig(options.languageModel);
  const toolset = new NativeToolset(options.mcp);
  const skillsCatalog = toolset.skillsCatalog();
  const maxToolIterations = options.execution?.maxToolIterations;

  // One model instance per distinct model id, shared across runs. Agents may
  // override the model via their definition; everything else is inherited.
  const modelCache = new Map<string, NativeLanguageModel>();
  const modelForAgent = (spec: AgentSpec): NativeLanguageModel => {
    const modelId = spec.model ?? baseConfig.model;
    const cached = modelCache.get(modelId);
    if (cached) {
      return cached;
    }
    // `createLanguageModel().model` is the raw `@ai-sdk` LanguageModel object;
    // we only use its `doStream`, which the minimal interface captures.
    const model = createLanguageModel({ ...options.languageModel, model: modelId })
      .model as unknown as NativeLanguageModel;
    modelCache.set(modelId, model);
    return model;
  };

  const agentsById = new Map(agentSpecs.map((spec) => [spec.id, spec]));
  const agentIds = [...agentsById.keys()];

  return (input, runnerOptions): Observable<BaseEvent> => {
    const requestedAgentId = runnerOptions?.agentId;
    if (requestedAgentId && !agentsById.has(requestedAgentId)) {
      throw new AgentNotFoundError(requestedAgentId, agentIds);
    }
    const spec = agentsById.get(requestedAgentId ?? defaultAgentId);
    if (!spec) {
      throw new AgentNotFoundError(requestedAgentId ?? defaultAgentId, agentIds);
    }

    // The toolset resolves lazily (MCP connects on first use); fold that async
    // work into the run Observable so a connection failure surfaces as a run
    // error rather than throwing synchronously here.
    return new Observable<BaseEvent>((subscriber) => {
      let inner: { unsubscribe: () => void } | undefined;
      let cancelled = false;

      toolset.resolve().then(
        (serverTools) => {
          if (cancelled) {
            return;
          }
          inner = runNativeAgent({
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            clientTools: input.tools,
            context: input.context,
            persona: composePersona(spec.instructions, skillsCatalog),
            model: modelForAgent(spec),
            serverTools,
            maxToolIterations,
            compaction: options.execution?.contextCompaction,
          }).subscribe(subscriber);
        },
        (error) => {
          if (!cancelled) {
            subscriber.error(error);
          }
        },
      );

      return () => {
        cancelled = true;
        inner?.unsubscribe();
      };
    });
  };
}

/** Appends the Level-1 skill catalog to the agent's persona for the system prompt. */
function composePersona(
  instructions: string | undefined,
  skillsCatalog: string | undefined,
): string | undefined {
  const parts = [instructions, skillsCatalog].filter((part): part is string =>
    Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
