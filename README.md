# ai-chat

这是一个 monorepo，用于通过 [AG-UI](https://github.com/ag-ui-protocol/ag-ui) protocol 提供 chat agents 服务。Fastify server 接收 AG-UI `RunAgentInput`，并以流式方式返回 AG-UI events；每次 run 由一个不依赖 agent framework 的自构建 agentic loop 执行，直接驱动 `@ai-sdk/*` models。

## 包

| Package | 说明 |
| --- | --- |
| [`@ai-chat/agui-server`](packages/agui-server/) | 暴露 AG-UI event stream 的 Fastify service，包含 OpenAPI docs 和经过 Zod 校验的 schemas。 |
| [`@ai-chat/agents`](packages/agents/) | AG-UI agent runner（自构建 agentic loop）、system prompt、MCP integration、Agent Skills、A2UI 和 HITL。 |

## 架构

```
client ──POST /agui──▶ agui-server (Fastify)
                          │  createAgentRunner(config)
                          ▼
                    @ai-chat/agents
                          │  hand-written agentic loop
                          │  (@ai-sdk model + tools)
                          ▼
                     AG-UI events ──stream──▶ client
```

server 自身不包含 agent logic。它会使用已加载的 config 调用 [`createAgentRunner`](packages/agents/src/runtime/agent.ts)，并将得到的 RxJS `Observable<BaseEvent>` 以 Server-Sent Events 的形式传给 client。

### Agent runtime

[`packages/agents/src/runtime/`](packages/agents/src/runtime/) 自行实现 agentic loop：流式调用 model → 发出 `TEXT_MESSAGE_*` / `TOOL_CALL_*` events → 执行 server-side tools 并继续循环，遇到 client-side tool（A2UI、HITL 或 request 声明的 tools）时挂起 run，等待 client 恢复。设置 `MODEL_API_KEY` 即可启用；未配置时 server 启动失败。

### System prompt、MCP 与 Skills

- **System prompt** 默认取自
  [`packages/agents/src/system-prompt.md`](packages/agents/src/system-prompt.md)，
  直接编辑该文件即可修改；也可以用 `SYSTEM_PROMPT` env var（即
  `AgentConfig.systemPrompt`）覆盖。Skills catalog、A2UI 和 HITL 指引会自动追加在其后。
- **MCP servers** 可以通过 `MCP_SERVERS` env var 作为 server-side tools 暴露给
  agent（支持 stdio、streamable HTTP 或 SSE transports）。
- [`packages/agents/src/skills/`](packages/agents/src/skills/) 中的
  **Agent Skills** 遵循 Claude Code 风格的 progressive disclosure：低成本的
  name/description catalog 会被注入 prompt，完整的 `SKILL.md` 及打包资源仅在
  skill 被调用时加载。

### Human-in-the-Loop（HITL）

agent runtime 会额外向 model 声明两个**由 client 兑现**的 tools（见
[`runtime/hitl.ts`](packages/agents/src/runtime/hitl.ts)）：

| Tool | 用途 | 回给 model 的结果 |
| --- | --- | --- |
| `ask_user` | 向用户提问：自由文本，或用 `options` 给出单选/多选。 | `{"answer": "…"}`（多选时为数组） |
| `request_user_approval` | 在执行有后果、难以撤销的操作前请求批准。 | `{"decision": "approved" 或 "rejected", "comment"?: "…"}` |

两者都没有注册为 server tool，因此 model 调用时 loop 会**挂起这次 run**：server 照常发出
`TOOL_CALL_START/ARGS/END` 并以 `RUN_FINISHED` 收尾，交由 client 渲染交互卡片。用户作出响应后，
client 用同一个 `toolCallId` 追加一条 `tool` message 并发起新的 run，model 读到的就是一次普通的
tool result，可以从中断处继续。

```
model → ask_user / request_user_approval
   └─ TOOL_CALL_* + RUN_FINISHED          run 挂起，等待用户
        └─ 用户在 UI 上作答
             └─ client 追加 { role: "tool", toolCallId, content } 后发起新的 run
                  └─ model 读到 tool result，继续原来的思路
```

同一条挂起路径也服务于 A2UI 的 `render_a2ui`（区别是它以 `user` message 恢复），以及 client 自己在
`RunAgentInput.tools` 中声明的 frontend tools。两个细节保证了它在真实对话里不会卡住：

- 参数非法的 HITL 调用不会到达 client。loop 把 schema 错误当作 tool result 回灌给 model，让它当场修正后重新调用。
- 用户可以不理会卡片、直接在输入框继续聊天。此时 [`agui-fe`](packages/agui-fe/) 会先补一条
  `{"cancelled": true}` 的 tool result；server 端的
  [`buildPrompt`](packages/agents/src/runtime/prompt.ts) 也会为任何未被回答的 tool call 兜底补齐，
  避免 model API 因「有 tool call 却没有对应 tool result」而报错。

## 快速开始

需要 Node >= 22.13 和 [pnpm](https://pnpm.io) 10。

```sh
pnpm install
```

配置 server（`agui-server` 会自动加载 `.env`）：

```sh
# packages/agui-server/.env
MODEL_API_KEY=sk-...
MODEL_PROVIDER=anthropic        # openai | openai-compatible | anthropic | google
MODEL_NAME=claude-sonnet-4-6
```

以 watch mode 运行 server：

```sh
pnpm dev          # → @ai-chat/agui-server, node --watch
```

默认监听 `http://0.0.0.0:3000`。Interactive API docs 位于 [`/docs`](http://localhost:3000/docs)；health check 位于 `/health`。

### 发送请求

```sh
curl -N http://localhost:3000/agui \
  -H 'content-type: application/json' \
  -d '{
    "threadId": "t1",
    "runId": "r1",
    "messages": [{ "id": "m1", "role": "user", "content": "Hello!" }],
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {}
  }'
```

## 配置

所有配置都由 [`loadConfig`](packages/agui-server/src/config.ts) 从环境变量读取。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 绑定 host。 |
| `PORT` | `3000` | 绑定 port。 |
| `LOG_LEVEL` | `info` | Fastify log level。 |
| `SYSTEM_PROMPT` | — | 覆盖默认 system prompt（`packages/agents/src/system-prompt.md`）。 |
| `MODEL_PROVIDER` | — | `openai` \| `openai-compatible` \| `anthropic` \| `google`。 |
| `MODEL_API` | — | OpenAI SDK mode：`responses` 或 `chat`。 |
| `MODEL_API_KEY` | — | language model 的 API key。 |
| `MODEL_BASE_URL` | — | 覆盖 base URL（例如 OpenAI-compatible gateway）。 |
| `MODEL_NAME` | — | Model id。 |
| `AGENT_MAX_TOOL_ITERATIONS` | — | 每次 run 的 tool-call iterations 上限。 |
| `MCP_SERVERS` | — | 作为 server-side tools 暴露的 MCP servers 的 JSON map。 |

## 开发

```sh
pnpm dev            # 以 watch mode 运行 agui-server
pnpm lint           # eslint
pnpm lint:fix       # eslint --fix
pnpm typecheck      # 在所有 packages 中运行 tsc --noEmit
```

构建 `@ai-chat/agents` 时，会将 `system-prompt.md` 和 skill folders 复制到 `dist/`，使编译后的 package 可以在 runtime 读取它们（`pnpm --filter @ai-chat/agents build`）。
