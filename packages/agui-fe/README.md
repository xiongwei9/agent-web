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
| [`hooks/useChat.ts`](src/hooks/useChat.ts) | Owns one `HttpAgent`, mirrors its `messages`/status/error into React state, exposes `send`/`stop`/`reset` plus the resume paths (`respondToToolCall`, `submitA2uiAction`). Recreates the agent (fresh thread) when `reset()` is called. |
| [`components/Chat.tsx`](src/components/Chat.tsx) | Wires the hook to the view: autoscroll, status bar, error banner. |
| [`components/MessageList.tsx`](src/components/MessageList.tsx) | Renders user/assistant messages; attaches `tool` result messages to their originating tool call by `toolCallId`. |
| [`components/MessageItem.tsx`](src/components/MessageItem.tsx) / [`ToolCall.tsx`](src/components/ToolCall.tsx) / [`Markdown.tsx`](src/components/Markdown.tsx) | A single message, a collapsible tool-call card, and Markdown rendering. |
| [`components/HitlPrompt.tsx`](src/components/HitlPrompt.tsx) / [`lib/hitl.ts`](src/lib/hitl.ts) | The Human-in-the-Loop card — a question or an approval gate — and the contract for parsing the call and formatting the answer. |
| [`components/Composer.tsx`](src/components/Composer.tsx) | Input box; Enter sends, Shift+Enter newlines, Stop aborts a run. |

### Streaming model

Each `runAgent()` is one **run**: the assistant message grows token-by-token as
`TEXT_MESSAGE_CONTENT` events arrive, and tool calls appear as cards that flip
from `⟳` to `✓` when their result event lands. Because the reduction is keyed by
the server-assigned `messageId`, those ids **must be unique per run** — the
server namespaces them with the `runId` so consecutive answers don't merge into
one bubble.

### Human-in-the-Loop

When the agent calls `ask_user` or `request_user_approval`, the server streams
the tool call and ends the run — the turn is **suspended**, not finished.
`MessageItem` renders such a call as an interactive card instead of the generic
tool view, and the user's response resumes the conversation:

```
assistant.toolCalls[ask_user]        run finished, the call has no result yet
  └─ HitlPrompt renders the question / approval gate
       └─ useChat.respondToToolCall(toolCallId, '{"answer":"prod"}')
            ├─ agent.addMessage({ role: "tool", toolCallId, content })
            └─ agent.runAgent(…)      new runId, same threadId
```

Answering in the composer instead is fine: `send()` first closes any open prompt
with `{"cancelled": true}`, because the model cannot take another turn while one
of its tool calls has no result. The A2UI surface uses the same suspend path but
resumes with a `user` message rather than a tool result.

## Develop

```bash
# from the repo root — start the server (defaults to :3000) in one terminal
pnpm dev

# then the frontend (defaults to :5173) in another
pnpm --filter @ai-chat/agui-fe dev
```

Open http://localhost:5173. The Vite dev server proxies `/agui` and `/mcp` to
the AG-UI server, so no CORS configuration is needed.

When one of the agent's MCP servers needs OAuth, a banner above the chat offers
**Authorize**. It opens the server's consent page in a new tab, which closes
itself once the flow finishes. The banner polls `/mcp/servers` until every
server is connected.

## Configuration

Copy [`.env.example`](.env.example) to `.env` to override defaults:

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_AGUI_URL` | `/agui` | URL the browser POSTs runs to. Use an absolute URL to skip the proxy and hit a remote server directly. MCP status is fetched from `mcp/servers` next to it. |
| `VITE_AGUI_TARGET` | `http://localhost:3000` | Dev-only: where the Vite proxy forwards `/agui` and `/mcp`. |

## Conversation identifiers

AG-UI models a conversation with **two** ids, `threadId` and `runId`. There is
no `sessionId` in the protocol. They nest like this:

```
threadId   one conversation    — many turns share it; carries history/context
  └ runId    one turn          — a single POST /agui request-response
      └ messageId / toolCallId  — ids inside a run (server prefixes with runId)
```

| Id | Scope | Meaning | Who sets it | Where |
| --- | --- | --- | --- | --- |
| `threadId` | A conversation | Ties all turns of one chat together. Stays fixed for the life of an `HttpAgent`; a new one is minted on agent switch / **New chat**. | Client | [`useChat.ts`](src/hooks/useChat.ts) — `uid("thread")` |
| `runId` | One turn | A single run. Every send (and every HITL resume) is a new `runId`. | Client (`HttpAgent` auto-generates one per `runAgent()`) | server uses it in `RUN_STARTED`/`RUN_FINISHED` and to namespace message ids |

This frontend sends only `threadId`/`runId` (via `HttpAgent`).

## Scripts

| Script | Description |
| --- | --- |
| `dev` | Start the Vite dev server. |
| `build` | Type-check and produce a production bundle in `dist/`. |
| `preview` | Serve the production build locally. |
| `typecheck` | Run `tsc --noEmit`. |
