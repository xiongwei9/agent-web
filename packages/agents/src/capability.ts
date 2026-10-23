import type { FrontendTool, ServerTool } from "./tools/types.ts";

/**
 * One thing the agent can do — the builtin tools, Agent Skills, MCP servers,
 * A2UI surfaces, the Human-in-the-Loop prompts — described by what it adds to
 * a run. `agent.ts` composes a list of these; the loop and the prompt builder
 * only ever see the merged result, so adding a capability touches nothing else.
 *
 * Every method is called once per run, so a capability may change between
 * runs (MCP servers connect, or start waiting for authorization).
 */
export interface AgentCapability {
  /** A section appended to the system prompt. */
  systemPrompt?(): string | undefined;
  /** Tools the loop executes itself. */
  serverTools?(): ServerTool[] | Promise<ServerTool[]>;
  /**
   * Tools declared to the model but fulfilled by the client: calling one
   * suspends the run until the client resumes it with the result.
   */
  clientTools?(): FrontendTool[];
  /**
   * Rewrites a user message's text before the model sees it, e.g. to expand
   * a `/skill-name` command; undefined leaves it alone. The client keeps the
   * text as typed, so this runs on every user message in every run and must
   * give the same result each time.
   */
  userText?(text: string): string | undefined;
}
