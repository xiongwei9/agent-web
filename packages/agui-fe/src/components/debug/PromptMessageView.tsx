import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { prettyJson, type PromptMessage, type PromptPart } from "../../lib/debug";

const ROLE_STYLES: Record<PromptMessage["role"], string> = {
  system: "border-l-muted",
  user: "border-l-accent",
  assistant: "border-l-success",
  tool: "border-l-[#d97706]",
};

interface PromptMessageViewProps {
  message: PromptMessage;
  /** Shown instead of the role, e.g. "response". */
  label?: string;
  defaultOpen?: boolean;
}

/**
 * One model message as sent: its role, then each content part verbatim —
 * text, tool calls with their input, tool results with their output.
 */
export function PromptMessageView({ message, label, defaultOpen = true }: PromptMessageViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const parts: PromptPart[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  return (
    <div
      className={`rounded-lg border border-l-[3px] border-border bg-canvas ${ROLE_STYLES[message.role]}`}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-xs text-muted hover:text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-semibold uppercase tracking-[0.04em] text-ink">
          {label ?? message.role}
        </span>
        <span className="min-w-0 truncate">{summarize(parts)}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-2.5">
          {parts.map((part, index) => (
            <PartView key={index} part={part} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PartView({ part }: { part: PromptPart }) {
  switch (part.type) {
    case "text":
      return <Pre>{part.text || "(empty)"}</Pre>;
    case "tool-call":
      return (
        <div className="flex flex-col gap-1">
          <PartLabel>
            tool call <span className="text-ink">{part.toolName}</span> · {part.toolCallId}
          </PartLabel>
          <Pre>{prettyJson(part.input)}</Pre>
        </div>
      );
    case "tool-result":
      return (
        <div className="flex flex-col gap-1">
          <PartLabel>
            tool result <span className="text-ink">{part.toolName}</span> · {part.toolCallId}
          </PartLabel>
          <Pre>{prettyJson(part.output.value)}</Pre>
        </div>
      );
    default:
      return <Pre>{prettyJson(part)}</Pre>;
  }
}

function PartLabel({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-muted">{children}</span>;
}

export function Pre({
  capped = true,
  children,
}: {
  /** Scroll within a fixed height; off for a whole document that scrolls with the panel. */
  capped?: boolean;
  children: ReactNode;
}) {
  return (
    <pre
      className={`m-0 overflow-auto rounded-md bg-tool px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap wrap-break-word ${
        capped ? "max-h-96" : ""
      }`}
    >
      {children}
    </pre>
  );
}

/** A one-line gist for the collapsed header. */
function summarize(parts: PromptPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return `${part.text.length.toLocaleString()} chars`;
        case "tool-call":
          return `→ ${part.toolName}`;
        case "tool-result":
          return `← ${part.toolName}`;
        default:
          return "?";
      }
    })
    .join(" · ");
}
