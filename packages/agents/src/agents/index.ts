import { loadAllMarkdownAgents } from "./loader.js";
import type { AgentSpec } from "./types.js";

/**
 * Agents are defined as `*.md` files in this directory with YAML frontmatter
 * (`id`, optional `name` / `model`) and a markdown body that becomes the
 * system prompt / `instructions`. Drop a file → it shows up here.
 *
 * If a file with `id: default` exists, that agent is the fallback when a
 * request does not specify `agentId`; otherwise the first file (alphabetical)
 * wins.
 */
const SPECS: readonly AgentSpec[] = loadAllMarkdownAgents();

if (SPECS.length === 0) {
  throw new Error(
    "No agent definitions found in packages/agents/src/agents (*.md).",
  );
}

export const agentSpecs: readonly AgentSpec[] = SPECS;

const FALLBACK = SPECS.find((spec) => spec.id === "default") ?? SPECS[0]!;
export const defaultAgentId: string = FALLBACK.id;

export type { AgentSpec } from "./types.js";
