# Agents

Workspace package that owns the AG-UI agent runner: a framework-free agentic
loop that drives `@ai-sdk/*` models directly and emits AG-UI events itself.

## Layout

```
src/
  index.ts          public API
  types.ts          public config and interface types
  agent.ts          createAgent — the one place that wires capabilities together
  capability.ts     AgentCapability: what a capability adds to a run
  loop/             the agentic loop: loop.ts (runAgentLoop), stream.ts (model
                    stream → AG-UI events), prompt.ts (AG-UI history → model
                    prompt), compaction.ts
  model/            the @ai-sdk model and the minimal model contract it meets
  tools/            tool contracts, the builtin tools, and merging capabilities'
                    tools for a run
  mcp/              MCP: per-user connections (users.ts), one user's registry
                    (registry.ts), transports, result formatting, OAuth client
                    state and token stores (oauth/)
  skills/           Agent Skills: the SKILL.md folders, their loader, and the
                    skill tools (toolset.ts)
  client-tools/     client-fulfilled tools: A2UI surfaces, HITL prompts
  shared/           AG-UI event helper, logger, small utilities
  system-prompt.md  the default system prompt
```

Dependencies point one way: `loop/` knows only `model/`, `tools/`, and
`shared/`, never a particular capability. A capability (builtins, skills, MCP,
A2UI, HITL) implements `AgentCapability` and contributes a system-prompt
section, server tools, and/or client tools. A client tool can also say how its
past calls replay into the prompt (`replayAsText`, `unansweredResult`).
Adding a capability means writing one and listing it in `agent.ts`.

## Configuration

This package does not read environment variables directly. Applications build
an `AgentConfig` object and pass it to `createAgent(config)`, which returns
`{ run, mcp }` and throws if `languageModel.apiKey` is missing. `run` turns a
`RunAgentInput` into an AG-UI event stream; `mcp` exposes the MCP servers'
status and OAuth flow (undefined without MCP servers).

`AgentConfig.languageModel.provider` supports `openai`, `openai-compatible`,
`anthropic`, and `google` (see `src/model/model.ts`). `contextWindow` is the
model's window in tokens. It defaults by provider: 1M for `openai`/`google`,
200k for `anthropic`, 128k for `openai-compatible`.

`execution` tunes the loop:

- `maxToolIterations` (default 16) caps the rounds of tool calls. Once spent,
  the model gets one last turn with tools disabled, so a run always ends with a
  reply.
- `contextCompaction` summarizes older messages once the prompt passes
  `maxTokens` (default 80% of `contextWindow`). Each thread's latest summary is
  remembered in memory and reapplied while the history still starts with the
  messages it covers, so a long conversation is summarized incrementally
  instead of from scratch every run.

`AgentConfig.logger` takes any pino-style logger (`debug`/`info`/`warn`/
`error`); the default is the console with `debug` off. `debug` logs every full
prompt and response, tool results included, which can contain tokens. Enable it
only where that is acceptable.

A run is aborted when its Observable is unsubscribed (e.g. the HTTP client
disconnects). Server tools get the run's `AbortSignal`: MCP calls are cancelled
and skill scripts are killed.

MCP tools come from `AgentConfig.mcp.servers`. Streamable HTTP is the preferred
transport and the default for a `url` without `transport`; stdio (`command`) and
the legacy SSE transport (`transport: "sse"`) are still supported. Tool names
are namespaced as `<serverId>__<toolName>`.

`AgentConfig.systemPrompt` overrides `src/system-prompt.md`. Either way, the
skills catalog and the A2UI / HITL guides are appended to it.

## MCP connections and OAuth

MCP state is per user. `run(input, { userId })` uses that user's connections
and tokens, and `mcp.status(userId)` / `mcp.connect(userId)` take the same id.
Omitting `userId` means one shared scope. Each user gets their own OAuth client
registration and tokens, so one user's authorization never serves another. A
user's connections close after `mcp.idleTimeoutMs` unused (default 30 min);
their tokens stay in the store.

Each server is tracked on its own: `pending` until the first connect, then
`connected`, `failed` (skipped, retried after a few seconds), or `needs_auth`.
A server that drops its session or connection is reconnected on the next call.

With `AgentConfig.mcp.oauth` set (`redirectUrl`, optional `clientName`), a
remote server that answers 401 goes through the MCP authorization flow: the SDK
discovers the authorization server, registers a client dynamically, and builds
a PKCE authorization URL. A server-side agent can't open a browser, so the
server waits in `needs_auth` with that `authorizationUrl` for the app to show.
When the user approves, the authorization server redirects to `redirectUrl`;
the app passes its `state` and `code` to `mcp.finishAuth(state, code)`, which
finds the user who started that authorization by `state`, exchanges the code for
tokens, and connects. Tokens refresh automatically.

The model is told about servers waiting for authorization. Each run's system
prompt names them, so the model can ask the user to authorize instead of
claiming it lacks the capability. If a connected server's token stops working
and can't be refreshed, its tools stay listed. Calling one returns "needs the
user's authorization" without reconnecting, since a reconnect would replace the
authorization URL the user may be holding. `oauth.authorizationHint` adds
app-specific directions to both, e.g. where the Authorize button is.

Client registrations and tokens live in `oauth.store`. It defaults to memory, so
a restart means authorizing again. `createFileMcpOAuthStore(path)` persists them
to a JSON file (mode 0600, plain-text tokens; keep it out of version control),
keyed by user, server id, and URL.

## Tests

`pnpm --filter @ai-chat/agents test` runs `test/**/*.test.ts` with `node --test`.
The MCP tests, OAuth included, run against the Streamable HTTP demo server in
`packages/mcp-server-demo`. The loop tests use a scripted fake model and the
`createAgent` tests a fake OpenAI-compatible endpoint, so no test needs an API
key or the network.

## Human-in-the-Loop

The runtime declares two tools it never executes itself —
`ask_user` and `request_user_approval` (`src/runtime/hitl.ts`). Calling
one suspends the run: the loop emits the `TOOL_CALL_*` events, finishes, and
waits for the client to answer with a `tool` message for that `toolCallId` on the
next run. Malformed calls are validated server-side and bounced back to the model
as a tool result, so the client only ever receives a renderable prompt, and
`buildPrompt` backfills a cancellation result for any prompt the user never
answered.

The A2UI render tool (`src/runtime/a2ui.ts`) shares that suspend path
for whole agent-authored surfaces; so do frontend tools a request declares in
`RunAgentInput.tools`.

## Skills

Agent Skills are packaged, on-demand capabilities following the
[Agent Skills spec](https://github.com/anthropics/skills). The `src/skills/`
module is purely a **document store**: it owns the `SKILL.md` files and
discovery helpers, while `src/runtime/skills.ts` turns them into tools.

Each skill is a folder under `src/skills/<skill-name>/` containing:

- `SKILL.md` — YAML frontmatter (`name`, `description`) plus a markdown body of
  instructions. `name` must be lowercase/hyphenated (e.g. `release-notes`).
- `references/`, `scripts/`, `assets/` — optional supporting files the model can
  read on demand.

Skills use progressive disclosure: only each skill's name + description is
injected into the system prompt; the `Skill` tool loads the full `SKILL.md`, and
`read_skill_file` / `run_skill_script` access bundled files, sandboxed to the
skill's directory. These tools are hidden from the AG-UI event stream.

Drop a skill folder into `src/skills/` → it is discovered automatically. With
no skill folders, no skill tools are registered.
