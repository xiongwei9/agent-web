import type { AgentCapability } from "../capability.ts";
import type { ServerTool } from "./types.ts";

const BUILTIN_TOOLS: ServerTool[] = [
  {
    name: "get_server_time",
    description: "Get the server's current date and time.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () =>
      JSON.stringify({
        iso: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
  },
];

/** The local builtin tools (e.g. `get_server_time`). */
export function builtinCapability(): AgentCapability {
  return { serverTools: () => BUILTIN_TOOLS };
}
