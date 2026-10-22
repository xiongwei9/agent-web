import { a2uiCapability } from "../src/client-tools/a2ui.ts";
import { hitlCapability } from "../src/client-tools/hitl.ts";
import type { FrontendTool } from "../src/tools/types.ts";

/** The frontend tools the agent ships with, keyed by name as the loop passes them. */
export function promptToolsForTest(): Map<string, FrontendTool> {
  const tools = [...a2uiCapability().clientTools!(), ...hitlCapability().clientTools!()];
  return new Map(tools.map((tool) => [tool.def.name, tool]));
}
