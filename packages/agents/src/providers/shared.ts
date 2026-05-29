import type { Context } from "@ag-ui/core";

export interface LocalAgentTool {
  description: string;
  execute: (args: unknown) => Promise<string> | string;
  name: string;
  parameters: Record<string, unknown>;
}

export const localAgentTools = new Map<string, LocalAgentTool>([
  [
    "get_server_time",
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
  ],
]);

export function contextToText(context: Context[]): string | undefined {
  if (context.length === 0) {
    return undefined;
  }

  return context.map((item) => `${item.description}: ${item.value}`).join("\n");
}

export function normalizeToolParameters(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  return {
    type: "object",
    properties: {},
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
