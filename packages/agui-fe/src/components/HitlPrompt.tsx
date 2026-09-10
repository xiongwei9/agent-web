import { useState, type FormEvent } from "react";

import {
  describeHitlResult,
  formatAnswer,
  formatDecision,
  type ApprovalRequest,
  type AskUserRequest,
  type HitlRequest,
} from "../lib/hitl";
import { Markdown } from "./Markdown";

interface HitlPromptProps {
  request: HitlRequest;
  /** The `tool` result content once the user has responded. */
  result?: string;
  /** A run is in flight, so responding is temporarily unavailable. */
  busy: boolean;
  /** Resume the run with this content as the tool call's result. */
  onRespond: (content: string) => void;
}

/**
 * Renders a Human-in-the-Loop request — a question or an approval gate — and
 * hands the user's response back to the caller, which resumes the suspended run
 * with it as the tool call's result (see [`lib/hitl.ts`](../lib/hitl.ts)).
 *
 * Once answered the card collapses to the decision, so the transcript still
 * reads as a conversation rather than a pile of spent forms.
 */
export function HitlPrompt({ request, result, busy, onRespond }: HitlPromptProps) {
  const answered = result !== undefined;
  const isApproval = request.kind === "approval";

  return (
    <div
      className={`mt-2.5 overflow-hidden rounded-[10px] border bg-elevated ${
        answered ? "border-border" : "border-accent"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] uppercase tracking-[0.04em] text-muted">
        <span aria-hidden="true">{isApproval ? "⚑" : "✎"}</span>
        <span className="flex-1">{isApproval ? "Approval required" : "Needs your input"}</span>
        {isApproval && !answered ? <RiskBadge risk={request.risk} /> : null}
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-3">
        {request.kind === "approval" ? (
          <ApprovalBody request={request} />
        ) : (
          <AskBody request={request} />
        )}

        {answered ? (
          <p className="m-0 flex items-start gap-1.5 text-[13px] text-muted">
            <span className="text-success" aria-hidden="true">
              ✓
            </span>
            <span className="wrap-break-word">{describeHitlResult(result)}</span>
          </p>
        ) : request.kind === "approval" ? (
          <ApprovalControls request={request} busy={busy} onRespond={onRespond} />
        ) : (
          <AskControls request={request} busy={busy} onRespond={onRespond} />
        )}
      </div>
    </div>
  );
}

function ApprovalBody({ request }: { request: ApprovalRequest }) {
  return (
    <>
      <p className="m-0 font-semibold">{request.title}</p>
      <Markdown content={request.summary} />
      {request.details.length > 0 ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {request.details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted">{detail.label}</dt>
              <dd className="m-0 wrap-break-word">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

function AskBody({ request }: { request: AskUserRequest }) {
  return (
    <>
      <p className="m-0 font-semibold">{request.question}</p>
      {request.details ? <Markdown content={request.details} /> : null}
    </>
  );
}

function ApprovalControls({
  request,
  busy,
  onRespond,
}: {
  request: ApprovalRequest;
  busy: boolean;
  onRespond: (content: string) => void;
}) {
  const [comment, setComment] = useState("");

  return (
    <div className="flex flex-col gap-2.5">
      {request.allowComment ? (
        <textarea
          className="resize-none rounded-lg border border-border bg-input px-3 py-2 font-[inherit] text-[13px] leading-normal text-ink field-sizing-content focus:border-accent focus:outline-none"
          placeholder="Add a note (optional)"
          rows={1}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={busy}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-accent-strong px-4 py-2 text-[13px] font-semibold text-white enabled:hover:bg-accent disabled:cursor-default disabled:opacity-50"
          onClick={() => onRespond(formatDecision(true, comment))}
          disabled={busy}
        >
          {request.confirmLabel}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-danger bg-transparent px-4 py-2 text-[13px] font-semibold text-danger enabled:hover:bg-danger/10 disabled:cursor-default disabled:opacity-50"
          onClick={() => onRespond(formatDecision(false, comment))}
          disabled={busy}
        >
          {request.rejectLabel}
        </button>
      </div>
    </div>
  );
}

function AskControls({
  request,
  busy,
  onRespond,
}: {
  request: AskUserRequest;
  busy: boolean;
  onRespond: (content: string) => void;
}) {
  // Multi-select collects picks until the user submits; single-select answers on
  // the click itself, so the option *is* the button.
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");

  const toggle = (value: string) => {
    setPicked((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const answer = text.trim();
    if (answer && !busy) {
      onRespond(formatAnswer(answer));
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {request.options.length > 0 ? (
        <div className="flex flex-wrap gap-2" role={request.allowMultiple ? "group" : undefined}>
          {request.options.map((option) => {
            const selected = picked.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                title={option.description}
                aria-pressed={request.allowMultiple ? selected : undefined}
                className={`cursor-pointer rounded-lg border px-3 py-1.75 text-[13px] disabled:cursor-default disabled:opacity-50 ${
                  selected
                    ? "border-accent bg-user-bubble text-ink"
                    : "border-border bg-canvas text-ink enabled:hover:border-accent"
                }`}
                onClick={() =>
                  request.allowMultiple
                    ? toggle(option.value)
                    : onRespond(formatAnswer(option.value))
                }
                disabled={busy}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {request.allowMultiple ? (
        <div>
          <button
            type="button"
            className="cursor-pointer rounded-lg border-0 bg-accent-strong px-4 py-2 text-[13px] font-semibold text-white enabled:hover:bg-accent disabled:cursor-default disabled:opacity-50"
            onClick={() => onRespond(formatAnswer(picked))}
            disabled={busy || picked.length === 0}
          >
            Send {picked.length > 0 ? `(${picked.length})` : ""}
          </button>
        </div>
      ) : null}

      {request.allowOther ? (
        <form className="flex items-end gap-2" onSubmit={submitText}>
          <input
            className="min-w-0 flex-1 rounded-lg border border-border bg-input px-3 py-2 font-[inherit] text-[13px] text-ink focus:border-accent focus:outline-none"
            placeholder={
              request.placeholder ??
              (request.options.length > 0 ? "Something else…" : "Your answer…")
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
          <button
            type="submit"
            className="cursor-pointer whitespace-nowrap rounded-lg border-0 bg-accent-strong px-4 py-2 text-[13px] font-semibold text-white enabled:hover:bg-accent disabled:cursor-default disabled:opacity-50"
            disabled={busy || !text.trim()}
          >
            Send
          </button>
        </form>
      ) : null}
    </div>
  );
}

const RISK_STYLES: Record<ApprovalRequest["risk"], string> = {
  low: "border-border text-muted",
  medium: "border-accent text-accent",
  high: "border-danger text-danger",
};

function RiskBadge({ risk }: { risk: ApprovalRequest["risk"] }) {
  return (
    <span className={`rounded border px-1.5 py-0.25 text-[10px] ${RISK_STYLES[risk]}`}>
      {risk} risk
    </span>
  );
}
