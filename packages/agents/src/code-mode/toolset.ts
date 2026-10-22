import { joinSections } from "../shared/utils.ts";
import type { RunTools } from "../tools/toolset.ts";
import type { ServerTool, ToolExecutionContext } from "../tools/types.ts";
import type { CodeModeConfig } from "../types.ts";
import { compileCode } from "./compile.ts";
import { declareTool, declareTools, toIdentifiers, type ToolDeclaration } from "./declarations.ts";
import { runInSandbox, type SandboxFunction } from "./sandbox.ts";

export const EXECUTE_CODE_TOOL = "execute_code";
export const SEARCH_TOOLS_TOOL = "search_tools";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;
/** `auto` discovery inlines the declarations up to this size (~2k tokens). */
const MAX_INLINE_DECLARATION_CHARS = 8_000;
/** In `search` discovery, how much of the description the tool names may take. */
const MAX_TOOL_INDEX_CHARS = 4_000;
const DEFAULT_SEARCH_LIMIT = 8;

/** The wrapped tools as the code sees them. */
interface ToolApi {
  tools: ServerTool[];
  declarations: ToolDeclaration[];
  /** All of `declarations` as TypeScript; the code is type-checked against it. */
  source: string;
}

/**
 * Code mode: instead of advertising each server tool to the model, offer one
 * `execute_code` tool that runs TypeScript calling them through a typed
 * `tools` API (see {@link runInSandbox}). Models write code better than they
 * chain tool calls, and intermediate results stay in the sandbox instead of
 * passing through the context window.
 *
 * The code is type-checked against the tools' declarations before it runs
 * (see {@link compileCode}). Tools that describe a structured result
 * (`ServerTool.code`, e.g. an MCP tool's `outputSchema`) resolve to it, typed;
 * the rest resolve to their text. When the declarations would bloat the
 * prompt, the description only names the tools and a `search_tools` tool
 * looks up the ones the model needs.
 *
 * Hidden tools (skills plumbing) stay direct: they steer the model rather than
 * fetch data. Client tools (A2UI, HITL) stay direct too, since calling one
 * suspends the run. Without any tool to wrap, `tools` is returned unchanged.
 */
export function withCodeMode(tools: RunTools, config: CodeModeConfig): RunTools {
  const wrapped = [...tools.serverTools.values()].filter((tool) => !tool.hidden);
  if (wrapped.length === 0) {
    return tools;
  }

  const api = toolApi(wrapped);
  const discovery = config.toolDiscovery ?? "auto";
  const inline =
    discovery === "inline" ||
    (discovery === "auto" && api.source.length <= MAX_INLINE_DECLARATION_CHARS);

  const serverTools = new Map([...tools.serverTools].filter(([, tool]) => tool.hidden));
  serverTools.set(EXECUTE_CODE_TOOL, executeCodeTool(api, inline, config));
  if (!inline) {
    serverTools.set(SEARCH_TOOLS_TOOL, searchToolsTool(api));
  }

  return {
    ...tools,
    serverTools,
    systemPrompt: joinSections([tools.systemPrompt, systemPrompt(inline)]),
  };
}

function toolApi(tools: ServerTool[]): ToolApi {
  const identifiers = toIdentifiers(tools.map((tool) => tool.name));
  const declarations = tools.map((tool) => ({
    identifier: identifiers.get(tool.name)!,
    description: tool.description,
    parameters: tool.parameters,
    outputSchema: tool.code?.outputSchema,
  }));
  return { tools, declarations, source: declareTools(declarations) };
}

function systemPrompt(inline: boolean): string {
  return [
    "## Code mode",
    "",
    `Your tools are not called one at a time: you call them from TypeScript with the \`${EXECUTE_CODE_TOOL}\` tool, as methods of its \`tools\` object.`,
    inline
      ? `Their declarations are in the \`${EXECUTE_CODE_TOOL}\` description.`
      : `Its description only names them: before using a tool, look up its declaration with \`${SEARCH_TOOLS_TOOL}\` rather than guessing its arguments or result.`,
    "- Do a whole step in one script: chain calls, run independent ones together with `Promise.all`, and filter or aggregate their results in code.",
    "- `return` only what you need to answer; `console.log` for anything else worth seeing. Keep large raw results out of the return value.",
    "- The code is checked before it runs. If it fails to type-check or to run, read the errors, fix the code and run it again.",
  ].join("\n");
}

