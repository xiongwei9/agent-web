import { EventType, type BaseEvent, type Context, type Message, type Tool } from "@ag-ui/core";
import { Observable, type Subscriber } from "rxjs";

import { aguiEvent } from "../shared/events.ts";
import type { AgentLogger } from "../types.ts";
import { consoleLogger } from "../shared/logger.ts";
import { buildModelToolDefs } from "../tools/toolset.ts";
import { hideApprovalRequests, requestApproval, settleApprovals } from "./approval.ts";
import { modelRequestEvent, modelResponseEvent } from "./debug.ts";
import { buildPrompt } from "./prompt.ts";
import { streamTurn, type CollectedToolCall } from "./stream.ts";
import { isRecord, parseToolArguments } from "../shared/utils.ts";
import {
  compactPromptIfNeeded,
  resolveCompactionOptions,
  type CompactionCache,
  type CompactionOptions,
} from "./compaction.ts";
import type { ModelCallOptions, ModelMessage, LanguageModel } from "../model/types.ts";
import type { FrontendTool, ServerTool } from "../tools/types.ts";

/** Context window assumed when a caller passes no resolved compaction options. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

export interface RunOptions {
  threadId: string;
  runId: string;
  messages: Message[];
  clientTools: Tool[];
  context: Context[];
  persona: string | undefined;
  model: LanguageModel;
  serverTools: Map<string, ServerTool>;
  /**
   * Server-declared, client-fulfilled tools (A2UI, HITL). Advertised like any
   * tool; calling one suspends the run for the client.
   */
  frontendTools?: ReadonlyMap<string, FrontendTool>;
  /** Rewrites user messages' text for the model (e.g. `/skill-name` commands). */
  expandUserText?: (text: string) => string;
  /** Rounds of tool calls allowed before a final, tools-disabled turn. */
  maxToolIterations: number;
  temperature?: number;
  /** Resolved context compaction settings. Omit for defaults (128k window). */
  compaction?: CompactionOptions;
  /** Remembers each thread's summary across runs; omit to summarize per run. */
  compactionCache?: CompactionCache;
  logger?: AgentLogger;
  /** Emit each model call's request and response as CUSTOM events (see debug.ts). */
  debugEvents?: boolean;
}

/**
 * Runs the self-built agent loop and emits an AG-UI event stream.
 *
 * No agent framework is involved — this owns the loop end to end:
 *
 *   RUN_STARTED
 *   repeat up to `maxToolIterations` rounds of tool calls (then one last turn
 *   with tools disabled, so the run ends with an answer):
 *     stream the model → TEXT_MESSAGE_* / TOOL_CALL_* events
 *     if the model called server tools → execute them, emit TOOL_CALL_RESULT,
 *       append results to the prompt, and loop again
 *     if it called a client tool (an A2UI surface, a Human-in-the-Loop prompt,
 *       or a tool the request declared) → suspend; the client fulfills it and
 *       resumes with a fresh run carrying the user's response
 *     if it called a server tool that requires approval → ask the user and
 *       suspend; the resumed run runs it first if approved (see approval.ts)
 *     otherwise → done
 *   RUN_FINISHED
 *
 * The returned Observable aborts the in-flight model request when unsubscribed
 * (e.g. the HTTP client disconnects).
 */
