import { ArrowUp } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  formatAnswer,
  formatDecision,
  formatSkip,
  type ApprovalRequest,
  type AskUserRequest,
  type HitlRequest,
} from "../../lib/hitl";
import { Button } from "../ui/Button";
import { Markdown } from "../ui/Markdown";
import { Checkbox, KeyHint } from "./ChoiceMarks";
import { HitlIcon } from "./HitlIcon";
import { RiskBadge } from "./RiskBadge";

interface HitlDockProps {
  request: HitlRequest;
  /** Resume the run with this content as the tool call's result. */
  onRespond: (content: string) => void;
}

/**
 * A Human-in-the-Loop prompt, docked in place of the composer: the run is
 * suspended on it, so answering it *is* the next turn and there's no message
 * box to talk past it with. The exchange is recorded in the transcript by
 * {@link HitlExchange} once answered (see [`lib/hitl.ts`](../../lib/hitl.ts)).
 */
export function HitlDock({ request, onRespond }: HitlDockProps) {
  const isApproval = request.kind === "approval";

  return (
    <div className="px-5 pb-5 pt-2">
      <section
        className="animate-dock-in rounded-2xl border border-accent bg-input shadow-lg"
        aria-label={isApproval ? "Approval required" : "Question from the agent"}
      >
        <header className="flex items-start gap-2 px-4 pt-3">
          <HitlIcon request={request} className="mt-1" />
          <p className="m-0 min-w-0 flex-1 font-semibold leading-snug">
            {request.kind === "approval" ? request.title : request.question}
          </p>
          {request.kind === "approval" ? (
            <RiskBadge risk={request.risk} className="mt-0.5" />
          ) : (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-xs text-muted hover:text-ink"
              onClick={() => onRespond(formatSkip())}
            >
              Skip
            </button>
          )}
        </header>

        {request.kind === "approval" ? (
          <ApprovalBody request={request} onRespond={onRespond} />
        ) : request.options.length > 0 ? (
          <ChoiceBody request={request} onRespond={onRespond} />
        ) : (
          <InputBody request={request} onRespond={onRespond} />
        )}
      </section>
    </div>
  );
}

/** Long context scrolls inside the dock rather than pushing the transcript away. */
function Details({ children }: { children: ReactNode }) {
  return (
    <div className="max-h-40 overflow-y-auto px-4 pl-9.5 pt-1 text-[13px] text-muted">
      {children}
    </div>
  );
}

