import { EventType, type BaseEvent, type Context, type Message, type Tool } from "@ag-ui/core";
import { Observable, type Subscriber } from "rxjs";

import { aguiEvent } from "../../events.ts";
import { buildModelToolDefs } from "./tools.ts";
import { buildPrompt } from "./prompt.ts";
import type {
  ModelAssistantContentPart,
  ModelCallOptions,
  ModelMessage,
  NativeLanguageModel,
  NativeTool,
} from "./types.ts";

const DEFAULT_MAX_TOOL_ITERATIONS = 16;

export interface RunOptions {
  threadId: string;
  runId: string;
  messages: Message[];
  clientTools: Tool[];
  context: Context[];
  persona: string | undefined;
  model: NativeLanguageModel;
  serverTools: Map<string, NativeTool>;
  maxToolIterations?: number;
  temperature?: number;
}

interface CollectedToolCall {
  toolCallId: string;
  toolName: string;
  /** Raw JSON-string arguments as produced by the model. */
  rawInput: string;
}

interface StreamTurn {
  assistantContent: ModelAssistantContentPart[];
  toolCalls: CollectedToolCall[];
}

/**
 * Runs the self-built agent loop and emits an AG-UI event stream.
 *
 * Unlike the Mastra provider — which delegates the agentic loop to Mastra's
 * `Agent` and adapts its output — this owns the loop end to end:
 *
 *   RUN_STARTED
 *   repeat up to `maxToolIterations`:
 *     stream the model → TEXT_MESSAGE_* / TOOL_CALL_* events
 *     if the model called server tools → execute them, emit TOOL_CALL_RESULT,
 *       append results to the prompt, and loop again
 *     if it called a client (HITL) tool → stop; the client fulfills it and
 *       resumes with a fresh run carrying the tool result
 *     otherwise → done
 *   RUN_FINISHED
 *
 * The returned Observable aborts the in-flight model request when unsubscribed
 * (e.g. the HTTP client disconnects).
 */
export function runNativeAgent(options: RunOptions): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abortController = new AbortController();
    void drive(subscriber, options, abortController.signal).then(
      () => subscriber.complete(),
      (error) => {
        if (!abortController.signal.aborted) {
          subscriber.error(error);
        } else {
          subscriber.complete();
        }
      },
    );

    return () => abortController.abort();
  });
}

