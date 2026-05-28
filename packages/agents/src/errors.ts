export class AgentProviderNotFoundError extends Error {
  constructor(providerId: string, availableProviderIds: string[]) {
    super(
      `Agent provider "${providerId}" was not found. Available providers: ${availableProviderIds.join(", ")}.`,
    );
    this.name = "AgentProviderNotFoundError";
  }
}

export class AgentProviderConfigurationError extends Error {
  constructor(providerId: string, configurationHint?: string) {
    super(
      [
        `Agent provider "${providerId}" is not configured.`,
        configurationHint ? ` ${configurationHint}` : "",
      ].join(""),
    );
    this.name = "AgentProviderConfigurationError";
  }
}
