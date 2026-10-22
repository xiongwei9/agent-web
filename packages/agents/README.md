# Agents

Workspace package that owns the AG-UI agent runner: a framework-free agentic
loop that drives `@ai-sdk/*` models directly and emits AG-UI events itself.

## Layout

- `src/runtime/` — the agent runtime. `agent.ts` exposes `createAgentRunner`;
  `loop.ts` is the agentic loop; `prompt.ts` maps AG-UI history onto the model
  prompt; `compaction.ts` summarizes old context; `tools.ts` / `mcp.ts` /
  `skills.ts` provide server-side tools; `a2ui.ts` / `hitl.ts` declare
  client-fulfilled tools; `model.ts` builds the `@ai-sdk` model.
- `src/system-prompt.md` — the default system prompt; edit it to change the
  agent's persona/instructions.
- `src/skills/` — Agent Skills document store.

## Configuration

This package does not read environment variables directly. Applications build
an `AgentConfig` object and pass it to `createAgentRunner(config)`; it throws if
`languageModel.apiKey` is missing.

`AgentConfig.languageModel.provider` supports `openai`, `openai-compatible`,
`anthropic`, and `google` (see `src/runtime/model.ts`). `execution` tunes the
loop (`maxToolIterations`, `contextCompaction`).

MCP tools come from `AgentConfig.mcp.servers`. Supported transports are stdio,
streamable HTTP, and SSE. Tool names are namespaced as `<serverId>__<toolName>`.

`AgentConfig.systemPrompt` overrides `src/system-prompt.md`. Either way, the
skills catalog and the A2UI / HITL guides are appended to it.

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
