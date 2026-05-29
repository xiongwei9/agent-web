/**
 * Minimal, framework-free view of the model + tool contracts the native agent
 * loop depends on.
 *
 * The Mastra provider hands models to Mastra's `Agent`, which owns the agentic
 * loop. The native provider instead drives the model directly, so it needs the
 * low-level streaming surface of the underlying `@ai-sdk/*` model. Rather than
 * import that surface from `@ai-sdk/provider` — whose major version differs per
 * model package (Anthropic/Google pin v2, OpenAI v3) — we declare the
 * structural subset we actually touch here. The v2 and v3 specs are identical
 * for these members, so one local interface drives all three providers and we
 * stay decoupled from their transitive versions.
 */

/** A server-side tool the loop executes itself (local builtins + MCP). */
export interface NativeTool {
  name: string;
  description: string;
  /** JSON Schema (draft-07) describing the tool's arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  /**
   * When true, the loop still executes the tool and feeds its result back to
   * the model, but suppresses every AG-UI `TOOL_CALL_*` event for it. Used for
   * internal plumbing the UI shouldn't render — e.g. the Agent Skills tools.
   */
  hidden?: boolean;
}

export interface ModelTextPart {
  type: "text";
  text: string;
}

export interface ModelToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Parsed argument object (not the JSON string). */
  input: unknown;
}

export interface ModelToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string };
}

export type ModelAssistantContentPart = ModelTextPart | ModelToolCallPart;

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ModelTextPart[] }
  | { role: "assistant"; content: ModelAssistantContentPart[] }
  | { role: "tool"; content: ModelToolResultPart[] };

export interface ModelFunctionTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ModelToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

export interface ModelCallOptions {
  prompt: ModelMessage[];
  tools?: ModelFunctionTool[];
  toolChoice?: ModelToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
}

/**
 * The subset of the model stream we consume. The full spec emits more part
 * types (reasoning, files, sources, raw, finish, …); those arrive at runtime
 * but aren't modeled here — the loop's `switch` ignores any it doesn't list.
 */
export type ModelStreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "error"; error: unknown };

export interface NativeLanguageModel {
  doStream: (options: ModelCallOptions) => PromiseLike<{ stream: ReadableStream<ModelStreamPart> }>;
}
