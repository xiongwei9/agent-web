import type { Context } from "@ag-ui/core";

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
