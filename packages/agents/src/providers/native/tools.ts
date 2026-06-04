import type { McpConfig } from "../../types.ts";
import { isRecord, localAgentTools, normalizeToolParameters } from "../shared.ts";
import { createMcpToolRegistry, type McpToolRegistry } from "./mcp.ts";
import { SkillsToolset } from "./skills.ts";
import type { ModelFunctionTool, NativeTool } from "./types.ts";

/**
 * Owns the tools the native agent executes server-side: the local builtins
 * (e.g. `get_server_time`), the Agent Skills tools (`Skill` and friends), and
 * any MCP server tools. The set is resolved once per run (MCP tools load
 * lazily) and exposed both as a name→tool map for execution and as model-facing
 * function declarations.
 *
 * Client-side / Human-in-the-Loop tools (the ones the frontend declares in
 * `RunAgentInput.tools`) are intentionally NOT here — the loop advertises those
 * to the model too, but stops the run when one is called so the client can
 * fulfill it. See {@link buildModelToolDefs}.
 */
export class NativeToolset {
  private readonly mcp: McpToolRegistry | undefined;
  private readonly skills = new SkillsToolset();

  constructor(mcp: McpConfig | undefined) {
    this.mcp = createMcpToolRegistry(mcp);
  }

  /** Level-1 skill catalog injected into the system prompt, if any skills exist. */
  skillsCatalog(): string | undefined {
    return this.skills.systemPromptSection();
  }

  /** All server-side tools by name (local builtins, skills, then MCP). */
  async resolve(): Promise<Map<string, NativeTool>> {
    const tools = new Map<string, NativeTool>();
    for (const local of localAgentTools.values()) {
      tools.set(local.name, {
        name: local.name,
        description: local.description,
        parameters: normalizeToolParameters(local.parameters),
        execute: (args) => local.execute(args),
      });
    }

    for (const skillTool of this.skills.tools()) {
      tools.set(skillTool.name, skillTool);
    }

    if (this.mcp) {
      for (const [name, tool] of await this.mcp.getTools()) {
        tools.set(name, tool);
      }
    }

    return tools;
  }
}

/** Converts a server-side tool into a model function declaration. */
export function toModelToolDef(tool: NativeTool): ModelFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  };
}

/**
 * Builds the function declarations advertised to the model for one run: every
 * server-side tool, plus every client tool from the request that isn't already
 * handled server-side, plus any `frontendToolDefs` (server-defined but
 * client-fulfilled tools, e.g. the A2UI `render_a2ui` tool). Server tools win on
 * name collisions so we never shadow a builtin with a declaration we can't
 * execute, and frontend defs never overwrite a server or client tool.
 */
export function buildModelToolDefs(
  serverTools: Map<string, NativeTool>,
  clientTools: { name: string; description?: string; parameters?: unknown }[],
  frontendToolDefs: ModelFunctionTool[] = [],
): ModelFunctionTool[] {
  const defs: ModelFunctionTool[] = [];
  const seen = new Set<string>();
  for (const tool of serverTools.values()) {
    defs.push(toModelToolDef(tool));
    seen.add(tool.name);
  }

  for (const tool of clientTools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    defs.push({
      type: "function",
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: isRecord(tool.parameters)
        ? normalizeToolParameters(tool.parameters)
        : normalizeToolParameters(undefined),
    });
  }

  for (const def of frontendToolDefs) {
    if (seen.has(def.name)) {
      continue;
    }
    seen.add(def.name);
    defs.push(def);
  }

  return defs;
}
