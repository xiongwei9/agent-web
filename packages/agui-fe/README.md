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
| [`components/chat/`](src/components/chat) | The page: [`Chat.tsx`](src/components/chat/Chat.tsx) wires the hook to the view (header, autoscroll, error banner), [`Composer.tsx`](src/components/chat/Composer.tsx) is the input box (Enter sends, `/` suggests skills, Stop aborts a run), [`McpStatusBanner.tsx`](src/components/chat/McpStatusBanner.tsx) prompts for MCP authorization. |
| [`components/messages/`](src/components/messages) | [`MessageList.tsx`](src/components/messages/MessageList.tsx) groups consecutive assistant messages into one reply, attaches `tool` results to their call by `toolCallId`, and splits answered HITL prompts out as their own entries; [`MessageItem.tsx`](src/components/messages/MessageItem.tsx) lays a turn out as text, step groups and cards. |
| [`components/steps/`](src/components/steps) | The agent's working: consecutive tool calls and skill activations fold into one collapsible [`StepGroup`](src/components/steps/StepGroup.tsx), each step a [`ToolCall`](src/components/steps/ToolCall.tsx) (opens to arguments/result) or [`SkillCall`](src/components/steps/SkillCall.tsx). |
| [`components/hitl/`](src/components/hitl) | Human-in-the-Loop (contract in [`lib/hitl.ts`](src/lib/hitl.ts)): [`HitlDock`](src/components/hitl/HitlDock.tsx) is the open prompt, docked in place of the composer; [`HitlExchange`](src/components/hitl/HitlExchange.tsx) is the answered exchange, its own entry in the transcript. |
| [`components/cards/`](src/components/cards) | The agent-authored [`A2uiSurface`](src/components/cards/A2uiSurface.tsx), rendered inline as an interactive card. |
| [`components/debug/`](src/components/debug) | The Debug side panel (header's **Debug** button): every model call of the thread as the server made it — system prompt, messages, tool calls and results, tool declarations, the response and token usage — laid out by message or as raw JSON, plus the client's AG-UI messages. Fed by the server's debug `CUSTOM` events ([`lib/debug.ts`](src/lib/debug.ts)), which need `AGENT_DEBUG_EVENTS=on`. |
| [`components/ui/`](src/components/ui) | Shared primitives: `Button`, icons, `Markdown`. |

### Streaming model

Each `runAgent()` is one **run**: the assistant message grows token-by-token as
`TEXT_MESSAGE_CONTENT` events arrive, and tool calls appear as steps whose spinner
flips to `✓` when their result event lands. Because the reduction is keyed by
the server-assigned `messageId`, those ids **must be unique per run** — the
server namespaces them with the `runId` so consecutive answers don't merge into
one bubble.

### Human-in-the-Loop

When the agent calls `ask_user` or `request_user_approval`, the server streams
the tool call and ends the run — the turn is **suspended**, not finished. The
open prompt takes the composer's place until it is answered, so the user can't
talk past it; the transcript records the exchange once it has a result:

```
assistant.toolCalls[ask_user]        run finished, the call has no result yet
  └─ useChat.pendingPrompt → HitlDock replaces the composer
       └─ useChat.respondToToolCall(toolCallId, '{"answer":"prod"}')
            ├─ agent.addMessage({ role: "tool", toolCallId, content })
            └─ agent.runAgent(…)      new runId, same threadId
  └─ HitlExchange: question + answer, a card in the agent's column
```

`ask_user` can be skipped, which answers `{"cancelled": true, …}`; a rejection
is the way out of an approval. The A2UI surface uses the same suspend path but
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
