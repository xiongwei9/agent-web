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
import { composeHandoffGuidance, type HandoffTarget, type RunnableAgent } from "./handoff.ts";
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

  // Resolves a spec's declared handoff ids to runnable-ready targets, dropping
  // self-references and unknown ids (logged once) so a typo never produces a
  // dead transfer tool.
  const resolveHandoffTargets = (spec: AgentSpec): HandoffTarget[] => {
    const targets: HandoffTarget[] = [];
    for (const targetId of spec.handoffs ?? []) {
      if (targetId === spec.id) {
        continue;
      }
      const target = agentsById.get(targetId);
      if (!target) {
        console.warn(
          `[native-agent] agent "${spec.id}" lists unknown handoff target "${targetId}"; ignoring.`,
        );
        continue;
      }
      targets.push({
        id: target.id,
        name: target.name ?? target.id,
        description: target.description,
      });
    }
    return targets;
  };

  // One runnable view per agent (persona + model + handoff targets), built on
  // first use and shared across runs. Handoffs resolve targets through here too,
  // so a swapped-in agent reuses the same cached model instance.
  const runnableCache = new Map<string, RunnableAgent>();
  const getRunnableAgent = (spec: AgentSpec): RunnableAgent => {
    const cached = runnableCache.get(spec.id);
    if (cached) {
      return cached;
    }
    const handoffTargets = resolveHandoffTargets(spec);
    const runnable: RunnableAgent = {
      id: spec.id,
      name: spec.name ?? spec.id,
      persona: composePersona(spec.instructions, skillsCatalog, handoffTargets),
      model: modelForAgent(spec),
      handoffs: handoffTargets,
    };
    runnableCache.set(spec.id, runnable);
    return runnable;
  };
  const resolveAgent = (agentId: string): RunnableAgent | undefined => {
    const targetSpec = agentsById.get(agentId);
    return targetSpec ? getRunnableAgent(targetSpec) : undefined;
  };

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
            agent: getRunnableAgent(spec),
            resolveAgent,
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

/**
 * Builds an agent's system prompt by appending the Level-1 skill catalog and,
 * when the agent declares handoff targets, the "# Handoff" guidance listing the
 * peers it may transfer to.
 */
function composePersona(
  instructions: string | undefined,
  skillsCatalog: string | undefined,
  handoffTargets: HandoffTarget[],
): string | undefined {
  const parts = [instructions, skillsCatalog, composeHandoffGuidance(handoffTargets)].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
