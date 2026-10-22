import type { ModelFunctionTool } from "../model/types.ts";

/** A server-side tool the loop executes itself (local builtins, skills, MCP). */
export interface ServerTool {
  name: string;
  description: string;
  /** JSON Schema (draft-07) describing the tool's arguments. */
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<string> | string;
  /**
   * When true, the loop still executes the tool and feeds its result back to
   * the model, but suppresses every AG-UI `TOOL_CALL_*` event for it. Used for
   * internal plumbing the UI shouldn't render — e.g. the Agent Skills tools.
   */
  hidden?: boolean;
  /**
   * How code mode's scripts call the tool, when it can hand them more than
   * `execute`'s text: `execute` resolves to the value the script receives —
   * described by `outputSchema` when given — and throws on a tool-level
   * failure. Without it, scripts receive `execute`'s text.
   */
  code?: {
    outputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<unknown>;
  };
}

export interface ToolExecutionContext {
  /** Aborted when the run is (e.g. the client disconnected); long-running tools should stop. */
  signal: AbortSignal;
}

/** Outcome of validating a client-fulfilled tool call's raw arguments. */
export type ToolArgsValidation = { ok: true } | { ok: false; error: string };

/**
 * A tool the server declares to the model but the *client* fulfills — the A2UI
 * render tool and the HITL prompts. The loop advertises `def` alongside the
 * server tools, then suspends the run when one is called so the client can
 * render it and resume with the user's response.
 */
export interface FrontendTool {
  def: ModelFunctionTool;
  /**
   * Optional argument check. A failure is fed back to the model as the call's
   * tool result (`error` is shown verbatim) so it can self-correct, instead of
   * handing the client a prompt it can't render.
   */
  validate?: (rawArgs: string) => ToolArgsValidation;
  /**
   * Replays this tool's past calls as conversation instead of a tool round
   * trip: the call becomes assistant text and the client's answer a user
   * message. For tools whose "result" is really the user's next turn (an A2UI
   * interaction). Default: replayed as a tool call plus its tool result.
   */
  replayAsText?: {
    call: (rawArgs: string) => string;
    result: (content: string | undefined) => string;
  };
  /**
   * The result backfilled when the client never answered a call (the user
   * typed instead), since providers reject a tool call without a result.
   * Default: a generic "not completed" note.
   */
  unansweredResult?: string;
}