function executeCodeTool(api: ToolApi, inline: boolean, config: CodeModeConfig): ServerTool {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const typeCheck = config.typeCheck ?? true;
  const catalog = inline
    ? ["", "```ts", api.source, "```"]
    : [
        "",
        `Tools (look up their declarations with \`${SEARCH_TOOLS_TOOL}\` before using them):`,
        toolIndex(api.declarations),
      ];

  return {
    name: EXECUTE_CODE_TOOL,
    description: [
      `Run TypeScript in a sandbox that can call the tools ${inline ? "declared" : "named"} below.`,
      "`code` is the body of an async function: use `await`, and `return` the result (it is JSON-serialized).",
      "Each tool takes one object argument and resolves to its declared result; a result declared as `string` is the tool's text (often JSON: JSON.parse it). A failed call throws.",
      ...(typeCheck
        ? ["The code is type-checked against the declarations first and runs only if that passes."]
        : []),
      "There is no network, file system, timers, or modules; only `tools` and `console`.",
      `A run is stopped after ${timeoutMs / 1000}s.`,
      ...catalog,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The body of an async TypeScript function.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      if (typeof args.code !== "string" || !args.code.trim()) {
        throw new Error('"code" must be a non-empty string.');
      }

      const compiled = await compileCode(args.code, api.source, typeCheck);
      if (!compiled.ok) {
        return JSON.stringify(
          {
            error: "The code failed to type-check, so nothing ran. Fix it and run it again.",
            typeErrors: compiled.errors,
          },
          null,
          2,
        );
      }

      const result = await runInSandbox({
        code: compiled.js,
        functions: sandboxFunctions(api, context),
        timeoutMs,
        signal: context?.signal,
      });
      const output = {
        ...(result.ok ? { result: result.value } : { error: result.error }),
        ...(result.logs.length > 0 ? { logs: result.logs } : {}),
      };
      return truncate(JSON.stringify(output, null, 2));
    },
  };
}

function sandboxFunctions(
  api: ToolApi,
  context: ToolExecutionContext | undefined,
): Record<string, SandboxFunction> {
  const functions: Record<string, SandboxFunction> = {};
  for (const [index, tool] of api.tools.entries()) {
    functions[api.declarations[index]!.identifier] = async (args) =>
      tool.code ? tool.code.execute(args, context) : tool.execute(args, context);
  }
  return functions;
}

function searchToolsTool(api: ToolApi): ServerTool {
  return {
    name: SEARCH_TOOLS_TOOL,
    description:
      `Look up the TypeScript declarations of tools that \`${EXECUTE_CODE_TOOL}\` code can call: ` +
      "by keywords matched against their names and descriptions, or by exact names.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing what you need, e.g. `weather forecast`.",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Exact tool names, as listed in the execute_code description.",
        },
        limit: {
          type: "integer",
          description: `How many keyword matches to return (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    // Plumbing, like the skills tools: the model reads it, the UI doesn't.
    hidden: true,
    execute: (args) => {
      const names = Array.isArray(args.names) ? args.names.map(String) : [];
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && args.limit > 0
          ? Math.floor(args.limit)
          : DEFAULT_SEARCH_LIMIT;

      const found =
        names.length > 0
          ? api.declarations.filter((declaration) => names.includes(declaration.identifier))
          : searchDeclarations(api.declarations, query, limit);
      if (found.length === 0) {
        return `No tool matches. The tools are: ${toolIndex(api.declarations)}`;
      }
      return ["```ts", "interface Tools {", ...found.map(declareTool), "}", "```"].join("\n");
    },
  };
}

/**
 * Ranks the tools by how many of the query's words their name (weighted) and
 * description contain. Plain substring matching: tool catalogs are small, and
 * the model can always fall back to exact names from the index.
 */
export function searchDeclarations(
  declarations: ToolDeclaration[],
  query: string,
  limit: number,
): ToolDeclaration[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return declarations
    .map((declaration) => {
      const name = declaration.identifier.toLowerCase();
      const description = declaration.description.toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0),
        0,
      );
      return { declaration, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ declaration }) => declaration);
}

/** The tool names, comma-separated, cut off at {@link MAX_TOOL_INDEX_CHARS}. */
function toolIndex(declarations: ToolDeclaration[]): string {
  let index = "";
  for (const [position, { identifier }] of declarations.entries()) {
    const next = index ? `${index}, ${identifier}` : identifier;
    if (next.length > MAX_TOOL_INDEX_CHARS) {
      return `${index}, …and ${declarations.length - position} more (search to find them)`;
    }
    index = next;
  }
  return index;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}
