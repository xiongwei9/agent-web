export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse`, or undefined when `raw` isn't valid JSON. */
export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A tool call's raw JSON arguments; empty or unparseable input becomes `{}`. */
export function parseToolArguments(raw: string): unknown {
  return tryParseJson(raw) ?? {};
}

/** `JSON.stringify`, or undefined when the value can't be serialized (cycles, BigInt). */
export function safeStringify(value: unknown, indent?: number): string | undefined {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return undefined;
  }
}

/** Joins the non-blank parts with blank lines; undefined when none are left. */
export function joinSections(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  return kept.length > 0 ? kept.join("\n\n") : undefined;
}

/** A tool's JSON Schema parameters, defaulting to an empty object schema. */
export function normalizeToolParameters(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  return {
    type: "object",
    properties: {},
  };
}
