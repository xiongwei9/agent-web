import { agnoAgentProvider } from "./agno/agno.ts";
import { mastraAgentProvider } from "./mastra/mastra.ts";
import { nativeAgentProvider } from "./native/native.ts";
import type { AgentProvider } from "../types.ts";

export { type AgentProviderSelection, AUTO_AGENT_PROVIDER, type AgentProviderId } from "./ids.ts";

// Order matters for the "auto" provider: the first one that configures wins.
// `native` shares the same trigger as `mastra` (MODEL_API_KEY), so it's listed
// last to keep Mastra the default; select it explicitly with AGENT_PROVIDER=native.
export const agentProviders: AgentProvider[] = [
  mastraAgentProvider,
  agnoAgentProvider,
  nativeAgentProvider,
];
