import type { AgentCapability } from "../capability.ts";
import type { ModelFunctionTool } from "../model/types.ts";
import { isRecord, joinSections, normalizeToolParameters } from "../shared/utils.ts";
import type { FrontendTool, ServerTool } from "./types.ts";

/** Everything the capabilities contribute to one run, merged. */
export interface RunTools {
  /** The capabilities' system-prompt sections, joined in order. */
  systemPrompt: string | undefined;
  /** Tools the loop executes, by name. */
  serverTools: Map<string, ServerTool>;
  /** Tools the client fulfills, by name. */
  frontendTools: Map<string, FrontendTool>;
}

/**
 * Asks every capability what it adds to this run and merges the answers, in
 * order. A later capability's server tool replaces an earlier one with the
 * same name; frontend tools never shadow a server tool (see
 * {@link buildModelToolDefs}).
 *
 * Tools resolve first: resolving can change a capability's state (MCP servers
 * connect, or turn out to need authorization) and so its prompt section.
 */
export async function resolveRunTools(capabilities: AgentCapability[]): Promise<RunTools> {
  const serverTools = new Map<string, ServerTool>();
  const frontendTools = new Map<string, FrontendTool>();
  const resolved = await Promise.all(capabilities.map((capability) => capability.serverTools?.()));

  for (const [index, capability] of capabilities.entries()) {
    for (const tool of resolved[index] ?? []) {
      serverTools.set(tool.name, tool);
    }
    for (const tool of capability.clientTools?.() ?? []) {
      frontendTools.set(tool.def.name, tool);
    }
  }

  const systemPrompt = joinSections(capabilities.map((capability) => capability.systemPrompt?.()));
  return { systemPrompt, serverTools, frontendTools };
}

/** Converts a server-side tool into a model function declaration. */
export function toModelToolDef(tool: ServerTool): ModelFunctionTool {
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
  serverTools: Map<string, ServerTool>,
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
