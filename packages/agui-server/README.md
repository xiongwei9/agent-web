# AG-UI Server

Fastify service exposing an AG-UI-compatible HTTP endpoint with Zod validation and OpenAPI docs.

## Agent

The agent runtime lives in the workspace package `@ai-chat/agents`. The server
owns environment loading and passes a single agent config object into
`createAgent`.

`MODEL_API_KEY` is required; without it, startup fails with a configuration
error.

```sh
MODEL_PROVIDER=openai MODEL_API_KEY=sk-... pnpm --filter @ai-chat/agui-server dev
```

Optional configuration:

- `SYSTEM_PROMPT` overrides the default system prompt in
  `packages/agents/src/system-prompt.md`
- `MODEL_PROVIDER` supports `openai`, `openai-compatible`, `anthropic`, `google`
- `MODEL_NAME` defaults by provider: `gpt-4.1-mini`, `claude-sonnet-4-5`, or `gemini-2.5-flash`
- `MODEL_BASE_URL` can point to an OpenAI-compatible endpoint or provider proxy
- `MODEL_API` can be `responses` or `chat`; defaults to `responses` for `openai`
  and `chat` for `openai-compatible` gateways
- `AGENT_MAX_TOOL_ITERATIONS` defaults to `4`
- `MCP_SERVERS` is optional JSON config for MCP tool servers

`MCP_SERVERS` may be either a server map or an object with `mcpServers` /
`servers`. Remote servers use `url` and default to Streamable HTTP (the
preferred transport); set `"transport": "sse"` only for legacy SSE servers.
Stdio servers use `command`. MCP tools are exposed to the agent with namespaced
tool names: `<serverId>__<toolName>`. For a local server to try this with, see
`packages/mcp-server-demo`.

Remote MCP servers that require OAuth are supported. At startup the server
connects to every MCP server. One that needs authorization logs its
authorization URL and reports it from `GET /mcp/servers`; the frontend shows an
"Authorize" banner for it. After the user approves, the authorization server
redirects to `GET /mcp/oauth/callback`, which finishes the token exchange and
connects. `MCP_OAUTH_REDIRECT_URL` overrides the callback URL sent to the
authorization server (default `http://localhost:$PORT/mcp/oauth/callback`); it
must still reach this route. Tokens live in memory, so restarting the server
means authorizing again.

```sh
MCP_SERVERS='{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  },
  "remote": {
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer token" }
  }
}'
```

The runtime maps AG-UI `messages` and `tools` onto the model prompt, then
streams model text and function tool calls back as AG-UI events.

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
- `GET /mcp/servers` MCP server status; a `needs_auth` server carries its `authorizationUrl`
- `GET /mcp/oauth/callback` OAuth redirect target for MCP authorization servers
- `GET /docs` Swagger UI
- `GET /docs/json` OpenAPI JSON

The `/agui` endpoint is compatible with `HttpAgent` from `@ag-ui/client` when configured with this endpoint URL.
