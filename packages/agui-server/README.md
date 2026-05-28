# AG-UI Server

Fastify service exposing an AG-UI-compatible HTTP endpoint with Zod validation and OpenAPI docs.

## Agent

Agent implementations live in the workspace package `@ai-chat/agents`.
Provider registrations are maintained in `packages/agents/src/providers/index.ts`.
The server owns environment loading and passes a single agent config object into
the agent package.

Set `OPENAI_API_KEY` to enable the OpenAI-backed agents. With
`AGENT_PROVIDER=auto`, the server uses the first configured provider. If no
provider is configured, startup fails with a configuration error.

```sh
OPENAI_API_KEY=sk-... pnpm --filter @ai-chat/agui-server dev
```

Optional configuration:

- `AGENT_PROVIDER` defaults to `auto`; supported values are `auto`, `mastra`
- `OPENAI_MODEL` defaults to `gpt-4.1-mini`
- `OPENAI_BASE_URL` can point to an OpenAI-compatible endpoint
- `AGENT_MAX_TOOL_ITERATIONS` defaults to `4`

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
