import type { AgentCapability } from "../capability.ts";
import type { McpToolRegistry } from "./registry.ts";

/**
 * The MCP servers as an agent capability: their tools, connected as needed,
 * and a note naming any server that waits for the user's authorization.
 */
export function mcpCapability(registry: McpToolRegistry): AgentCapability {
  return {
    systemPrompt: () => registry.authorizationPromptSection(),
    serverTools: async () => [...(await registry.getTools()).values()],
  };
}
