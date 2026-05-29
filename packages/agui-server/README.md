# AG-UI Server

Fastify service exposing an AG-UI-compatible HTTP endpoint with Zod validation and OpenAPI docs.

## Agent

Agent implementations live in the workspace package `@ai-chat/agents`.
Provider registrations are maintained in `packages/agents/src/providers/index.ts`.
The server owns environment loading and passes a single agent config object into
the agent package.

Set `MODEL_API_KEY` to enable model-backed agents. With
`AGENT_PROVIDER=auto`, the server uses the first configured provider. If no
provider is configured, startup fails with a configuration error.

```sh
MODEL_PROVIDER=openai MODEL_API_KEY=sk-... pnpm --filter @ai-chat/agui-server dev
```

Optional configuration:

- `AGENT_PROVIDER` defaults to `auto`; supported values are `auto`, `mastra`, `agno`
- `MODEL_PROVIDER` supports `openai`, `openai-compatible`, `anthropic`, `google`
- `MODEL_NAME` defaults by provider: `gpt-4.1-mini`, `claude-sonnet-4-5`, or `gemini-2.5-flash`
- `MODEL_BASE_URL` can point to an OpenAI-compatible endpoint or provider proxy
- `MODEL_API` can be `responses` or `chat`; when `MODEL_PROVIDER=openai-compatible`,
  Mastra defaults to `chat` for OpenAI-compatible gateways
- `AGENT_MAX_TOOL_ITERATIONS` defaults to `4`
- `MCP_SERVERS` is optional JSON config for MCP tool servers
- `AGNO_BASE_URL` base URL of the Python agno service (required for the `agno` provider)
- `AGNO_PATH` path on the agno service, defaults to `/agui`

`MCP_SERVERS` may be either a server map or an object with `mcpServers` /
`servers`. Stdio servers use `command`; streamable HTTP and SSE servers use
`url`. MCP tools are exposed to Mastra with namespaced tool names:
`<serverId>__<toolName>`.

```sh
MCP_SERVERS='{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  },
  "remote": {
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer token" }
  }
}'
```

The providers map AG-UI `messages` and `tools` into their underlying agent
runtime, then stream model text and function tool calls back as AG-UI events.

## Scripts

```sh
pnpm --filter @ai-chat/agui-server dev
pnpm --filter @ai-chat/agui-server build
pnpm --filter @ai-chat/agui-server typecheck
```

## Endpoints

- `GET /health` health check
- `POST /agui` AG-UI run endpoint. Accepts `RunAgentInput` and streams `BaseEvent` objects as SSE.
- `POST /agent` alias for clients that expect an `/agent` endpoint.
- `GET /docs` Swagger UI
- `GET /docs/json` OpenAPI JSON

The `/agui` endpoint is compatible with `HttpAgent` from `@ag-ui/client` when configured with this endpoint URL.
