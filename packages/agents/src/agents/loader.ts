import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYAML } from "yaml";

import type { AgentSpec } from "./types.ts";

const DEFINITIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "definitions");

/**
 * Reads every `*.md` file in `./definitions/` and parses it as an agent
 * definition. Each file must start with a YAML frontmatter block; the
 * remaining body becomes the agent's `instructions`.
 *
 * Build note: `dist/agents/definitions/` must mirror the source folder so the
 * compiled package can read the same files. The package build script handles
 * the copy.
 */
export function loadAllMarkdownAgents(): AgentSpec[] {
  const files = readdirSync(DEFINITIONS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
  return files.map((name) =>
    parseAgentMarkdown(name, readFileSync(join(DEFINITIONS_DIR, name), "utf8")),
  );
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseAgentMarkdown(filename: string, raw: string): AgentSpec {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${filename}: missing YAML frontmatter delimited by '---' lines.`);
  }
  const [, head, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYAML(head!);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${filename}: invalid YAML frontmatter — ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filename}: frontmatter must be a YAML mapping (key/value object).`);
  }

  const meta = parsed as Record<string, unknown>;
  const id = meta.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${filename}: frontmatter is missing required \`id\` (non-empty string).`);
  }

  const instructions = body?.trim();
  return {
    id,
    name: typeof meta.name === "string" ? meta.name : undefined,
    model: typeof meta.model === "string" ? meta.model : undefined,
    instructions: instructions ? instructions : undefined,
  };
}
