export const AUTO_AGENT_PROVIDER = "auto";

export const AGENT_PROVIDER_IDS = [
  "openai-chat",
] as const;

export const AGENT_PROVIDER_SELECTIONS = [
  AUTO_AGENT_PROVIDER,
  ...AGENT_PROVIDER_IDS,
] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];
export type AgentProviderSelection = (typeof AGENT_PROVIDER_SELECTIONS)[number];

export function isAgentProviderId(value: string): value is AgentProviderId {
  return (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isAgentProviderSelection(
  value: string,
): value is AgentProviderSelection {
  return (AGENT_PROVIDER_SELECTIONS as readonly string[]).includes(value);
}
