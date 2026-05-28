import { AgentProviderConfigurationError, AgentProviderNotFoundError } from "./errors.ts";
import { AUTO_AGENT_PROVIDER, agentProviders, type AgentProviderId } from "./providers/index.ts";
import type {
  AgentProvider,
  AgentProviderSummary,
  AgentRunner,
  CreateAgentRunnerOptions,
} from "./types.ts";

export function createAgentRunner({ config = {} }: CreateAgentRunnerOptions = {}): AgentRunner {
  const provider = config.provider ?? AUTO_AGENT_PROVIDER;

  if (provider === AUTO_AGENT_PROVIDER) {
    for (const candidate of agentProviders) {
      const runner = candidate.create({ config });
      if (runner) {
        return runner;
      }
    }

    throw new AgentProviderConfigurationError(AUTO_AGENT_PROVIDER);
  }

  const selectedProvider = getAgentProvider(provider);
  const runner = selectedProvider.create({ config });
  if (!runner) {
    throw new AgentProviderConfigurationError(
      selectedProvider.id,
      selectedProvider.configurationHint,
    );
  }

  return runner;
}

export function getAgentProvider(providerId: AgentProviderId): AgentProvider {
  const provider = agentProviders.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new AgentProviderNotFoundError(
      providerId,
      agentProviders.map((candidate) => candidate.id),
    );
  }

  return provider;
}

export function listAgentProviders(): AgentProviderSummary[] {
  return agentProviders.map(({ id, label, description, configurationHint }) => ({
    id,
    label,
    description,
    configurationHint,
  }));
}