export function runAgentLoop(options: RunOptions): Observable<BaseEvent> {
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

  // Resuming from an approval prompt: settle the calls it held back before
  // the model's next turn, so the model sees how they went.
  const settledResults = new Map<string, string>();
  for (const settled of settleApprovals(options.messages)) {
    const result = settled.run
      ? await executeServerTool(serverTools, settled.call, abortSignal)
      : settled.result;
    if (abortSignal.aborted) {
      return;
    }
    subscriber.next(toolCallResultEvent(settled.call, result));
    settledResults.set(settled.call.toolCallId, result);
  }

  // Frontend tools are advertised like any other tool; because they aren't
  // server tools, calling one takes the client-tool path below and suspends
  // the run.
  const frontendTools = options.frontendTools ?? new Map<string, FrontendTool>();
  let prompt = buildPrompt(
    hideApprovalRequests(options.messages, settledResults),
    options.persona,
    options.context,
    frontendTools,
    options.expandUserText,
  );
  const toolDefs = buildModelToolDefs(
    serverTools,
    options.clientTools,
    [...frontendTools.values()].map((tool) => tool.def),
  );
  const maxToolRounds = options.maxToolIterations;
  const compaction =
    options.compaction ?? resolveCompactionOptions(undefined, FALLBACK_CONTEXT_WINDOW);
  const logger = options.logger ?? consoleLogger;
  const memory = options.compactionCache ? { cache: options.compactionCache, threadId } : undefined;

  for (let iteration = 0; ; iteration += 1) {
    // Out of tool rounds: one more turn with tools disabled, so the model
    // answers from the results it already has instead of the run just ending.
    const toolsExhausted = iteration >= maxToolRounds;
    // Keep the running prompt inside the context window. Compaction summarizes
    // the older messages (long history *or* accumulated tool-call rounds) and
    // replaces them with a brief, so a deep loop doesn't overflow the model.
    const compactedPrompt = await compactPromptIfNeeded(
      prompt,
      options.model,
      compaction,
      abortSignal,
      memory,
    );
    if (abortSignal.aborted) {
      return;
    }
    if (compactedPrompt !== prompt) {
      logger.info(
        `[agent] compacted prompt (runId=${runId}, iteration=${iteration}): ` +
          `${prompt.length} → ${compactedPrompt.length} messages`,
      );
      prompt = compactedPrompt;
    }

    const callOptions: ModelCallOptions = {
      prompt,
      // Keep the tools declared even on the final turn: the history has tool
      // calls, and some providers reject those without matching declarations.
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      toolChoice: toolDefs.length > 0 ? { type: toolsExhausted ? "none" : "auto" } : undefined,
      temperature: options.temperature,
      abortSignal,
    };

    logger.debug(
      `[agent] → LLM request (runId=${runId}, iteration=${iteration})\n` +
        JSON.stringify(callOptions.prompt, null, 2),
    );
    if (options.debugEvents) {
      subscriber.next(modelRequestEvent(runId, iteration, callOptions));
    }

    // Models number their stream parts per-response (the first text block is
    // always id "0"), so the same ids recur across runs and iterations.
    // `streamTurn` maps each raw part id to a fresh, self-contained id so AG-UI
    // message/tool ids stay globally unique — otherwise the client merges
    // consecutive assistant replies into one message.
    const turn = await streamTurn(options.model, callOptions, serverTools, subscriber);
    if (abortSignal.aborted) {
      return;
    }

    logger.debug(
      `[agent] ← LLM response (runId=${runId}, iteration=${iteration})\n` +
        JSON.stringify(turn.assistantContent, null, 2),
    );
    if (options.debugEvents) {
      subscriber.next(modelResponseEvent(runId, iteration, turn));
    }

    if (turn.assistantContent.length > 0) {
      prompt.push({ role: "assistant", content: turn.assistantContent });
    }

    if (turn.toolCalls.length === 0) {
      break;
    }
    if (toolsExhausted) {
      // The provider ignored `toolChoice: none`. Leave the calls unanswered
      // (the next run's prompt backfills them) rather than loop forever.
      logger.warn(
        `[agent] model called tools after the ${maxToolRounds}-round limit (runId=${runId}); ending the run`,
      );
      break;
    }

    // Client-fulfilled calls can't run here. Validate the ones we declared
    // ourselves first: a malformed call is bounced back to the model so it can
    // self-correct, rather than handing the client a prompt it can't render.
    const invalidCalls = new Map<string, string>();
    const pendingCalls: CollectedToolCall[] = [];
    for (const call of turn.toolCalls) {
      if (serverTools.has(call.toolName)) {
        continue;
      }
      const validation = frontendTools.get(call.toolName)?.validate?.(call.rawInput);
      if (validation && !validation.ok) {
        invalidCalls.set(call.toolCallId, validation.error);
      } else {
        pendingCalls.push(call);
      }
    }

    // Answer every call we can before the model's next turn: server tools run,
    // invalid client calls get their error back. Only `pendingCalls` and the
    // calls held back for approval are left open — the client answers those
    // when it resumes the run, which keeps the resumed history well-formed
    // even when the model mixed them with server tools in the same turn.
    const gatedCalls: CollectedToolCall[] = [];
    for (const call of turn.toolCalls) {
      const invalidReason = invalidCalls.get(call.toolCallId);
      if (invalidReason !== undefined) {
        subscriber.next(toolCallResultEvent(call, invalidReason));
        prompt.push(toToolResultMessage(call, invalidReason));
        continue;
      }

      const tool = serverTools.get(call.toolName);
      if (!tool) {
        continue;
      }
      if (tool.requiresApproval) {
        gatedCalls.push(call);
        continue;
      }

      const result = await executeServerTool(serverTools, call, abortSignal);
      if (abortSignal.aborted) {
        return;
      }
      // Hidden tools (e.g. skills plumbing) feed their result back to the model
      // but emit no AG-UI result event — matching the suppressed start/args/end.
      if (!tool.hidden) {
        subscriber.next(toolCallResultEvent(call, result));
      }
      prompt.push(toToolResultMessage(call, result));
    }

    if (gatedCalls.length > 0) {
      requestApproval(gatedCalls, subscriber);
    }

    // Suspend the run for the client: it renders the surface / HITL prompt and
    // resumes with the user's response. The TOOL_CALL_* events are already out.
    if (pendingCalls.length > 0 || gatedCalls.length > 0) {
      break;
    }
  }

  subscriber.next(aguiEvent({ type: EventType.RUN_FINISHED, threadId, runId }));
}

async function executeServerTool(
  serverTools: Map<string, ServerTool>,
  call: CollectedToolCall,
  signal: AbortSignal,
): Promise<string> {
  const tool = serverTools.get(call.toolName);
  if (!tool) {
    return `Error: tool "${call.toolName}" is not available.`;
  }

  try {
    const args = parseToolArguments(call.rawInput);
    return await tool.execute(isRecord(args) ? args : {}, { signal });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function toolCallResultEvent(call: CollectedToolCall, result: string): BaseEvent {
  return aguiEvent({
    type: EventType.TOOL_CALL_RESULT,
    messageId: `${call.toolCallId}-result`,
    toolCallId: call.toolCallId,
    content: result,
    role: "tool",
  });
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