/** Options in a list: a click or the option's number key answers. */
function ChoiceBody({
  request,
  onRespond,
}: {
  request: AskUserRequest;
  onRespond: (content: string) => void;
}) {
  const multiple = request.allowMultiple;
  // Multi-select collects picks (and any "Other" text) until the user sends.
  const [picked, setPicked] = useState<string[]>([]);
  const [otherOpen, setOtherOpen] = useState(false);
  const [other, setOther] = useState("");
  const otherAnswer = other.trim();

  const choose = (value: string) => {
    if (!multiple) {
      onRespond(formatAnswer(value));
      return;
    }
    setPicked((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const send = () => {
    const answers = otherAnswer ? [...picked, otherAnswer] : picked;
    if (answers.length > 0) {
      onRespond(formatAnswer(answers));
    }
  };

  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    if (multiple) {
      send();
    } else if (otherAnswer) {
      onRespond(formatAnswer(otherAnswer));
    }
  };

  // Number keys pick an option, unless the user is typing.
  const optionCount = request.options.length;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input, textarea, [contenteditable]")
      ) {
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < optionCount) {
        event.preventDefault();
        choose(request.options[index]!.value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const count = picked.length + (otherAnswer ? 1 : 0);

  return (
    <>
      {request.details ? (
        <Details>
          <Markdown content={request.details} />
        </Details>
      ) : null}
      <div
        className="flex flex-col gap-0.5 pl-7 pr-2.5 pt-2"
        role={multiple ? "group" : undefined}
        aria-label="Options"
      >
        {request.options.map((option, index) => {
          const selected = picked.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={multiple ? selected : undefined}
              // Land on the first choice so the keyboard can answer at once.
              autoFocus={index === 0}
              className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-1.75 text-left transition-colors hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none"
              onClick={() => choose(option.value)}
            >
              {multiple ? <Checkbox checked={selected} /> : <KeyHint>{index + 1}</KeyHint>}
              <span className="flex min-w-0 flex-col">
                <span className="text-[13.5px] text-ink">{option.label}</span>
                {option.description ? (
                  <span className="text-xs text-muted">{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}

        {request.allowOther ? (
          otherOpen ? (
            <form className="flex items-center gap-2.5 px-2.5 py-1" onSubmit={submitOther}>
              {multiple ? <Checkbox checked={otherAnswer.length > 0} /> : <KeyHint>…</KeyHint>}
              <input
                className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 py-1.25 font-[inherit] text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
                placeholder={request.placeholder ?? "Something else…"}
                value={other}
                onChange={(event) => setOther(event.target.value)}
                autoFocus
              />
              {multiple ? null : (
                <button
                  type="submit"
                  className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-accent-strong text-white transition-colors enabled:hover:bg-accent disabled:cursor-default disabled:bg-border disabled:text-muted"
                  disabled={!otherAnswer}
                  aria-label="Send answer"
                >
                  <ArrowUp className="size-3.5" />
                </button>
              )}
            </form>
          ) : (
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-1.75 text-left text-[13.5px] text-muted transition-colors hover:bg-elevated hover:text-ink focus-visible:bg-elevated focus-visible:outline-none"
              onClick={() => setOtherOpen(true)}
            >
              {multiple ? <Checkbox checked={false} /> : <KeyHint>…</KeyHint>}
              Other…
            </button>
          )
        ) : null}
      </div>

      <footer className="flex items-center gap-3 pb-3 pl-9.5 pr-4 pt-2 text-xs text-muted">
        <span className="flex-1">
          {multiple
            ? "Select all that apply"
            : `Press 1${optionCount > 1 ? `–${optionCount}` : ""} or click to answer`}
        </span>
        {multiple ? (
          <Button size="sm" onClick={send} disabled={count === 0}>
            Send{count > 0 ? ` (${count})` : ""}
          </Button>
        ) : null}
      </footer>
    </>
  );
}

/** No options: a free-text answer, typed like a message. */
function InputBody({
  request,
  onRespond,
}: {
  request: AskUserRequest;
  onRespond: (content: string) => void;
}) {
  const [text, setText] = useState("");
  const answer = text.trim();

  const submit = () => {
    if (answer) {
      onRespond(formatAnswer(answer));
    }
  };

  return (
    <>
      {request.details ? (
        <Details>
          <Markdown content={request.details} />
        </Details>
      ) : null}
      <form
        className="px-4 pb-3 pl-9.5 pt-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="rounded-xl border border-border bg-canvas transition-colors focus-within:border-accent">
          <textarea
            className="block max-h-40 min-h-16 w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 font-[inherit] text-[13.5px] leading-normal text-ink field-sizing-content placeholder:text-muted focus:outline-none"
            placeholder={request.placeholder ?? "Type your answer…"}
            value={text}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            autoFocus
          />
          <div className="flex items-center gap-3 pb-1.5 pl-3 pr-1.5">
            <span className="flex-1 text-xs text-muted">
              Enter to send · Shift+Enter for newline
            </span>
            <button
              type="submit"
              className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-accent-strong text-white transition-colors enabled:hover:bg-accent disabled:cursor-default disabled:bg-border disabled:text-muted"
              disabled={!answer}
              aria-label="Send answer"
            >
              <ArrowUp className="size-3.5" />
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

function ApprovalBody({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (content: string) => void;
}) {
  const [comment, setComment] = useState("");

  return (
    <>
      <Details>
        <Markdown content={request.summary} />
        {request.details.length > 0 ? (
          <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {request.details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt>{detail.label}</dt>
                <dd className="m-0 wrap-break-word text-ink">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Details>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-9.5 pt-2.5">
        {request.allowComment ? (
          <input
            className="min-w-40 flex-1 rounded-lg border border-border bg-canvas px-3 py-1.25 font-[inherit] text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            placeholder="Add a note (optional)"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button
            variant="danger"
            size="sm"
            onClick={() => onRespond(formatDecision(false, comment))}
          >
            {request.rejectLabel}
          </Button>
          <Button
            size="sm"
            onClick={() => onRespond(formatDecision(true, comment))}
            autoFocus={!request.allowComment}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}
