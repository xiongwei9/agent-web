import { agnoAgentProvider } from "./agno.ts";
import { mastraAgentProvider } from "./mastra.ts";
import type { AgentProvider } from "../types.ts";

export {
  AGENT_PROVIDER_IDS,
  AGENT_PROVIDER_SELECTIONS,
  AUTO_AGENT_PROVIDER,
  isAgentProviderId,
  isAgentProviderSelection,
  type AgentProviderId,
  type AgentProviderSelection,
} from "./ids.ts";

export const agentProviders: AgentProvider[] = [mastraAgentProvider, agnoAgentProvider];
