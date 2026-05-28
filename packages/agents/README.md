# Agents

Workspace package that owns AG-UI agent implementations and the provider registry.

## Providers

Provider registrations live in `src/providers/index.ts`.

- `auto`: use the first configured provider
- `openai-chat`: OpenAI Chat Completions streaming agent

## Configuration

This package does not read environment variables directly. Applications should
build an `AgentConfig` object and pass it to `createAgentRunner`.

`AgentConfig.provider` is typed as the supported provider selection:
`auto | openai-chat`. Shared runtime settings live under `languageModel` and
`execution`, so agent implementations are not coupled to environment variables
or provider-specific config objects.
