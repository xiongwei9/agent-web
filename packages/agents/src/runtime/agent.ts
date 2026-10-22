import { readFileSync } from "node:fs";

import type { BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";

import type { Agent, AgentConfig } from "../types.ts";
import { a2uiSystemPromptSection } from "./a2ui.ts";
import { hitlSystemPromptSection } from "./hitl.ts";
import { runAgentLoop } from "./loop.ts";
import { createLanguageModel, resolveLanguageModelConfig } from "./model.ts";
import { Toolset } from "./tools.ts";

/**
 * Default system prompt, edited in `src/system-prompt.md`. The build script
 * copies it next to the compiled output so this relative URL resolves there too.
 */
const DEFAULT_SYSTEM_PROMPT_URL = new URL("../system-prompt.md", import.meta.url);

/**
 * Builds the agent: no agent framework, just the raw model and a
 * hand-written agentic loop (see {@link runAgentLoop}) that drives the model via
 * its `@ai-sdk/*` streaming interface and emits AG-UI events itself.
 *
 * Tools available to the loop: local builtins, Agent Skills (with Claude
 * Code–style progressive disclosure — see {@link Toolset}), MCP server tools,
 * and client-fulfilled tools — A2UI surfaces, the Human-in-the-Loop prompts,
 * and whatever the request declares in `RunAgentInput.tools`.
 *
 * `mcp` exposes the MCP servers' connection state and OAuth flow to the app.
 *
 * Throws at construction when `config.languageModel.apiKey` is missing, so a
 * misconfigured server fails at startup rather than on the first request.
 */
export function createAgent(config: AgentConfig = {}): Agent {
  const model = createLanguageModel(resolveLanguageModelConfig(config.languageModel ?? {}));
  const toolset = new Toolset(config.mcp);
  const persona = composePersona(
    config.systemPrompt ?? readFileSync(DEFAULT_SYSTEM_PROMPT_URL, "utf8"),
    toolset.skillsCatalog(),
  );
  const execution = config.execution;

  const run = (input: Parameters<Agent["run"]>[0]): Observable<BaseEvent> => {
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
          inner = runAgentLoop({
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            clientTools: input.tools,
            context: input.context,
            persona,
            model,
            serverTools,
            maxToolIterations: execution?.maxToolIterations,
            compaction: execution?.contextCompaction,
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

  return { run, mcp: toolset.mcp };
}

/**
 * Composes the full system prompt: the configured instructions, the Level-1 skill
 * catalog, the A2UI authoring guide (so it can render generative UI via the
 * `render_a2ui` tool), and the Human-in-the-Loop guide (so it knows when to stop
 * and ask the user rather than guess or act unilaterally).
 */
function composePersona(
  instructions: string,
  skillsCatalog: string | undefined,
): string | undefined {
  const parts = [
    instructions,
    skillsCatalog,
    a2uiSystemPromptSection(),
    hitlSystemPromptSection(),
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
