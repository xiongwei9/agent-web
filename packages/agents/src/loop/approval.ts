import { randomUUID } from "node:crypto";

import { EventType, type BaseEvent, type Message, type ToolCall } from "@ag-ui/core";
import type { Subscriber } from "rxjs";

import { HITL_REQUEST_APPROVAL_TOOL_NAME } from "../client-tools/hitl.ts";
import { aguiEvent } from "../shared/events.ts";
import { isRecord, tryParseJson } from "../shared/utils.ts";
import type { CollectedToolCall } from "./stream.ts";

/**
 * Enforced approval for server tools marked `requiresApproval` (e.g. MCP tools
 * annotated as destructive). The model doesn't decide whether to ask: the loop
 * holds the calls back and asks the user itself.
 *
 *   model calls a gated tool (call T)
 *     └─ T isn't run; the loop raises a `request_user_approval` call of its
 *        own (A, listing T) and suspends the run — the client renders A like
 *        any approval prompt and resumes with the decision as A's result
 *          └─ the resumed run settles T first: runs it if approved, else gives
 *             it a "not run" result, and emits TOOL_CALL_RESULT for T so the
 *             client's history carries T's outcome from then on
 *
 * A is the loop's, not the model's, so it is left out of every prompt
 * ({@link hideApprovalRequests}): the model sees T and T's result, nothing in
 * between. T only runs on an approval that is the last thing in the history
 * (nothing but tool results after it), so an old approval is never acted on
 * twice — e.g. when the run that ran T was cut off before the client got T's
 * result.
 */

/** Id prefix of the loop's approval calls; the model's are `call_…` (see `stream.ts`). */
const APPROVAL_CALL_PREFIX = "approval_";

/** How much of a call's arguments the approval prompt shows. */
const MAX_ARGS_PREVIEW_CHARS = 1_000;

/**
 * Asks the user to approve `calls`: emits one `request_user_approval` call
 * covering them all, which the client renders and answers. The run must
 * suspend right after.
 */
export function requestApproval(
  calls: CollectedToolCall[],
  subscriber: Subscriber<BaseEvent>,
): void {
  const toolCallId = `${APPROVAL_CALL_PREFIX}${randomUUID()}`;
  const single = calls.length === 1 ? calls[0] : undefined;
  const args = {
    title: single ? `Run ${single.toolName}` : `Run ${calls.length} tool calls`,
    summary: single
      ? `The assistant wants to run \`${single.toolName}\`, which needs your approval. It only runs if you approve.`
      : `The assistant wants to run ${calls.length} tool calls that need your approval. They only run if you approve.`,
    details: calls.map((call) => ({ label: call.toolName, value: previewArgs(call.rawInput) })),
    risk: "high",
    allowComment: true,
    // Read back when the decision arrives (see settleApprovals).
    toolCallIds: calls.map((call) => call.toolCallId),
  };

  subscriber.next(
    aguiEvent({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: HITL_REQUEST_APPROVAL_TOOL_NAME,
    }),
  );
  subscriber.next(
    aguiEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) }),
  );
  subscriber.next(aguiEvent({ type: EventType.TOOL_CALL_END, toolCallId }));
}

/** A held-back call whose approval was answered, and what to do with it now. */
export type SettledCall =
  | { call: CollectedToolCall; run: true }
  /** Not to be run; `result` tells the model why. */
  | { call: CollectedToolCall; run: false; result: string };

/**
 * The held-back calls that got an answer since they were held back: approved
 * ones to run now, the rest with the result they get instead. Calls that
 * already have a result (settled by an earlier run) are skipped.
 */
