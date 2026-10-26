import type { CustomEvent } from "@ag-ui/core";

/**
 * CUSTOM events the server emits for every model call when started with
 * `AGENT_DEBUG_EVENTS=on` (see `agents/src/loop/debug.ts`). A request and its
 * response share `runId` + `iteration`; a call that failed or was aborted has
 * no response.
 */
const MODEL_REQUEST_EVENT = "agent.debug.model_request";
const MODEL_RESPONSE_EVENT = "agent.debug.model_response";

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface PromptToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: string; value: unknown };
}

export type PromptPart = PromptTextPart | PromptToolCallPart | PromptToolResultPart;

/** A message exactly as the server sent it to the model. */
export type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user" | "assistant" | "tool"; content: PromptPart[] };

export interface ModelToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ModelRequest {
  prompt: PromptMessage[];
  tools?: ModelToolDef[];
  toolChoice?: unknown;
  temperature?: number;
}

export interface ModelResponse {
  content: PromptPart[];
  /** As the provider reports them; the shapes vary by provider. */
  finishReason?: unknown;
  usage?: unknown;
}

/** One round trip to the model. */
export interface ModelCall {
  key: string;
  runId: string;
  iteration: number;
  request: ModelRequest;
  requestedAt: number | undefined;
  response?: ModelResponse;
  respondedAt?: number;
}

/**
 * Folds a debug event into `calls`. Returns undefined for any other CUSTOM
 * event, so the caller can keep its state as is.
 */
export function applyDebugEvent(calls: ModelCall[], event: CustomEvent): ModelCall[] | undefined {
  if (event.name !== MODEL_REQUEST_EVENT && event.name !== MODEL_RESPONSE_EVENT) {
    return undefined;
  }
  const value = event.value as { runId: string; iteration: number };
  const key = `${value.runId}:${value.iteration}`;

  if (event.name === MODEL_REQUEST_EVENT) {
    const { prompt, tools, toolChoice, temperature } = event.value as ModelRequest;
    return [
      ...calls,
      {
        key,
        runId: value.runId,
        iteration: value.iteration,
        request: { prompt, tools, toolChoice, temperature },
        requestedAt: event.timestamp,
      },
    ];
  }

  const { content, finishReason, usage } = event.value as ModelResponse;
  return calls.map((call) =>
    call.key === key
      ? { ...call, response: { content, finishReason, usage }, respondedAt: event.timestamp }
      : call,
  );
}

/** `stop`, `tool-calls`, …: a plain string (spec v2) or `{ unified }` (spec v3). */
export function finishReasonLabel(finishReason: unknown): string | undefined {
  if (typeof finishReason === "string") {
    return finishReason;
  }
  if (isRecord(finishReason) && typeof finishReason.unified === "string") {
    return finishReason.unified;
  }
  return undefined;
}

/** Input/output token counts: plain numbers (spec v2) or `{ total }` (spec v3). */
export function tokenUsage(usage: unknown): { input?: number; output?: number } {
  if (!isRecord(usage)) {
    return {};
  }
  return { input: tokenCount(usage.inputTokens), output: tokenCount(usage.outputTokens) };
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (isRecord(value) && typeof value.total === "number") {
    return value.total;
  }
  return undefined;
}

/** Pretty-prints a value; a string holding JSON is parsed first. */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
