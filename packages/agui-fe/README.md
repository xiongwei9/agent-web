# @ai-chat/agui-fe

React + Vite frontend for the [`@ai-chat/agui-server`](../agui-server/) AG-UI
service. It POSTs an AG-UI `RunAgentInput` to the server and renders the
streamed AG-UI event stream as a live conversation — streaming assistant text,
tool calls with their results, and Markdown.

It uses [`@ag-ui/client`](https://github.com/ag-ui-protocol/ag-ui)'s `HttpAgent`,
which handles SSE parsing and reduces the event stream into a `Message[]`. The
[`useChat`](src/hooks/useChat.ts) hook mirrors that state into React.

## How it works

```
Composer.onSend(text)
  └─▶ useChat.send()
        ├─ agent.addMessage({ role: "user", content })   // optimistic, renders immediately
        └─ agent.runAgent({ tools: [], context: [] })     // POST /agui  (SSE)
                                   │
        server streams AG-UI events back ◀─────────────────┘
                                   │
   HttpAgent reduces events → Message[]   (TEXT_MESSAGE_* → assistant text,
                                            TOOL_CALL_*    → assistant.toolCalls,
                                            tool result    → role:"tool" message)
                                   │
        subscriber.onMessagesChanged ─▶ setMessages([...]) ─▶ React re-render
```

The browser never speaks the AG-UI wire format directly. `HttpAgent` owns the
HTTP request, SSE decoding, and the event→message reduction; the app only reads
the resulting `Message[]` and calls `send`/`stop`/`reset`.

### Pieces

| File | Responsibility |
| --- | --- |
| [`hooks/useChat.ts`](src/hooks/useChat.ts) | Owns one `HttpAgent`, mirrors its `messages`/status/error into React state, exposes `send`/`stop`/`reset`. Recreates the agent (fresh thread) when the agent id changes or `reset()` is called. |
| [`lib/agents.ts`](src/lib/agents.ts) | Agent catalog + the `/agui` endpoint URL. |
| [`components/Chat.tsx`](src/components/Chat.tsx) | Wires the hook to the view: autoscroll, status bar, error banner. |
| [`components/MessageList.tsx`](src/components/MessageList.tsx) | Renders user/assistant messages; attaches `tool` result messages to their originating tool call by `toolCallId`. |
| [`components/MessageItem.tsx`](src/components/MessageItem.tsx) / [`ToolCall.tsx`](src/components/ToolCall.tsx) / [`Markdown.tsx`](src/components/Markdown.tsx) | A single message, a collapsible tool-call card, and Markdown rendering. |
| [`components/Composer.tsx`](src/components/Composer.tsx) | Input box; Enter sends, Shift+Enter newlines, Stop aborts a run. |

### Streaming model

Each `runAgent()` is one **run**: the assistant message grows token-by-token as
`TEXT_MESSAGE_CONTENT` events arrive, and tool calls appear as cards that flip
from `⟳` to `✓` when their result event lands. Because the reduction is keyed by
the server-assigned `messageId`, those ids **must be unique per run** — the
server namespaces them with the `runId` so consecutive answers don't merge into
one bubble.

## Develop

```bash
# from the repo root — start the server (defaults to :3000) in one terminal
pnpm dev

# then the frontend (defaults to :5173) in another
pnpm --filter @ai-chat/agui-fe dev
```

Open http://localhost:5173. The Vite dev server proxies `/agui` to the AG-UI
server, so no CORS configuration is needed.

## Configuration

Copy [`.env.example`](.env.example) to `.env` to override defaults:

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_AGUI_URL` | `/agui` | URL the browser POSTs runs to. Use an absolute URL to skip the proxy and hit a remote server directly. |
| `VITE_AGUI_TARGET` | `http://localhost:3000` | Dev-only: where the Vite proxy forwards `/agui`. |

The agent dropdown sets the `x-agent-id` header (`default`, `OnboardingAgent`),
matching the markdown agent definitions in [`@ai-chat/agents`](../agents/).

## Conversation identifiers

AG-UI models a conversation with **two** ids, `threadId` and `runId`. There is
no `sessionId` in the protocol — the closest concept, a cross-conversation user
identity, is Mastra's `resourceId`. They nest like this:

```
resourceId   user / identity      — one user, many threads (optional)
  └ threadId   one conversation    — many turns share it; carries history/context
      └ runId    one turn          — a single POST /agui request-response
          └ messageId / toolCallId  — ids inside a run (server prefixes with runId)
```

| Id | Scope | Meaning | Who sets it | Where |
| --- | --- | --- | --- | --- |
| `threadId` | A conversation | Ties all turns of one chat together. Stays fixed for the life of an `HttpAgent`; a new one is minted on agent switch / **New chat**. | Client | [`useChat.ts`](src/hooks/useChat.ts) — `uid("thread")` |
| `runId` | One turn | A single run. Every send (and every HITL resume) is a new `runId`. | Client (`HttpAgent` auto-generates one per `runAgent()`) | server uses it in `RUN_STARTED`/`RUN_FINISHED` and to namespace message ids |
| `resourceId` | A user/identity | Cross-thread identity (e.g. user id) for shared memory. Sent via the `x-resource-id` header. | Caller | [`agui-server` route](../agui-server/src/routes/agui.ts); consumed by the Mastra/agno providers |

This frontend currently sends only `threadId`/`runId` (via `HttpAgent`) and
`x-agent-id`. It does **not** send `x-resource-id` — wire one up (e.g. a stable
id persisted in `localStorage`) when you want per-user memory across threads.

## Scripts

| Script | Description |
| --- | --- |
| `dev` | Start the Vite dev server. |
| `build` | Type-check and produce a production bundle in `dist/`. |
| `preview` | Serve the production build locally. |
| `typecheck` | Run `tsc --noEmit`. |