export function settleApprovals(messages: Message[]): SettledCall[] {
  const answered = new Set(
    messages.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
  );
  const calls = new Map<string, CollectedToolCall>();
  const requests = new Map<string, string[]>();
  const settled: SettledCall[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        const gated = approvalRequest(toolCall);
        if (gated) {
          requests.set(toolCall.id, gated);
        } else {
          calls.set(toolCall.id, {
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            rawInput: toolCall.function.arguments,
          });
        }
      }
      continue;
    }

    const gated = message.role === "tool" ? requests.get(message.toolCallId) : undefined;
    if (!gated) {
      continue;
    }
    const decision = readDecision(message.content);
    const current = messages.slice(index + 1).every((later) => later.role === "tool");
    for (const id of gated) {
      const call = calls.get(id);
      if (!call || answered.has(id)) {
        continue;
      }
      if (decision.approved && current) {
        settled.push({ call, run: true });
      } else {
        settled.push({ call, run: false, result: notRunResult(decision, current) });
      }
    }
  }

  return settled;
}

/**
 * The history as the model should see it: the loop's approval calls are
 * dropped, and each one's answer is replaced by `results` for the calls it
 * held back — right where the model's next turn picks up, after the calls.
 */
export function hideApprovalRequests(
  messages: Message[],
  results: ReadonlyMap<string, string>,
): Message[] {
  const requests = new Map<string, string[]>();
  const visible: Message[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      const toolCalls = message.toolCalls.filter((toolCall) => {
        const gated = approvalRequest(toolCall);
        if (gated) {
          requests.set(toolCall.id, gated);
        }
        return !gated;
      });
      if (toolCalls.length === message.toolCalls.length) {
        visible.push(message);
      } else if (toolCalls.length > 0 || message.content) {
        visible.push({ ...message, toolCalls });
      }
      continue;
    }

    const gated = message.role === "tool" ? requests.get(message.toolCallId) : undefined;
    if (!gated) {
      visible.push(message);
      continue;
    }
    for (const id of gated) {
      const result = results.get(id);
      if (result !== undefined) {
        visible.push({ id: `${id}-result`, role: "tool", toolCallId: id, content: result });
      }
    }
  }

  return visible;
}

/** The ids of the calls a loop-raised approval call holds back, or undefined for any other call. */
function approvalRequest(toolCall: ToolCall): string[] | undefined {
  if (
    !toolCall.id.startsWith(APPROVAL_CALL_PREFIX) ||
    toolCall.function.name !== HITL_REQUEST_APPROVAL_TOOL_NAME
  ) {
    return undefined;
  }
  const args = tryParseJson(toolCall.function.arguments);
  const ids = isRecord(args) ? args.toolCallIds : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : undefined;
}

interface Decision {
  approved: boolean;
  /** The user skipped the prompt (typed instead) rather than deciding. */
  cancelled: boolean;
  comment?: string;
}

/** Reads an answer in the `request_user_approval` result format (see `client-tools/hitl.ts`). */
function readDecision(content: unknown): Decision {
  const parsed = typeof content === "string" ? tryParseJson(content) : content;
  if (!isRecord(parsed)) {
    return { approved: false, cancelled: false };
  }
  return {
    approved: parsed.decision === "approved",
    cancelled: parsed.cancelled === true,
    comment: typeof parsed.comment === "string" && parsed.comment ? parsed.comment : undefined,
  };
}

function notRunResult(decision: Decision, current: boolean): string {
  const reason = decision.cancelled
    ? "The user didn't approve this call; they continued the conversation instead."
    : decision.approved && !current
      ? "This call was approved but didn't run, and the approval has lapsed. Ask again if it is still needed."
      : "The user rejected this call. Don't retry it or work around it; ask what to do instead.";
  return JSON.stringify({
    executed: false,
    reason,
    ...(decision.comment ? { comment: decision.comment } : {}),
  });
}

function previewArgs(rawInput: string): string {
  const parsed = tryParseJson(rawInput);
  const text = parsed === undefined ? rawInput : JSON.stringify(parsed, null, 2);
  return text.length > MAX_ARGS_PREVIEW_CHARS
    ? `${text.slice(0, MAX_ARGS_PREVIEW_CHARS)}…`
    : text || "{}";
}
