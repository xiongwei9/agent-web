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

server 自身不包含 agent logic。它会使用已加载的 config 调用 [`createAgent`](packages/agents/src/agent.ts)，并将得到的 RxJS `Observable<BaseEvent>` 以 Server-Sent Events 的形式传给 client。

### Agent runtime

[`packages/agents/src/loop/`](packages/agents/src/loop/) 自行实现 agentic loop：流式调用 model → 发出 `TEXT_MESSAGE_*` / `TOOL_CALL_*` events → 执行 server-side tools 并继续循环，遇到 client-side tool（A2UI、HITL 或 request 声明的 tools）时挂起 run，等待 client 恢复。设置 `MODEL_API_KEY` 和 `MODEL_NAME` 即可启用；未配置时 server 启动失败。

### System prompt、MCP 与 Skills

- **System prompt** 默认取自
  [`packages/agents/src/system-prompt.md`](packages/agents/src/system-prompt.md)，
  直接编辑该文件即可修改；也可以用 `SYSTEM_PROMPT` env var（即
  `AgentConfig.systemPrompt`）覆盖。Skills catalog、A2UI 和 HITL 指引会自动追加在其后。
- **MCP servers** 可以通过 `MCP_SERVERS` env var 作为 server-side tools 暴露给
  agent（支持 stdio、streamable HTTP 或 SSE transports）。
- **Agent Skills** 放在 [`packages/skills/`](packages/skills/)（可用 `SKILLS_DIRS`
  改为其他目录），遵循 [Agent Skills 规范](https://agentskills.io/specification)
  的 progressive disclosure：低成本的 name/description catalog 会被注入 prompt，
  完整的 `SKILL.md` 及打包资源仅在 skill 被调用时加载。用户也可以在消息开头输入
  `/skill-name` 直接激活某个 skill，前端输入 `/` 时会提示可用的 skills。

### Human-in-the-Loop（HITL）

agent runtime 会额外向 model 声明两个**由 client 兑现**的 tools（见
[`client-tools/hitl.ts`](packages/agents/src/client-tools/hitl.ts)）：

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
  [`buildPrompt`](packages/agents/src/loop/prompt.ts) 也会为任何未被回答的 tool call 兜底补齐，
  避免 model API 因「有 tool call 却没有对应 tool result」而报错。

#### 强制审批

`request_user_approval` 要靠 model 自觉调用。对标记为需要审批的 server tool
（`ServerTool.requiresApproval`），loop 会强制审批（见
[`loop/approval.ts`](packages/agents/src/loop/approval.ts)）：model 调用后先不执行，
由 loop 自己发出一个 `request_user_approval` 调用并挂起 run，前端照常渲染审批卡片。用户批准后，
恢复的 run 先执行原调用，再让 model 继续；拒绝或跳过则回给 model 一条「未执行」的结果。
loop 自己发出的审批调用不会进入 model 的 prompt，model 只看到原调用和它的结果。

MCP tools 是否需要审批由各 server 的 `approval` 决定：默认 `destructive` 依据 tool
annotations（`destructiveHint: true`，或 `readOnlyHint: false` 且未声明
`destructiveHint: false`），没有任何 hint 的 tool 不拦截；`always` 拦截全部，`never` 全部放行。
需要审批的 tools 在 code mode 下保持直接调用，因为脚本无法等待用户。

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

所有配置都由 [`loadConfig`](packages/agui-server/src/config.ts) 从环境变量读取，默认值也都定义在这里；[`.env.example`](packages/agui-server/.env.example) 列出了每个变量及其默认值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 绑定 host。 |
| `PORT` | `3000` | 绑定 port。 |
| `LOG_LEVEL` | `info` | Fastify log level。 |
| `SYSTEM_PROMPT` | — | 覆盖默认 system prompt（`packages/agents/src/system-prompt.md`）。 |
| `SKILLS_DIRS` | `packages/skills` | 逗号分隔的 skill 目录，靠前的目录在重名时优先；`off` 表示不加载 skills。 |
| `SESSIONS_DIR` | `data/sessions` | 聊天记录目录，每个 thread 一个子目录，存 AG-UI messages（`session.json`）和每次模型调用（`model-calls.jsonl`），前端可以据此切换会话；`off` 表示不记录。 |
| `MODEL_PROVIDER` | 设了 `MODEL_BASE_URL` 时为 `openai-compatible`，否则 `openai` | `openai` \| `openai-compatible` \| `anthropic` \| `google`。 |
| `MODEL_API` | `responses` | OpenAI SDK mode：`responses` 或 `chat`，仅 OpenAI providers 使用；不支持 Responses API 的 gateway 需设为 `chat`。 |
| `MODEL_API_KEY` | —（必填） | language model 的 API key。 |
| `MODEL_CONTEXT_WINDOW` | `1000000` | model 的 context window（tokens），超过 80% 时压缩上下文。 |
| `MODEL_BASE_URL` | — | 覆盖 base URL（例如 OpenAI-compatible gateway）。 |
| `MODEL_NAME` | —（必填） | Model id。 |
| `AGENT_MAX_TOOL_ITERATIONS` | `16` | 每次 run 的 tool-call iterations 上限。 |
| `AGENT_DEBUG_EVENTS` | `off` | `on` 时把每次模型调用（system prompt、messages、tool call/result、tool 声明、响应）作为 AG-UI `CUSTOM` 事件推给前端的 Debug 面板；会把完整 prompt 暴露给浏览器，仅用于开发。 |
| `MCP_SERVERS` | — | 作为 server-side tools 暴露的 MCP servers 的 JSON map。 |

本地状态默认都存放在仓库根目录的 `data/`（已 gitignore）：MCP OAuth token（`mcp-oauth.json`）、session cookie 的签名密钥（`session-secret`）、聊天记录（`sessions/`），以及 demo MCP server 注册的 client 和签发的 refresh token（`mcp-demo-clients.json`、`mcp-demo-refresh-tokens.json`，有了它们，重启 demo 不用重新授权）。

## 开发

```sh
pnpm dev            # 以 watch mode 运行 agui-server
pnpm lint           # eslint
pnpm lint:fix       # eslint --fix
pnpm typecheck      # 在所有 packages 中运行 tsc --noEmit
```

构建 `@ai-chat/agents` 时，会将 `system-prompt.md` 和 skill folders 复制到 `dist/`，使编译后的 package 可以在 runtime 读取它们（`pnpm --filter @ai-chat/agents build`）。
