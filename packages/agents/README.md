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
  skills/           Agent Skills: the loader, the skill tools and
                    `/skill-name` commands (toolset.ts); the skills themselves
                    live in `AgentConfig.skills.dirs`
  client-tools/     client-fulfilled tools: A2UI surfaces, HITL prompts
  code-mode/        code mode: the execute_code / search_tools tools, the
                    tools' TypeScript declarations, the type check, and the
                    QuickJS sandbox
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

`codeMode` switches how the model uses tools. Off (the default), every server
tool is offered to the model directly. With `codeMode.enabled`, the builtin and
MCP tools are replaced by one `execute_code` tool: the model writes the body of
an async TypeScript function that calls them as `tools.<name>(args)`, chains
and filters their results, and returns only what it needs.

- Types: each tool is declared as TypeScript generated from its JSON Schemas.
  An MCP tool with an `outputSchema` resolves to its `structuredContent`, typed
  by that schema; other tools resolve to their text. A tool-level error
  (`isError`) throws inside the code, so it can be caught.
- Type check (`codeMode.typeCheck`, default on): the code is checked against
  the declarations before it runs, so a misspelled tool, a wrong argument or a
  misread result comes back as type errors and no tool is called. The check is
  lenient (no strict null checks, implicit `any` allowed). The first check
  parses the standard library (~100 ms); later ones take a few ms.
- Discovery (`codeMode.toolDiscovery`): `inline` puts every declaration in the
  `execute_code` description; `search` lists only the tool names and adds a
  `search_tools` tool that returns the declarations the model asks for, by
  keywords or names, so the prompt stays small however many MCP tools there
  are. `auto` (default) inlines up to ~8k characters of declarations.
- Sandbox: a fresh QuickJS (WebAssembly) runtime per call, with no network,
  file system, timers, or modules, a 64 MB memory cap, and
  `codeMode.timeoutMs` (default 30s) for the whole call, tool calls included.

Skills tools, client tools (A2UI, HITL, request-declared tools) and tools that
require approval stay direct: they suspend the run or steer the model rather
than fetch data.

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
`ask_user` and `request_user_approval` (`src/client-tools/hitl.ts`). Calling
one suspends the run: the loop emits the `TOOL_CALL_*` events, finishes, and
waits for the client to answer with a `tool` message for that `toolCallId` on the
next run. Malformed calls are validated server-side and bounced back to the model
as a tool result, so the client only ever receives a renderable prompt, and
`buildPrompt` backfills a cancellation result for any prompt the user never
answered.

The A2UI render tool (`src/client-tools/a2ui.ts`) shares that suspend path
for whole agent-authored surfaces; so do frontend tools a request declares in
`RunAgentInput.tools`.

Server tools marked `requiresApproval` reuse it to enforce approval
(`src/loop/approval.ts`): the loop holds the model's call back, raises a
`request_user_approval` call of its own listing it, and suspends. The resumed
run runs the call if the user approved it (and the approval is the latest
thing in the history), or gives it a "not run" result otherwise, before the
model's next turn. The loop's approval call is left out of the model's prompt.
An MCP server's `approval` (`destructive` by default, `always`, `never`) decides
which of its tools are marked, from their annotations.

## Skills

Agent Skills are packaged, on-demand capabilities following the
[Agent Skills spec](https://agentskills.io/specification). The `src/skills/`
module discovers them (`loader.ts`) and `toolset.ts` turns them into tools.
The skills live outside the package, in the directories
`AgentConfig.skills.dirs` lists; a skill in an earlier directory wins a name
clash. The server's default is the repo's `packages/skills/`.

Each skill is a folder `<dir>/<skill-name>/` containing:

- `SKILL.md` — YAML frontmatter (`name`, `description`) plus a markdown body of
  instructions. `name` is lowercase letters, digits and single hyphens (e.g.
  `release-notes`), at most 64 characters, and matches the folder name.
- `references/`, `scripts/`, `assets/` — optional supporting files the model can
  read on demand.

Loading is lenient, as the spec's client guide recommends: a skill whose
frontmatter doesn't parse or has no `description` is skipped, a duplicate
`name` is skipped, and other spec violations only warn — all through the
agent's logger, never failing startup.

Skills use progressive disclosure: only each skill's name + description is
injected into the system prompt; the `Skill` tool loads the full `SKILL.md`
body wrapped in `<skill_content name="…">` with a list of its bundled files,
and `read_skill_file` / `run_skill_script` access those files, sandboxed to the
skill's directory. The tools stream like any other tool call, so the client
keeps a loaded skill in its history and it stays in context on later runs;
context compaction keeps `<skill_content>` blocks verbatim rather than
summarizing them.

The user can activate a skill too: a user message that starts with
`/<skill-name>` reaches the model with the skill's `<skill_content>` in front
of the rest of the message. The client keeps the message as typed, so it is
expanded the same way on every run (`AgentCapability.userText`). `Agent.skills`
lists the installed skills for a UI to suggest.

Drop a skill folder into a skills directory → it is discovered when the agent
is created. With no skills, no skill tools are registered.
