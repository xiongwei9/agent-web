import { randomUUID } from "node:crypto";

import { EventType, type BaseEvent } from "@ag-ui/core";
import type { Subscriber } from "rxjs";

import type { LanguageModel, ModelAssistantContentPart, ModelCallOptions } from "../model/types.ts";
import { aguiEvent } from "../shared/events.ts";
import { parseToolArguments } from "../shared/utils.ts";
import type { ServerTool } from "../tools/types.ts";

export interface CollectedToolCall {
  toolCallId: string;
  toolName: string;
  /** Raw JSON-string arguments as produced by the model. */
  rawInput: string;
}

export interface StreamTurn {
  assistantContent: ModelAssistantContentPart[];
  toolCalls: CollectedToolCall[];
  /** The provider's `finish` part, as reported (shapes vary by provider spec). */
  finish?: { finishReason: unknown; usage: unknown };
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
export async function streamTurn(
  model: LanguageModel,
  callOptions: ModelCallOptions,
  serverTools: Map<string, ServerTool>,
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
  let finish: StreamTurn["finish"];

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
        case "finish": {
          finish = { finishReason: part.finishReason, usage: part.usage };
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
      input: parseToolArguments(call.rawInput),
    });
  }

  return { assistantContent, toolCalls, finish };
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
