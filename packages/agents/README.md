# Agents

Workspace package that owns the AG-UI agent runner: a framework-free agentic
loop that drives `@ai-sdk/*` models directly and emits AG-UI events itself.

## Layout

- `src/runtime/` — the agent runtime. `agent.ts` exposes `createAgent`;
  `loop.ts` is the agentic loop; `prompt.ts` maps AG-UI history onto the model
  prompt; `compaction.ts` summarizes old context; `tools.ts` / `mcp.ts` /
  `skills.ts` provide server-side tools (`mcp-oauth.ts` holds the MCP OAuth
  client state); `a2ui.ts` / `hitl.ts` declare
  client-fulfilled tools; `model.ts` builds the `@ai-sdk` model.
- `src/system-prompt.md` — the default system prompt; edit it to change the
  agent's persona/instructions.
- `src/skills/` — Agent Skills document store.

## Configuration

This package does not read environment variables directly. Applications build
an `AgentConfig` object and pass it to `createAgent(config)`, which returns
`{ run, mcp }` and throws if `languageModel.apiKey` is missing. `run` turns a
`RunAgentInput` into an AG-UI event stream; `mcp` exposes the MCP servers'
status and OAuth flow (undefined without MCP servers).

`AgentConfig.languageModel.provider` supports `openai`, `openai-compatible`,
`anthropic`, and `google` (see `src/runtime/model.ts`). `execution` tunes the
loop (`maxToolIterations`, `contextCompaction`).

MCP tools come from `AgentConfig.mcp.servers`. Streamable HTTP is the preferred
transport and the default for a `url` without `transport`; stdio (`command`) and
the legacy SSE transport (`transport: "sse"`) are still supported. Tool names
are namespaced as `<serverId>__<toolName>`.

`AgentConfig.systemPrompt` overrides `src/system-prompt.md`. Either way, the
skills catalog and the A2UI / HITL guides are appended to it.

## MCP connections and OAuth

Each MCP server is tracked on its own (`mcp.status()`): `pending` until the
first connect, then `connected`, `failed` (skipped, retried after a few
seconds), or `needs_auth`. A server that drops its session or connection is
reconnected on the next call.

With `AgentConfig.mcp.oauth` set (`redirectUrl`, optional `clientName`), a
remote server that answers 401 goes through the MCP authorization flow: the SDK
discovers the authorization server, registers a client dynamically, and builds
a PKCE authorization URL. A server-side agent can't open a browser, so the
server waits in `needs_auth` with that `authorizationUrl` for the app to show.
When the user approves, the authorization server redirects to `redirectUrl`;
the app passes its `state` and `code` to `mcp.finishAuth(state, code)`, which
exchanges them for tokens and connects. Tokens refresh automatically; if a
refresh fails, the server returns to `needs_auth`. Tokens are kept in memory
only, so a process restart means authorizing again.

## Tests

`pnpm --filter @ai-chat/agents test` runs `test/**/*.test.ts` with `node --test`.
The MCP tests, OAuth included, run against the Streamable HTTP demo server in
`packages/mcp-server-demo`. The agent-loop tests use a scripted fake model, so
they need no API key.

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