async function drive(
  subscriber: Subscriber<BaseEvent>,
  options: RunOptions,
  abortSignal: AbortSignal,
): Promise<void> {
  const { threadId, runId, serverTools } = options;

  subscriber.next(aguiEvent({ type: EventType.RUN_STARTED, threadId, runId }));

  const prompt = buildPrompt(options.messages, options.persona, options.context);
  const toolDefs = buildModelToolDefs(serverTools, options.clientTools);
  const maxIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const callOptions: ModelCallOptions = {
      prompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      toolChoice: toolDefs.length > 0 ? { type: "auto" } : undefined,
      temperature: options.temperature,
      abortSignal,
    };

    const turn = await streamTurn(options.model, callOptions, serverTools, subscriber);
    if (abortSignal.aborted) {
      return;
    }

    if (turn.assistantContent.length > 0) {
      prompt.push({ role: "assistant", content: turn.assistantContent });
    }

    if (turn.toolCalls.length === 0) {
      break;
    }

    // A client (HITL) tool can't be executed here — finish the run and let the
    // client fulfill it and resume. The TOOL_CALL_* events were already emitted.
    const hasClientCall = turn.toolCalls.some((call) => !serverTools.has(call.toolName));
    if (hasClientCall) {
      break;
    }

    for (const call of turn.toolCalls) {
      const result = await executeServerTool(serverTools, call);
      // Hidden tools (e.g. skills plumbing) feed their result back to the model
      // but emit no AG-UI result event — matching the suppressed start/args/end.
      if (!serverTools.get(call.toolName)?.hidden) {
        subscriber.next(
          aguiEvent({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${call.toolCallId}-result`,
            toolCallId: call.toolCallId,
            content: result,
            role: "tool",
          }),
        );
      }
      prompt.push(toToolResultMessage(call, result));
    }
  }

  subscriber.next(aguiEvent({ type: EventType.RUN_FINISHED, threadId, runId }));
}

/**
 * Consumes one model stream, forwarding text and tool-call deltas as AG-UI
 * events, and returns the assistant content plus the tool calls the model made.
 *
 * Providers differ in how they surface tool calls: some stream
 * `tool-input-start/delta/end`, others emit only the terminal `tool-call`. We
 * normalize both: AG-UI `TOOL_CALL_START/ARGS/END` is emitted exactly once per
 * call regardless of which parts arrive.
 */
async function streamTurn(
  model: NativeLanguageModel,
  callOptions: ModelCallOptions,
  serverTools: Map<string, NativeTool>,
  subscriber: Subscriber<BaseEvent>,
): Promise<StreamTurn> {
  const { stream } = await model.doStream(callOptions);
  const reader = stream.getReader();

  let textMessageId: string | undefined;
  let textBuffer = "";
  const started = new Set<string>();
  const ended = new Set<string>();
  // Tool calls whose AG-UI events are suppressed (hidden server tools). They
  // are still collected and executed; only their TOOL_CALL_* events are skipped.
  const hidden = new Set<string>();
  const toolCalls: CollectedToolCall[] = [];

  const startToolCall = (id: string, toolName: string) => {
    if (started.has(id)) {
      return;
    }
    started.add(id);
    if (serverTools.get(toolName)?.hidden) {
      hidden.add(id);
      return;
    }
    subscriber.next(
      aguiEvent({
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: toolName,
        ...(textMessageId ? { parentMessageId: textMessageId } : {}),
      }),
    );
  };

  const endToolCall = (id: string) => {
    if (ended.has(id) || !started.has(id)) {
      return;
    }
    ended.add(id);
    if (hidden.has(id)) {
      return;
    }
    subscriber.next(aguiEvent({ type: EventType.TOOL_CALL_END, toolCallId: id }));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const part = value;
      switch (part.type) {
        case "text-start": {
          textMessageId = part.id;
          subscriber.next(
            aguiEvent({
              type: EventType.TEXT_MESSAGE_START,
              messageId: part.id,
              role: "assistant",
            }),
          );
          break;
        }
        case "text-delta": {
          textBuffer += part.delta;
          subscriber.next(
            aguiEvent({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: part.id,
              delta: part.delta,
            }),
          );
          break;
        }
        case "text-end": {
          subscriber.next(aguiEvent({ type: EventType.TEXT_MESSAGE_END, messageId: part.id }));
          break;
        }
        case "tool-input-start": {
          startToolCall(part.id, part.toolName);
          break;
        }
        case "tool-input-delta": {
          if (started.has(part.id) && !hidden.has(part.id)) {
            subscriber.next(
              aguiEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: part.id, delta: part.delta }),
            );
          }
          break;
        }
        case "tool-input-end": {
          endToolCall(part.id);
          break;
        }
        case "tool-call": {
          // Terminal, fully-assembled call. If the provider never streamed the
          // incremental parts, synthesize START + ARGS now so the client still
          // sees the arguments.
          if (!started.has(part.toolCallId)) {
            startToolCall(part.toolCallId, part.toolName);
            if (!hidden.has(part.toolCallId)) {
              subscriber.next(
                aguiEvent({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: part.toolCallId,
                  delta: part.input,
                }),
              );
            }
          }
          endToolCall(part.toolCallId);
          toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            rawInput: part.input,
          });
          break;
        }
        case "error": {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        default:
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const assistantContent: ModelAssistantContentPart[] = [];
  if (textBuffer.length > 0) {
    assistantContent.push({ type: "text", text: textBuffer });
  }
  for (const call of toolCalls) {
    assistantContent.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: parseArguments(call.rawInput),
    });
  }

  return { assistantContent, toolCalls };
}

async function executeServerTool(
  serverTools: Map<string, NativeTool>,
  call: CollectedToolCall,
): Promise<string> {
  const tool = serverTools.get(call.toolName);
  if (!tool) {
    return `Error: tool "${call.toolName}" is not available.`;
  }

  try {
    const args = parseArguments(call.rawInput);
    return await tool.execute(isPlainObject(args) ? args : {});
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function toToolResultMessage(call: CollectedToolCall, result: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: result },
      },
    ],
  };
}

function parseArguments(raw: string): unknown {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
