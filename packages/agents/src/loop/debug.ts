import { EventType, type BaseEvent } from "@ag-ui/core";

import type { ModelCallOptions } from "../model/types.ts";
import { aguiEvent } from "../shared/events.ts";
import type { StreamTurn } from "./stream.ts";

/**
 * AG-UI `CUSTOM` events that expose each model call verbatim, emitted with
 * `AgentConfig.modelCallEvents` on. They carry the full prompt (system prompt,
 * tool results) and the tool declarations, so the app decides where they go.
 *
 * A request and its response share `runId` + `iteration`. A call that fails or
 * is aborted mid-stream has a request and no response.
 */
export const MODEL_REQUEST_EVENT = "agent.debug.model_request";
export const MODEL_RESPONSE_EVENT = "agent.debug.model_response";

export function isModelCallEvent(event: BaseEvent): boolean {
  if (event.type !== EventType.CUSTOM) {
    return false;
  }
  const { name } = event as BaseEvent & { name?: unknown };
  return name === MODEL_REQUEST_EVENT || name === MODEL_RESPONSE_EVENT;
}

export function modelRequestEvent(
  runId: string,
  iteration: number,
  options: ModelCallOptions,
): BaseEvent {
  return aguiEvent({
    type: EventType.CUSTOM,
    name: MODEL_REQUEST_EVENT,
    value: {
      runId,
      iteration,
      // A copy: the loop keeps appending to its prompt after this call.
      prompt: [...options.prompt],
      tools: options.tools,
      toolChoice: options.toolChoice,
      temperature: options.temperature,
    },
  });
}

export function modelResponseEvent(runId: string, iteration: number, turn: StreamTurn): BaseEvent {
  return aguiEvent({
    type: EventType.CUSTOM,
    name: MODEL_RESPONSE_EVENT,
    value: {
      runId,
      iteration,
      content: turn.assistantContent,
      finishReason: turn.finish?.finishReason,
      usage: turn.finish?.usage,
    },
  });
}
