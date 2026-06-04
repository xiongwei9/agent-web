/**
 * Framework-agnostic description of an agent — just identity and persona.
 * Providers (Mastra, agno, …) map this onto their own agent shape; nothing
 * here should leak runtime concerns like tools, memory, or transport.
 */
export interface AgentSpec {
  /** Stable id used to address this agent at runtime. Must be unique. */
  id: string;
  /** Display name. Defaults to `id` if a provider needs one. */
  name?: string;
  /**
   * One-line summary of what this agent is good for. Surfaced to other agents
   * as the rationale on their `transfer_to_<id>` handoff tool, so peers know
   * when to delegate. Optional; falls back to the display name.
   */
  description?: string;
  /** System prompt / persona for this agent. */
  instructions?: string;
  /**
   * Suggested model id (e.g. `gpt-4o-mini`). Providers may honor it as an
   * override on top of their default model, or ignore it when the provider's
   * runtime selects the model elsewhere.
   */
  model?: string;
  /**
   * Ids of agents this agent may hand the conversation off to. The native
   * provider turns each into a `transfer_to_<id>` tool; when the model calls
   * one, that agent takes over the run (its persona, model, and own handoff
   * set) with the conversation history preserved. Unknown ids are ignored.
   */
  handoffs?: string[];
}
