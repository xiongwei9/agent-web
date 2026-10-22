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

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const json = JSON.stringify(value);
  return json ?? String(value);
}
