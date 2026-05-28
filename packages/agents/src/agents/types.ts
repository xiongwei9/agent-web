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
  /** System prompt / persona for this agent. */
  instructions?: string;
  /**
   * Suggested model id (e.g. `gpt-4o-mini`). Providers may honor it as an
   * override on top of their default model, or ignore it when the provider's
   * runtime selects the model elsewhere.
   */
  model?: string;
}
