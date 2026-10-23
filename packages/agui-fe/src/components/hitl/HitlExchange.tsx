import { ChevronRight, ShieldCheck, ShieldX, SkipForward } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ApprovalRequest, AskUserRequest, HitlRequest, HitlResult } from "../../lib/hitl";
import { Markdown } from "../ui/Markdown";
import { Checkbox, KeyHint } from "./ChoiceMarks";
import { HitlIcon } from "./HitlIcon";
import { RiskBadge } from "./RiskBadge";

interface HitlExchangeProps {
  request: HitlRequest;
  result: HitlResult;
}

/**
 * An answered Human-in-the-Loop prompt, as its own entry in the transcript's
 * agent column: the agent's question (or the action it asked to approve) with
 * the user's answer under it. The question opens to the context the user saw
 * when answering — the details, the options offered, what an approval covered.
 * The prompt itself was answered in the {@link HitlDock}.
 */
export function HitlExchange({ request, result }: HitlExchangeProps) {
  const [open, setOpen] = useState(false);
  const isApproval = request.kind === "approval";
  // A free-text question with no details has nothing more to show.
  const expandable = isApproval || Boolean(request.details) || request.options.length > 0;

  const heading = (
    <>
      <HitlIcon request={request} className="mt-0.75" />
      <span className="min-w-0 flex-1 wrap-break-word font-medium text-ink">
        {isApproval ? request.title : request.question}
      </span>
      {isApproval ? <RiskBadge risk={request.risk} className="mt-0.5" /> : null}
      {expandable ? (
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""} mt-0.75 text-muted`}
        />
      ) : null}
    </>
  );

  return (
    <div className="w-full max-w-xl self-start rounded-xl border border-border bg-canvas text-[13px] leading-snug">
      {expandable ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-start gap-2.5 rounded-t-xl border-0 bg-transparent px-3.5 pb-1.5 pt-2.75 text-left transition-colors hover:bg-elevated"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-start gap-2.5 px-3.5 pb-1.5 pt-2.75">{heading}</div>
      )}

      {open ? (
        <div className="flex flex-col gap-2 pb-1 pl-9.5 pr-3.5 pt-1 text-muted">
          {request.kind === "approval" ? (
            <ApprovalContext request={request} />
          ) : (
            <AskContext request={request} result={result} />
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 pb-3 pl-9.5 pr-3.5 pt-1">
        <Answer request={request} result={result} />
      </div>
    </div>
  );
}

function AskContext({ request, result }: { request: AskUserRequest; result: HitlResult }) {
  const picked = result.kind === "answer" ? result.values : [];
  return (
    <>
      {request.details ? <Markdown content={request.details} /> : null}
      {request.options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[11px] uppercase tracking-[0.04em]">Options</span>
          {request.options.map((option) => (
            <span
              key={option.value}
              title={option.description}
              className={picked.includes(option.value) ? "font-medium text-ink" : ""}
            >
              {option.label}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ApprovalContext({ request }: { request: ApprovalRequest }) {
  return (
    <>
      <Markdown content={request.summary} />
      {request.details.length > 0 ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {request.details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt>{detail.label}</dt>
              <dd className="m-0 wrap-break-word text-ink">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

/** The answer, drawn the way it was given in the {@link HitlDock}. */
function Answer({ request, result }: HitlExchangeProps) {
  if (result.kind === "cancelled") {
    return (
      <p className="m-0 flex items-center gap-1.5 text-muted">
        <SkipForward className="size-3.5 shrink-0" />
        Skipped
      </p>
    );
  }

  if (result.kind === "decision") {
    const Icon = result.approved ? ShieldCheck : ShieldX;
    return (
      <>
        <p
          className={`m-0 flex items-center gap-1.5 font-medium ${
            result.approved ? "text-success" : "text-danger"
          }`}
        >
          <Icon className="size-4 shrink-0" />
          {result.approved ? "Approved" : "Rejected"}
        </p>
        {result.comment ? <Quote>{result.comment}</Quote> : null}
      </>
    );
  }

  // A free-text question: the user's own words.
  if (request.kind !== "ask" || request.options.length === 0) {
    return <Quote>{result.values.join("\n")}</Quote>;
  }

  // A choice: the picked options as they appeared in the prompt.
  return result.values.map((value) => {
    const index = request.options.findIndex((option) => option.value === value);
    const option = request.options[index];
    return (
      <div key={value} className="flex items-start gap-2.5">
        {request.allowMultiple ? (
          <Checkbox checked />
        ) : (
          <KeyHint active>{option ? index + 1 : "…"}</KeyHint>
        )}
        <div className="flex min-w-0 flex-col">
          {option ? (
            <>
              <span className="font-medium text-ink">{option.label}</span>
              {option.description ? (
                <span className="text-xs text-muted">{option.description}</span>
              ) : null}
            </>
          ) : (
            // Typed into "Other…".
            <span className="whitespace-pre-wrap wrap-break-word text-ink">
              <span className="mr-1.5 text-xs text-muted">Other</span>
              {value}
            </span>
          )}
        </div>
      </div>
    );
  });
}

/** Text the user typed, set off like a quotation. */
function Quote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 whitespace-pre-wrap wrap-break-word border-l-2 border-accent/50 pl-2.5 text-ink">
      {children}
    </p>
  );
}
