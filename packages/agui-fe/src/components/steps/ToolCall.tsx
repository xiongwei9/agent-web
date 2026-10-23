import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { StepStatus } from "./StepStatus";

interface ToolCallProps {
  name: string;
  /** Raw JSON-ish argument string, streamed incrementally by the server. */
  args: string;
  /** Tool result content, present once the tool has run. */
  result?: string;
  isRunning: boolean;
}

/**
 * One step in a {@link StepGroup}: a single line naming the tool, which opens
 * to the call's arguments and result.
 */
export function ToolCall({ name, args, result, isRunning }: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const code = codeArgument(args);

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex max-w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[13px] text-muted transition-colors hover:text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <StepStatus done={result !== undefined} isRunning={isRunning} />
        <span className="min-w-0 truncate font-mono">{name}</span>
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2.5 rounded-[10px] border border-border bg-tool p-3">
          {code === undefined ? (
            <Section label="Arguments">{formatJson(args)}</Section>
          ) : (
            <Section label="Code" preformatted>
              <code>{code}</code>
            </Section>
          )}
          {result !== undefined ? <Section label="Result">{formatJson(result)}</Section> : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  preformatted = false,
  children,
}: {
  label: string;
  /** Keep the text's own line breaks and scroll sideways rather than wrap. */
  preformatted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.04em] text-muted">{label}</span>
      <pre
        className={`m-0 max-h-80 overflow-auto rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-normal ${
          preformatted ? "whitespace-pre" : "whitespace-pre-wrap wrap-break-word"
        }`}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * The source when a tool's only argument is a `code` string (the agent's
 * `execute_code` tool in code mode), so it reads as code rather than one JSON
 * string full of `\n`. Undefined otherwise, including while the arguments are
 * still streaming in.
 */
function codeArgument(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.keys(parsed).length === 1 &&
      "code" in parsed &&
      typeof parsed.code === "string"
    ) {
      return parsed.code.trim();
    }
  } catch {
    // Incomplete JSON while streaming.
  }
  return undefined;
}

/** Pretty-prints a JSON string, falling back to the raw text if incomplete. */
function formatJson(value: string): string {
  if (!value) {
    return "—";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
