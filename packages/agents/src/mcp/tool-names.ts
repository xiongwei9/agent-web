import { createHash } from "node:crypto";

const MAX_TOOL_NAME_LENGTH = 64;

export function uniqueToolName(rawName: string, usedNames: Set<string>): string {
  let candidate = normalizeToolName(rawName);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  const hash = createHash("sha1").update(rawName).digest("hex").slice(0, 8);
  candidate = withHashSuffix(candidate, hash);
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = withHashSuffix(normalizeToolName(rawName), `${hash}_${counter}`);
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function normalizeToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  const fallback = normalized.replace(/^_+|_+$/g, "") || "mcp_tool";
  return fallback.length <= MAX_TOOL_NAME_LENGTH
    ? fallback
    : withHashSuffix(fallback, createHash("sha1").update(value).digest("hex").slice(0, 8));
}

function withHashSuffix(value: string, hash: string): string {
  const suffix = `_${hash}`;
  return `${value.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
