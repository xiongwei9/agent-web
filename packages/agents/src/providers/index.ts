import { agnoAgentProvider } from "./agno/agno.ts";
import { mastraAgentProvider } from "./mastra/mastra.ts";
import type { AgentProvider } from "../types.ts";

export { type AgentProviderSelection, AUTO_AGENT_PROVIDER, type AgentProviderId } from "./ids.ts";

export const agentProviders: AgentProvider[] = [mastraAgentProvider, agnoAgentProvider];
