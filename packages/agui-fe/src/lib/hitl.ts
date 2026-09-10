import type { Message } from "@ag-ui/core";

/**
 * Human-in-the-Loop (HITL) tool calls.
 *
 * The agent declares two client-fulfilled tools (see
 * `packages/agents/src/providers/native/hitl.ts`): one to ask a question, one to
 * request approval before acting. Calling either suspends the run — the server
 * streams the `TOOL_CALL_*` events and finishes — so the browser owns the rest
 * of the round-trip: render the prompt, capture the answer, then resume with a
 * `tool` message carrying that answer for the same `toolCallId`.
 *
 * This module is the wire contract: parse a call's arguments into something
 * renderable, and format the user's response the way the agent's prompt says it
 * will arrive.
 */
export const ASK_USER_TOOL_NAME = "ask_user";
export const REQUEST_APPROVAL_TOOL_NAME = "request_user_approval";

export interface HitlOption {
  label: string;
  value: string;
  description?: string;
}

export interface AskUserRequest {
  kind: "ask";
  question: string;
  details?: string;
  options: HitlOption[];
  /** Multi-select; only meaningful alongside `options`. */
  allowMultiple: boolean;
  /** Offer a free-text field next to the options. */
  allowOther: boolean;
  placeholder?: string;
}

export interface ApprovalRequest {
  kind: "approval";
  title: string;
  summary: string;
  details: { label: string; value: string }[];
  risk: "low" | "medium" | "high";
  confirmLabel: string;
  rejectLabel: string;
  allowComment: boolean;
}

export type HitlRequest = AskUserRequest | ApprovalRequest;

/** An unanswered HITL tool call, waiting on the user. */
export interface PendingHitlCall {
  toolCallId: string;
  toolName: string;
}

export function isHitlToolName(name: string): boolean {
  return name === ASK_USER_TOOL_NAME || name === REQUEST_APPROVAL_TOOL_NAME;
}

/**
 * Parses a HITL tool call's arguments into a renderable request. Returns
 * undefined while the arguments are still streaming (invalid JSON) or if the
 * call isn't a HITL one, so the caller keeps showing the generic tool card until
 * the full prompt has arrived.
 */
export function parseHitlRequest(toolName: string, args: string): HitlRequest | undefined {
  if (!isHitlToolName(toolName) || !args) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  if (toolName === ASK_USER_TOOL_NAME) {
    const question = asString(parsed.question);
    if (!question) {
      return undefined;
    }
    const options = asArray(parsed.options).flatMap((option) => {
      if (!isRecord(option)) {
        return [];
      }
      const label = asString(option.label);
      const value = asString(option.value);
      return label && value ? [{ label, value, description: asString(option.description) }] : [];
    });
    return {
      kind: "ask",
      question,
      details: asString(parsed.details),
      options,
      allowMultiple: parsed.allowMultiple === true && options.length > 0,
      // With no options there is nothing to pick, so the free-text field is the
      // only way to answer — show it whether or not the agent asked for it.
      allowOther: parsed.allowOther === true || options.length === 0,
      placeholder: asString(parsed.placeholder),
    };
  }

  const title = asString(parsed.title);
  const summary = asString(parsed.summary);
  if (!title || !summary) {
    return undefined;
  }
  const risk = parsed.risk;
  return {
    kind: "approval",
    title,
    summary,
    details: asArray(parsed.details).flatMap((detail) => {
      if (!isRecord(detail)) {
        return [];
      }
      const label = asString(detail.label);
      const value = asString(detail.value);
      return label ? [{ label, value: value ?? "" }] : [];
    }),
    risk: risk === "low" || risk === "high" ? risk : "medium",
    confirmLabel: asString(parsed.confirmLabel) ?? "Approve",
    rejectLabel: asString(parsed.rejectLabel) ?? "Reject",
    allowComment: parsed.allowComment === true,
  };
}

/** The user's answer to `ask_user`, as the agent expects to read it back. */
export function formatAnswer(answer: string | string[]): string {
  return JSON.stringify({ answer });
}

/** The user's decision on `request_user_approval`. */
export function formatDecision(approved: boolean, comment?: string): string {
  const trimmed = comment?.trim();
  return JSON.stringify({
    decision: approved ? "approved" : "rejected",
    ...(trimmed ? { comment: trimmed } : {}),
  });
}

/**
 * Closes out a prompt the user walked away from — they typed a new message
 * instead of answering. Every tool call needs a result before the model can take
 * another turn, so the run resumes with this rather than an orphaned call.
 */
export function formatCancellation(): string {
  return JSON.stringify({
    cancelled: true,
    reason: "The user answered in chat instead of using this prompt.",
  });
}

/** One-line summary of a resolved HITL call, for the collapsed card. */
export function describeHitlResult(result: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }
  if (!isRecord(parsed)) {
    return result;
  }
  if (parsed.cancelled === true) {
    return "Skipped — answered in chat";
  }
  if (parsed.decision === "approved" || parsed.decision === "rejected") {
    const comment = asString(parsed.comment);
    const decision = parsed.decision === "approved" ? "Approved" : "Rejected";
    return comment ? `${decision} — ${comment}` : decision;
  }
  const answer = parsed.answer;
  if (Array.isArray(answer)) {
    return answer.map((item) => String(item)).join(", ");
  }
  return answer === undefined ? result : String(answer);
}

/**
 * HITL calls in the conversation that have no `tool` result message yet. The
 * agent is blocked on each of them until the client answers.
 */
export function findPendingHitlCalls(messages: Message[]): PendingHitlCall[] {
  const answered = new Set(
    messages.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
  );

  return messages.flatMap((message) => {
    if (message.role !== "assistant") {
      return [];
    }
    return (message.toolCalls ?? []).flatMap((call) =>
      isHitlToolName(call.function.name) && !answered.has(call.id)
        ? [{ toolCallId: call.id, toolName: call.function.name }]
        : [],
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
