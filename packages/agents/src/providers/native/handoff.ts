import type { ModelFunctionTool, NativeLanguageModel } from "./types.ts";

/**
 * Agent-to-agent handoff for the native loop, modeled on the OpenAI Swarm /
 * Agents SDK pattern: each agent can expose a set of peers it may delegate to,
 * surfaced to the model as `transfer_to_<id>` tools. When the model calls one,
 * the loop swaps the *active* agent — its persona, model, and own handoff set —
 * for the rest of the run while keeping the conversation history intact.
 *
 * This module is the framework-free description of that: the runnable shape of
 * an agent, the tools that trigger a handoff, and the persona text that tells
 * the model the option exists.
 */

/** A peer an agent may hand off to, with the blurb shown on the transfer tool. */
export interface HandoffTarget {
  id: string;
  name: string;
  description?: string;
}

/**
 * An agent in a form the loop can actually run: resolved persona, model, and
 * the peers it may hand off to. {@link resolveAgent} turns a target id back into
 * one of these when a handoff fires.
 */
export interface RunnableAgent {
  id: string;
  name: string;
  /** Composed system prompt (instructions + skills catalog + handoff guidance). */
  persona: string | undefined;
  model: NativeLanguageModel;
  handoffs: HandoffTarget[];
}

const HANDOFF_TOOL_PREFIX = "transfer_to_";

/**
 * Tool name for handing off to `targetId`. Agent ids are sanitized to the
 * `[A-Za-z0-9_-]` set every provider accepts for function names, so an id with
 * spaces or punctuation can't produce an invalid tool declaration.
 */
export function handoffToolName(targetId: string): string {
  return `${HANDOFF_TOOL_PREFIX}${targetId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Model-facing handoff tools for one agent, plus the name→target-id lookup. */
export interface HandoffToolset {
  defs: ModelFunctionTool[];
  /** Maps a handoff tool name back to the agent id it transfers to. */
  targetByToolName: Map<string, string>;
}

/** Builds the `transfer_to_<id>` tools advertised while `agent` is active. */
export function buildHandoffToolset(agent: RunnableAgent): HandoffToolset {
  const defs: ModelFunctionTool[] = [];
  const targetByToolName = new Map<string, string>();

  for (const target of agent.handoffs) {
    const name = handoffToolName(target.id);
    // A sanitized-name collision (two ids mapping to the same tool name) would
    // make the second target unreachable; keep the first and skip the rest.
    if (targetByToolName.has(name)) {
      continue;
    }
    targetByToolName.set(name, target.id);
    defs.push({
      type: "function",
      name,
      description: handoffToolDescription(target),
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief note on why you are handing off and what the next agent should do.",
          },
        },
        additionalProperties: false,
      },
    });
  }

  return { defs, targetByToolName };
}

function handoffToolDescription(target: HandoffTarget): string {
  const blurb = target.description?.trim();
  return (
    `Hand off the conversation to the "${target.name}" agent. ` +
    (blurb ? `${blurb} ` : "") +
    "Use this when the user's request is better handled by them; that agent then takes over the conversation."
  );
}

/**
 * The "# Handoff" persona section listing an agent's delegation options, or
 * undefined when it has none. Folded into the system prompt so the model knows
 * the transfer tools exist and when to reach for them.
 */
export function composeHandoffGuidance(targets: HandoffTarget[]): string | undefined {
  if (targets.length === 0) {
    return undefined;
  }

  const lines = targets.map((target) => {
    const blurb = target.description?.trim();
    return `- **${target.name}** (\`${handoffToolName(target.id)}\`)${blurb ? `: ${blurb}` : ""}`;
  });

  return [
    "# Handoff",
    "",
    "You can transfer the conversation to a more specialized agent when the",
    "request falls outside your scope or squarely within a peer's. Call the",
    "matching transfer tool; that agent then takes over the conversation with",
    "the full history. Don't announce the transfer in prose — just call the tool.",
    "",
    "Agents you can hand off to:",
    ...lines,
  ].join("\n");
}

/** Tool-result text fed back to the model after a successful handoff. */
export function handoffResultText(target: RunnableAgent): string {
  return `Handed off to the "${target.name}" agent, which now continues the conversation.`;
}
