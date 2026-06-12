import { randomUUID } from "node:crypto";

import { EventType, type BaseEvent, type Context, type Message, type Tool } from "@ag-ui/core";
import { Observable, type Subscriber } from "rxjs";

import { aguiEvent } from "../../events.ts";
import { A2UI_RENDER_TOOL_NAME, a2uiRenderToolDef, validateA2uiMessages } from "./a2ui.ts";
import { buildModelToolDefs } from "./tools.ts";
import { buildPrompt } from "./prompt.ts";
import {
  compactPromptIfNeeded,
  resolveCompactionOptions,
  type CompactionOptions,
} from "./compaction.ts";
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
  /** Context compaction settings; merged onto defaults. Omit to use defaults. */
  compaction?: Partial<CompactionOptions>;
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
 *       resumes with a fresh run carrying the user's response
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

  let prompt = buildPrompt(options.messages, options.persona, options.context);
  // `render_a2ui` is advertised here but not registered as a server tool, so the
  // loop's client-tool path stops the run when it's called and the client renders
  // the A2UI surface (then resumes via a `user` message with the user's action).
  const toolDefs = buildModelToolDefs(serverTools, options.clientTools, [a2uiRenderToolDef()]);
  const maxIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const compaction = resolveCompactionOptions(options.compaction);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // Keep the running prompt inside the context window. Compaction summarizes
    // the older messages (long history *or* accumulated tool-call rounds) and
    // replaces them with a brief, so a deep loop doesn't overflow the model.
    const compactedPrompt = await compactPromptIfNeeded(
      prompt,
      options.model,
      compaction,
      abortSignal,
    );
    if (abortSignal.aborted) {
      return;
    }
    if (compactedPrompt !== prompt) {
      console.log(
        `[native-agent] ⊙ compacted prompt (runId=${runId}, iteration=${iteration}): ` +
          `${prompt.length} → ${compactedPrompt.length} messages`,
      );
      prompt = compactedPrompt;
    }

    const callOptions: ModelCallOptions = {
      prompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      toolChoice: toolDefs.length > 0 ? { type: "auto" } : undefined,
      temperature: options.temperature,
      abortSignal,
    };

    console.log(
      `[native-agent] → LLM request (runId=${runId}, iteration=${iteration})\n` +
        JSON.stringify(callOptions.prompt, null, 2),
    );

    // Models number their stream parts per-response (the first text block is
    // always id "0"), so the same ids recur across runs and iterations.
    // `streamTurn` maps each raw part id to a fresh, self-contained id so AG-UI
    // message/tool ids stay globally unique — otherwise the client merges
    // consecutive assistant replies into one message.
    const turn = await streamTurn(options.model, callOptions, serverTools, subscriber);
    if (abortSignal.aborted) {
      return;
    }

    console.log(
      `[native-agent] ← LLM response (runId=${runId}, iteration=${iteration})\n` +
        JSON.stringify(turn.assistantContent, null, 2),
    );

    if (turn.assistantContent.length > 0) {
      prompt.push({ role: "assistant", content: turn.assistantContent });
    }

    if (turn.toolCalls.length === 0) {
      break;
    }

    // Validate every `render_a2ui` call against the official A2UI schema before
    // we hand anything off. A VALID surface is client-fulfilled; an INVALID one
    // is bounced back to the model (below) so it fixes the JSON and re-emits,
    // rather than streaming broken UI to the client.
    const a2uiErrors = new Map<string, string>();
    for (const call of turn.toolCalls) {
      if (call.toolName !== A2UI_RENDER_TOOL_NAME) {
        continue;
      }
      const validation = validateA2uiMessages(call.rawInput);
      if (!validation.ok) {
        a2uiErrors.set(call.toolCallId, validation.error);
      }
    }

    // Nothing to fix: a valid `render_a2ui` (or any other client/HITL tool) can't
    // be executed here — finish the run and let the client fulfill it and resume.
    // The TOOL_CALL_* events were already emitted.
    if (a2uiErrors.size === 0 && turn.toolCalls.some((call) => !serverTools.has(call.toolName))) {
      break;
    }

    for (const call of turn.toolCalls) {
      if (call.toolName === A2UI_RENDER_TOOL_NAME) {
        const error = a2uiErrors.get(call.toolCallId);
        if (error === undefined) {
          // Valid surface mixed with an invalid sibling (rare): the client will
          // render it on resume, so don't execute or bounce it here.
          continue;
        }
        const message =
          `A2UI validation failed; fix the JSON and call ${A2UI_RENDER_TOOL_NAME} again. ` +
          `The messages ${error}`;
        subscriber.next(
          aguiEvent({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${call.toolCallId}-result`,
            toolCallId: call.toolCallId,
            content: message,
            role: "tool",
          }),
        );
        prompt.push(toToolResultMessage(call, message));
        continue;
      }

      // Other client (HITL) tools can't run here; only reachable when bundled with
      // an invalid render_a2ui that kept the run going. Leave them for a resume.
      if (!serverTools.has(call.toolName)) {
        continue;
      }

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

  // Map each raw model part id to a fresh, self-contained id. Model part ids
  // recur across runs and iterations (the first text block is always "0"), so
  // surfacing them directly would let the client merge unrelated messages. We
  // mint one id per raw id and reuse it across that part's start/delta/end:
  //   - text messages → `msg_<uuid>`
  //   - tool calls     → `call_<uuid>`, which also stays within Bedrock's
  //                       64-char toolUseId limit.
  // Text and tool ids are tracked separately so a collision between a text
  // block and a tool call sharing a raw id (e.g. both "0") can't alias them.
  const messageIds = new Map<string, string>();
  const toolCallIds = new Map<string, string>();
  const qualifyMessage = (id: string): string => mint(messageIds, "msg", id);
  const qualifyToolCall = (id: string): string => mint(toolCallIds, "call", id);

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
          textMessageId = qualifyMessage(part.id);
          subscriber.next(
            aguiEvent({
              type: EventType.TEXT_MESSAGE_START,
              messageId: textMessageId,
              role: "assistant",
            }),
          );
          break;
        }
        case "text-delta": {
          // Providers emit empty deltas at stream boundaries or as keep-alive
          // chunks; forwarding them would spam the client with no-op events.
          if (part.delta.length === 0) {
            break;
          }
          textBuffer += part.delta;
          subscriber.next(
            aguiEvent({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: qualifyMessage(part.id),
              delta: part.delta,
            }),
          );
          break;
        }
        case "text-end": {
          subscriber.next(
            aguiEvent({ type: EventType.TEXT_MESSAGE_END, messageId: qualifyMessage(part.id) }),
          );
          break;
        }
        case "tool-input-start": {
          startToolCall(qualifyToolCall(part.id), part.toolName);
          break;
        }
        case "tool-input-delta": {
          const toolCallId = qualifyToolCall(part.id);
          if (started.has(toolCallId) && !hidden.has(toolCallId)) {
            subscriber.next(
              aguiEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: part.delta }),
            );
          }
          break;
        }
        case "tool-input-end": {
          endToolCall(qualifyToolCall(part.id));
          break;
        }
        case "tool-call": {
          // Terminal, fully-assembled call. If the provider never streamed the
          // incremental parts, synthesize START + ARGS now so the client still
          // sees the arguments.
          const toolCallId = qualifyToolCall(part.toolCallId);
          if (!started.has(toolCallId)) {
            startToolCall(toolCallId, part.toolName);
            if (!hidden.has(toolCallId)) {
              subscriber.next(
                aguiEvent({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId,
                  delta: part.input,
                }),
              );
            }
          }
          endToolCall(toolCallId);
          toolCalls.push({
            toolCallId,
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

/**
 * Returns a stable id for `rawId`, minting `${prefix}_<uuid>` on first sight and
 * reusing it thereafter so a part's start/delta/end events all share one id.
 */
function mint(cache: Map<string, string>, prefix: string, rawId: string): string {
  let mapped = cache.get(rawId);
  if (mapped === undefined) {
    mapped = `${prefix}_${randomUUID()}`;
    cache.set(rawId, mapped);
  }
  return mapped;
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
