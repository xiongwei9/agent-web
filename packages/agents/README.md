# Agents

Workspace package that owns AG-UI agent implementations and the provider registry.

## Providers

Provider registrations live in `src/providers/index.ts`.

- `auto`: use the first configured provider
- `mastra`: Mastra streaming agent backed by a configurable language model
- `agno`: proxy AG-UI runs to a Python agno service
- `native`: framework-free agentic loop driving `@ai-sdk/*` models directly

## Configuration

This package does not read environment variables directly. Applications should
build an `AgentConfig` object and pass it to `createAgentRunner`.

`AgentConfig.provider` is typed as the supported provider selection:
`auto | mastra | agno`. Shared runtime settings live under `languageModel` and
`execution`, so agent implementations are not coupled to environment variables
or provider-specific config objects.

`AgentConfig.languageModel.provider` supports `openai`, `openai-compatible`,
`anthropic`, and `google`. The Mastra provider builds SDK model instances in
`src/providers/language-model.ts`, then reuses the same agent/tool pipeline for
all model providers.

Mastra agents can also receive MCP tools through `AgentConfig.mcp.servers`.
Supported transports are stdio, streamable HTTP, and SSE. Tool names are
namespaced as `<serverId>__<toolName>` before being registered with Mastra.

## Human-in-the-Loop

The native provider declares two tools it never executes itself —
`ask_user` and `request_user_approval` (`src/providers/native/hitl.ts`). Calling
one suspends the run: the loop emits the `TOOL_CALL_*` events, finishes, and
waits for the client to answer with a `tool` message for that `toolCallId` on the
next run. Malformed calls are validated server-side and bounced back to the model
as a tool result, so the client only ever receives a renderable prompt, and
`buildPrompt` backfills a cancellation result for any prompt the user never
answered.

The A2UI render tool (`src/providers/native/a2ui.ts`) shares that suspend path
for whole agent-authored surfaces; so do frontend tools a request declares in
`RunAgentInput.tools`.

## Skills

Agent Skills are packaged, on-demand capabilities following the
[Agent Skills spec](https://github.com/anthropics/skills). The `src/skills/`
module is purely a **document store** and is decoupled from agents and
providers: it owns the `SKILL.md` files, not the loading mechanism. Each
provider wires those skills up using its framework's native skill support.

Each skill is a folder under `src/skills/<skill-name>/` containing:

- `SKILL.md` — YAML frontmatter (`name`, `description`) plus a markdown body of
  instructions. `name` must be lowercase/hyphenated (e.g. `release-notes`).
- `references/`, `scripts/`, `assets/` — optional supporting files the model can
  read on demand.

The module exports only *where* the skills live (`SKILLS_BASE_PATH`,
`SKILL_DEFINITION_PATHS`). The Mastra provider feeds these to a Mastra
`Workspace` backed by a read-only `LocalSkillSource`; every agent inherits the
workspace and automatically gains the native `skill`, `skill_search`, and
`skill_read` tools plus a system-message catalog (progressive disclosure — only
the descriptions are injected up front). See
[Mastra Skills docs](https://mastra.ai/docs/workspace/skills).

Drop a skill folder into `src/skills/` → it is discovered automatically. Skills
are optional; with no skill folders, no skill tools are registered. Other
providers (e.g. agno) manage their own skills on their side and are unaffected.
