# Agents

Workspace package that owns AG-UI agent implementations and the provider registry.

## Providers

Provider registrations live in `src/providers/index.ts`.

- `auto`: use the first configured provider
- `mastra`: Mastra streaming agent backed by a configurable language model
- `agno`: proxy AG-UI runs to a Python agno service

## Configuration

This package does not read environment variables directly. Applications should
build an `AgentConfig` object and pass it to `createAgentRunner`.

`AgentConfig.provider` is typed as the supported provider selection:
`auto | mastra | agno`. Shared runtime settings live under `languageModel` and
`execution`, so agent implementations are not coupled to environment variables
or provider-specific config objects.

`AgentConfig.languageModel.provider` supports `openai`, `openai-compatible`,
`anthropic`, and `google`. The Mastra provider builds SDK model instances in
`src/providers/language-model.ts`, then reuses the same agent/tool pipeline for
all model providers.

Mastra agents can also receive MCP tools through `AgentConfig.mcp.servers`.
Supported transports are stdio, streamable HTTP, and SSE. Tool names are
namespaced as `<serverId>__<toolName>` before being registered with Mastra.
