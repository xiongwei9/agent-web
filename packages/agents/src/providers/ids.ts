export const AUTO_AGENT_PROVIDER = "auto";

const AGENT_PROVIDER_IDS = ["mastra", "agno"] as const;

export const AGENT_PROVIDER_SELECTIONS = [AUTO_AGENT_PROVIDER, ...AGENT_PROVIDER_IDS] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];
export type AgentProviderSelection = (typeof AGENT_PROVIDER_SELECTIONS)[number];

export function isAgentProviderSelection(value: string): value is AgentProviderSelection {
  return (AGENT_PROVIDER_SELECTIONS as readonly string[]).includes(value);
}
