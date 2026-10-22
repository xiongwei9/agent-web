import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export type McpToolResult = Awaited<ReturnType<Client["callTool"]>>;

export function describeMcpTool(serverId: string, tool: McpTool): string {
  const prefix = `MCP ${serverId}/${tool.name}`;
  return tool.description ? `${prefix}: ${tool.description}` : prefix;
}

export function formatMcpToolResult(result: McpToolResult): string {
  if ("toolResult" in result) {
    return stringifyToolOutput(result.toolResult);
  }

  const textParts = result.content.filter((part) => part.type === "text");
  if (
    textParts.length === result.content.length &&
    textParts.length > 0 &&
    !result.structuredContent &&
    !result.isError
  ) {
    return textParts.map((part) => part.text).join("\n");
  }

  return stringifyToolOutput(result);
}

/**
 * A tool result as code mode's scripts receive it: the `structuredContent`
 * for a tool that declares an `outputSchema` (the content matches it), else
 * the text. A tool-level error (`isError`) throws, so a script can
 * `try`/`catch` it.
 */
export function mcpToolResultValue(result: McpToolResult, structured: boolean): unknown {
  if ("toolResult" in result) {
    return formatMcpToolResult(result); // the legacy shape: no schema to match
  }
  if (result.isError) {
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    throw new Error(text || "The MCP tool reported an error.");
  }
  return (structured ? result.structuredContent : undefined) ?? formatMcpToolResult(result);
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const json = JSON.stringify(value);
  return json ?? String(value);
}
