# ai-chat

这是一个 monorepo，用于通过 [AG-UI](https://github.com/ag-ui-protocol/ag-ui) protocol 提供 chat agents 服务。Fastify server 接收 AG-UI `RunAgentInput`，并以流式方式返回 AG-UI events；可插拔的 provider layer 负责决定一次 run 的执行方式，可以通过 [Mastra](https://mastra.ai)、Python [agno](https://github.com/agno-agi/agno) service，或自构建的 native agent loop 执行。

## 包

| Package | 说明 |
| --- | --- |
| [`@ai-chat/agui-server`](packages/agui-server/) | 暴露 AG-UI event stream 的 Fastify service，包含 OpenAPI docs 和经过 Zod 校验的 schemas。 |
| [`@ai-chat/agents`](packages/agents/) | Agent provider registry、AG-UI runners、markdown agent definitions、MCP integration 和 Agent Skills。 |
| [`agno-server`](packages/agno-server/) | 可选的 Python service，用于将 `agno` agent 封装为 AG-UI。请参阅它的 [README](packages/agno-server/README.md)。 |

## 架构

```
client ──POST /agui──▶ agui-server (Fastify)
                          │  createAgentRunner(config)
                          ▼
                    @ai-chat/agents
                          │  provider registry (auto-selects)
            ┌─────────────┼──────────────┐
            ▼             ▼               ▼
         mastra          agno          native
     (@ag-ui/mastra)  (HTTP proxy)  (hand-written loop)
            │             │               │
            └──────── AG-UI events ───────┘ ──stream──▶ client
```

server 自身不包含 agent logic。它会使用已加载的 config 调用 [`createAgentRunner`](packages/agents/src/registry.ts)，并将得到的 RxJS `Observable<BaseEvent>` 以 Server-Sent Events 的形式传给 client。

### Providers

每个 provider 都实现相同的 `AgentProvider` interface，并且仅在自身已配置时返回 runner，因此 `AGENT_PROVIDER=auto` 会选择第一个可运行的 provider（见 [`providers/index.ts`](packages/agents/src/providers/index.ts)）。

| Provider | 功能 | 启用条件 |
| --- | --- | --- |
| **mastra** | 通过 `@ag-ui/mastra` adapter 运行 Mastra agent，可选支持基于 libsql 的 thread/working memory。 | `MODEL_API_KEY`（`auto` 模式下默认启用） |
| **agno** | 通过 HTTP 将 AG-UI run proxy 到 Python `agno` service。 | `AGNO_BASE_URL` |
| **native** | 不依赖 framework 的 agentic loop，直接驱动 `@ai-sdk/*` models，并自行发出 AG-UI events。 | `MODEL_API_KEY` + `AGENT_PROVIDER=native` |

### Agents、MCP 与 Skills

- **Agent definitions** 以带 YAML frontmatter 的 markdown files 形式存放在
  [`packages/agents/src/agents/definitions/`](packages/agents/src/agents/definitions/)。
  每个文件的 frontmatter 设置 agent `id`/`name`/`model`，正文作为该 agent 的
  instructions。Clients 可通过 `x-agent-id` header 为每次 request 选择一个 agent。
- **MCP servers** 可以通过 `MCP_SERVERS` env var 作为 server-side tools 暴露给
  model-backed agents（支持 stdio、streamable HTTP 或 SSE transports）。
- [`packages/agents/src/skills/`](packages/agents/src/skills/) 中的
  **Agent Skills** 遵循 Claude Code 风格的 progressive disclosure：低成本的
  name/description catalog 会被注入 prompt，完整的 `SKILL.md` 及打包资源仅在
  skill 被调用时加载。

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
  -H 'x-agent-id: default' \
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
| `AGENT_PROVIDER` | `auto` | `auto` \| `mastra` \| `agno` \| `native`。 |
| `MODEL_PROVIDER` | — | `openai` \| `openai-compatible` \| `anthropic` \| `google`。 |
| `MODEL_API` | — | OpenAI SDK mode：`responses` 或 `chat`。 |
| `MODEL_API_KEY` | — | language model 的 API key。 |
| `MODEL_BASE_URL` | — | 覆盖 base URL（例如 OpenAI-compatible gateway）。 |
| `MODEL_NAME` | — | Model id。 |
| `AGENT_MAX_TOOL_ITERATIONS` | — | 每次 run 的 tool-call iterations 上限。 |
| `MASTRA_STORAGE_URL` | — | Mastra memory 的 libsql URL（`file:./mastra.db`、`:memory:`、`libsql://…`）。 |
| `MCP_SERVERS` | — | 作为 server-side tools 暴露的 MCP servers 的 JSON map。 |
| `AGNO_BASE_URL` | — | Python agno service 的 base URL。 |
| `AGNO_PATH` | `/agui` | agno service 上的 AG-UI path。 |

### 请求头

| Header | 用途 |
| --- | --- |
| `x-agent-id` | 按 id 选择已注册的 agent（默认为 `default`）。 |
| `x-resource-id` | Cross-thread identity（例如 user id），供 Mastra memory 使用。 |

## 开发

```sh
pnpm dev            # 以 watch mode 运行 agui-server
pnpm lint           # eslint
pnpm lint:fix       # eslint --fix
pnpm typecheck      # 在所有 packages 中运行 tsc --noEmit
```

构建 `@ai-chat/agents` 时，会将 markdown agent definitions 和 skill folders 复制到 `dist/`，使编译后的 package 可以在 runtime 读取它们（`pnpm --filter @ai-chat/agents build`）。
