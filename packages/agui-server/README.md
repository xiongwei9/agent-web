# AG-UI Server

Fastify service exposing an AG-UI-compatible HTTP endpoint with Zod validation and OpenAPI docs.

## Agent

The agent runtime lives in the workspace package `@ai-chat/agents`. The server
owns environment loading and passes a single agent config object into
`createAgent`.

`MODEL_API_KEY` and `MODEL_NAME` are required; without them, startup fails
with a configuration error.

```sh
MODEL_PROVIDER=openai MODEL_API_KEY=sk-... MODEL_NAME=gpt-4.1-mini pnpm --filter @ai-chat/agui-server dev
```

Optional configuration. Every default lives in `src/config.ts`, and
`.env.example` lists each variable with its default (copy it to `.env`):

- `SYSTEM_PROMPT` overrides the default system prompt in
  `packages/agents/src/system-prompt.md`
- `MODEL_PROVIDER` supports `openai`, `openai-compatible`, `anthropic`, `google`
- `MODEL_BASE_URL` can point to an OpenAI-compatible endpoint or provider proxy
- `MODEL_PROVIDER` unset means `openai-compatible` when `MODEL_BASE_URL` is set, else `openai`
- `MODEL_API` can be `responses` (default) or `chat`; OpenAI providers only.
  Set `chat` for an OpenAI-compatible gateway without the Responses API
- `MODEL_CONTEXT_WINDOW` is the model's context window in tokens; context
  compaction starts at 80% of it (default 1000000)
- `AGENT_MAX_TOOL_ITERATIONS` caps rounds of tool calls per run (default 16). After the last round the model answers with tools
  disabled.
- `AGENT_CODE_MODE` is the code mode switch (`on`/`off`, default `off`). On,
  the builtin and MCP tools are no longer offered one by one: the model gets a
  single `execute_code` tool and calls them from TypeScript, which runs in a
  QuickJS sandbox with no network, file system, or process access.
  `AGENT_CODE_MODE_TIMEOUT_MS` limits each run (default 30000). Skills and the
  A2UI / HITL tools are unaffected.
- `AGENT_CODE_MODE_TOOL_DISCOVERY` switches code mode's tool discovery: `on`
  lists only the tool names and lets the model look up their declarations
  with a `search_tools` tool, so the prompt stays small however many MCP tools
  there are; `off` puts every declaration in the prompt; `auto` (default)
  inlines them while they're short (~8k characters) and searches beyond that.
- `AGENT_DEBUG_EVENTS` (`on`/`off`, default `off`) streams every model call —
  system prompt, messages, tool calls and results, tool declarations, the
  response and token usage — to the client as AG-UI `CUSTOM` events, which the
  frontend's Debug panel shows. It exposes full prompts to the browser, so keep
  it to development
- `LOG_LEVEL=debug` also logs every full prompt and response, tool results
  included; keep it off where those must not reach the logs
- `SESSION_SECRET` signs the session cookie (see [Sessions](#sessions))
- `MCP_SERVERS` is optional JSON config for MCP tool servers
- `SKILLS_DIRS` lists the directories of Agent Skills, comma-separated and
  relative to the working directory; an earlier one wins a name clash. Unset,
  it's the repo's `packages/skills/`; `off` means no skills

`MCP_SERVERS` may be either a server map or an object with `mcpServers` /
`servers`. Remote servers use `url` and default to Streamable HTTP (the
preferred transport); set `"transport": "sse"` only for legacy SSE servers.
Stdio servers use `command`. MCP tools are exposed to the agent with namespaced
tool names: `<serverId>__<toolName>`. For a local server to try this with, see
`packages/mcp-server-demo`.

Each server's `approval` decides which of its tools wait for the user's
approval before every call: `destructive` (default) gates the tools whose
annotations mark them destructive, `always` gates all of them, `never` none.
Use `always` for a server that doesn't annotate its tools.

Remote MCP servers that require OAuth are supported, per user (see
[Sessions](#sessions)). When the frontend loads, it polls `GET /mcp/servers`,
which connects that user's MCP servers. One that needs authorization logs its
authorization URL and is reported with it, and the frontend shows an
"Authorize" banner. After the user approves, the authorization server redirects
to `GET /mcp/oauth/callback`, which finishes the token exchange for the user
who started it and connects. While a server waits, the agent's system prompt names it and points the
user to the banner. `MCP_OAUTH_REDIRECT_URL` overrides the callback URL sent to
the authorization server (default `http://localhost:$PORT/mcp/oauth/callback`);
it must still reach this route.

Tokens persist in `MCP_OAUTH_STORE_PATH` (default `.mcp-oauth.json` in the
working directory, gitignored), so a restart, including `--watch` reloads,
doesn't mean authorizing again. The file holds plain-text tokens with mode 0600.
Set `off` to keep them in memory only. Each user's tokens are stored under
their own key.

## Sessions

There is no login. Each browser gets a random user id in a signed, httpOnly
session cookie (`ai_chat_session`), and that id scopes the user's MCP
connections and OAuth tokens. The HMAC signature stops a client from swapping
in another browser's id. A user is a browser: clearing cookies or switching
browsers means authorizing MCP servers again.

`SESSION_SECRET` is the signing key. Unset, one is generated on first start and
kept in `.session-secret` (mode 0600, gitignored) so sessions survive
restarts. Set it explicitly in production, and keep it stable: changing it signs
everyone out of their MCP authorizations. A frontend on another origin must send
requests with `credentials: "include"`; CORS allows credentials.

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
- `GET /mcp/servers` the session user's MCP server status; a `needs_auth` server carries its `authorizationUrl`
- `GET /mcp/oauth/callback` OAuth redirect target for MCP authorization servers
- `GET /skills` the installed Agent Skills; a message starting with `/<name>` activates one
- `GET /docs` Swagger UI
- `GET /docs/json` OpenAPI JSON

The `/agui` endpoint is compatible with `HttpAgent` from `@ag-ui/client` when configured with this endpoint URL.
