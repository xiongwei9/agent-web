# MCP Server Demo

A demo MCP server over Streamable HTTP, protected by OAuth 2.1, for local
development and the `@ai-chat/agents` / `@ai-chat/agui-server` tests. The tools
(`src/server.ts`) cover each result shape the agent's MCP client has to handle:

| Tool          | Result shape                                         |
| ------------- | ---------------------------------------------------- |
| `echo`        | plain text                                           |
| `get_weather` | plain text (fake JSON weather for a city)            |
| `add`         | text + `structuredContent`                           |
| `get_image`   | image content block                                  |
| `fail`        | tool-level error (`isError: true`)                   |
| `sleep`       | slow call, for timeouts / cancellation               |
| `whoami`      | echoes the HTTP request headers and the OAuth client |

The server is stateful by default: `initialize` opens a session whose id comes
back in `Mcp-Session-Id`, and later requests must send it. Set `stateless` for a
fresh server per request instead.

## OAuth

With `oauth` on (the default for `pnpm dev`), the server is its own
authorization server, built on the SDK's `mcpAuthRouter` (`src/oauth.ts`):

- `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server`: discovery metadata
- `/register`: dynamic client registration
- `/authorize`: renders a consent page; **Approve** redirects back with a code
  and **Deny** redirects back with `access_denied`
- `/token`: authorization code (PKCE) and refresh token grants
- `/mcp` requires `Authorization: Bearer <token>` with scope `mcp:tools` and
  answers 401 otherwise

Clients, codes, and tokens live in memory. Restarting the demo invalidates
them, and the agent asks for authorization again. Access tokens last an hour
(`oauth: { accessTokenTtlSeconds }` changes that).

## Run

The root `pnpm dev` starts it (with `--watch`) alongside agui-server and the
frontend. The frontend then shows an **Authorize** banner for it, and
agui-server logs the authorization URL. Approve once and the agent can use the
`demo__*` tools.

To run it on its own:

```bash
# http://127.0.0.1:3901/mcp
pnpm dev:mcp            # from the repo root, with --watch
pnpm --filter @ai-chat/mcp-server-demo start

# Optional env: MCP_DEMO_PORT, MCP_DEMO_HOST, MCP_DEMO_OAUTH=false (no auth),
# MCP_DEMO_STATELESS=true
MCP_DEMO_PORT=3902 MCP_DEMO_OAUTH=false pnpm --filter @ai-chat/mcp-server-demo start
```

## Use from agui-server

`packages/agui-server/.env.example` already points `MCP_SERVERS` at it. A `url`
without `transport` uses Streamable HTTP, and agui-server handles the OAuth
flow itself (see its README):

```bash
MCP_SERVERS='{"demo":{"url":"http://127.0.0.1:3901/mcp"}}'
```

The agent then sees the tools as `demo__echo`, `demo__get_weather`, and so on.

## Use from code

```ts
import { startDemoHttpServer } from "@ai-chat/mcp-server-demo";

const server = await startDemoHttpServer({ oauth: true }); // ephemeral port
// server.url, server.sessionCount …
await server.close();
```
