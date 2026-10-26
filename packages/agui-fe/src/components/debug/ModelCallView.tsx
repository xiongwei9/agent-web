import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  finishReasonLabel,
  prettyJson,
  tokenUsage,
  type ModelCall,
  type ModelToolDef,
} from "../../lib/debug";
import { CopyButton } from "./CopyButton";
import { Pre, PromptMessageView } from "./PromptMessageView";

interface ModelCallViewProps {
  call: ModelCall;
  /** Whether the run is still streaming, so a call without a response may yet get one. */
  isRunning: boolean;
}

/**
 * One model call: what the server sent (system prompt, messages, tool
 * declarations, settings) and what the model answered, either laid out by
 * message or as the raw JSON.
 */
export function ModelCallView({ call, isRunning }: ModelCallViewProps) {
  const [raw, setRaw] = useState(false);
  const { request, response } = call;
  const usage = tokenUsage(response?.usage);
  const finishReason = finishReasonLabel(response?.finishReason);
  const durationMs =
    call.requestedAt !== undefined && call.respondedAt !== undefined
      ? call.respondedAt - call.requestedAt
      : undefined;
  const rawJson = prettyJson({ request, response });

  const meta = [
    `${request.prompt.length} messages`,
    `${request.tools?.length ?? 0} tools`,
    request.toolChoice ? `toolChoice ${prettyJson(request.toolChoice).replace(/\s+/g, " ")}` : null,
    finishReason ? `finish ${finishReason}` : null,
    usage.input !== undefined ? `in ${usage.input.toLocaleString()} tok` : null,
    usage.output !== undefined ? `out ${usage.output.toLocaleString()} tok` : null,
    durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {meta.map((item) => (
          <span key={item}>{item}</span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <ToggleChip active={!raw} onClick={() => setRaw(false)}>
            Formatted
          </ToggleChip>
          <ToggleChip active={raw} onClick={() => setRaw(true)}>
            JSON
          </ToggleChip>
          <CopyButton text={rawJson} label="Copy call as JSON" />
        </span>
      </div>

      {raw ? (
        <Pre capped={false}>{rawJson}</Pre>
      ) : (
        <>
          <Section title="Request">
            {request.prompt.map((message, index) => (
              <PromptMessageView
                key={index}
                message={message}
                // The system prompt is long and the same on every call.
                defaultOpen={message.role !== "system"}
              />
            ))}
          </Section>

          <Section title="Response">
            {response ? (
              <PromptMessageView
                message={{ role: "assistant", content: response.content }}
                label="assistant (response)"
              />
            ) : (
              <p className="m-0 text-xs text-muted">
                {isRunning
                  ? "Waiting for the model…"
                  : "No response (the call failed or was stopped)."}
              </p>
            )}
          </Section>

          {request.tools && request.tools.length > 0 ? (
            <Section title={`Tools (${request.tools.length})`}>
              {request.tools.map((tool) => (
                <ToolDefView key={tool.name} tool={tool} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ToolDefView({ tool }: { tool: ModelToolDef }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-canvas">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-xs text-muted hover:text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-mono text-ink">{tool.name}</span>
        <span className="min-w-0 truncate">{tool.description}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-2.5">
          {tool.description ? <Pre>{tool.description}</Pre> : null}
          <Pre>{prettyJson(tool.inputSchema)}</Pre>
        </div>
      ) : null}
    </div>
  );
}

export function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`cursor-pointer rounded-md border px-2 py-0.5 text-xs transition-colors ${
        active
          ? "border-accent bg-user-bubble text-accent-strong"
          : "border-border bg-canvas text-muted hover:text-ink"
      }`}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
