import { readFileSync } from "node:fs";

import type { BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";

import type { AgentCapability } from "./capability.ts";
import { a2uiCapability } from "./client-tools/a2ui.ts";
import { hitlCapability } from "./client-tools/hitl.ts";
import { CompactionCache, resolveCompactionOptions } from "./loop/compaction.ts";
import { runAgentLoop } from "./loop/loop.ts";
import { mcpCapability } from "./mcp/capability.ts";
import { createMcpConnections } from "./mcp/users.ts";
import { createLanguageModel, resolveLanguageModelConfig } from "./model/model.ts";
import { consoleLogger } from "./shared/logger.ts";
import { joinSections } from "./shared/utils.ts";
import { SkillsToolset } from "./skills/toolset.ts";
import { builtinCapability } from "./tools/builtin.ts";
import { resolveRunTools } from "./tools/toolset.ts";
import type { Agent, AgentConfig, RunContext } from "./types.ts";

/**
 * Default system prompt, edited in `src/system-prompt.md`. The build script
 * copies it next to the compiled output so this relative URL resolves there too.
 */
const DEFAULT_SYSTEM_PROMPT_URL = new URL("./system-prompt.md", import.meta.url);

/**
 * Builds the agent: no agent framework, just the raw model and a
 * hand-written agentic loop (see {@link runAgentLoop}) that drives the model via
 * its `@ai-sdk/*` streaming interface and emits AG-UI events itself.
 *
 * This is the one place that knows which capabilities exist (see
 * {@link AgentCapability}): local builtins, Agent Skills (Claude Code–style
 * progressive disclosure), MCP server tools, A2UI surfaces, and the
 * Human-in-the-Loop prompts. The loop also offers the client tools a request
 * declares in `RunAgentInput.tools`.
 *
 * `mcp` exposes the MCP servers' connection state and OAuth flow to the app.
 * Both are per user: a run's `context.userId` picks whose MCP connections and
 * tokens it uses.
 *
 * Throws at construction when `config.languageModel.apiKey` is missing, so a
 * misconfigured server fails at startup rather than on the first request.
 */
export function createAgent(config: AgentConfig = {}): Agent {
  const modelConfig = resolveLanguageModelConfig(config.languageModel ?? {});
  const model = createLanguageModel(modelConfig);
  const logger = config.logger ?? consoleLogger;
  const instructions = config.systemPrompt ?? readFileSync(DEFAULT_SYSTEM_PROMPT_URL, "utf8");
  const execution = config.execution;
  const compaction = resolveCompactionOptions(
    execution?.contextCompaction,
    modelConfig.contextWindow,
  );
  const compactionCache = new CompactionCache();

  const mcp = createMcpConnections(config.mcp, { logger });
  // Order matters: it's the order of the system-prompt sections, and a later
  // capability's server tool wins a name clash.
  const shared: AgentCapability[] = [
    builtinCapability(),
    new SkillsToolset(),
    a2uiCapability(),
    hitlCapability(),
  ];
  const capabilitiesFor = (userId: string | undefined): AgentCapability[] =>
    mcp ? [...shared, mcpCapability(mcp.forUser(userId))] : shared;

  const run = (input: Parameters<Agent["run"]>[0], context?: RunContext): Observable<BaseEvent> => {
    // Capabilities resolve per run (MCP connects on first use); fold that async
    // work into the run Observable so a failure surfaces as a run error rather
    // than throwing synchronously here.
    return new Observable<BaseEvent>((subscriber) => {
      let inner: { unsubscribe: () => void } | undefined;
      let cancelled = false;

      resolveRunTools(capabilitiesFor(context?.userId)).then(
        (tools) => {
          if (cancelled) {
            return;
          }
          inner = runAgentLoop({
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            clientTools: input.tools,
            context: input.context,
            persona: joinSections([instructions, tools.systemPrompt]),
            model,
            serverTools: tools.serverTools,
            frontendTools: tools.frontendTools,
            maxToolIterations: execution?.maxToolIterations,
            compaction,
            compactionCache,
            logger,
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

  return { run, mcp };
}
