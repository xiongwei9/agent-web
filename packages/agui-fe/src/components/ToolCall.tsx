import { useState } from "react";

interface ToolCallProps {
  name: string;
  /** Raw JSON-ish argument string, streamed incrementally by the server. */
  args: string;
  /** Tool result content, present once the tool has run. */
  result?: string;
}

export function ToolCall({ name, args, result }: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const hasResult = result !== undefined;

  return (
    <div className="mt-2.5 overflow-hidden rounded-[10px] border border-border bg-tool">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2 text-left text-[13px] text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={hasResult ? "text-success" : "text-muted"} aria-hidden="true">
          {hasResult ? "✓" : "⟳"}
        </span>
        <span className="flex-1 font-mono font-semibold">{name}</span>
        <span className="text-[11px] text-muted" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 px-3 pb-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.04em] text-muted">Arguments</span>
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12.5px]">
              {formatJson(args)}
            </pre>
          </div>
          {hasResult ? (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.04em] text-muted">Result</span>
              <pre className="m-0 overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12.5px]">
                {formatJson(result)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
