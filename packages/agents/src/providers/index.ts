import { openAIChatAgentProvider } from "./openai-chat.js";
import type { AgentProvider } from "../types.js";

export {
  AGENT_PROVIDER_IDS,
  AGENT_PROVIDER_SELECTIONS,
  AUTO_AGENT_PROVIDER,
  isAgentProviderId,
  isAgentProviderSelection,
  type AgentProviderId,
  type AgentProviderSelection,
} from "./ids.js";

export const agentProviders: AgentProvider[] = [
  openAIChatAgentProvider,
];
