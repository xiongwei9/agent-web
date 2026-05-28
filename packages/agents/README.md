# Agents

Workspace package that owns AG-UI agent implementations and the provider registry.

## Providers

Provider registrations live in `src/providers/index.ts`.

- `auto`: use the first configured provider
- `mastra`: Mastra streaming agent backed by the OpenAI model provider

## Configuration

This package does not read environment variables directly. Applications should
build an `AgentConfig` object and pass it to `createAgentRunner`.

`AgentConfig.provider` is typed as the supported provider selection:
`auto | mastra`. Shared runtime settings live under `languageModel` and
`execution`, so agent implementations are not coupled to environment variables
or provider-specific config objects.
