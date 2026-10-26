import type { Message } from "@ag-ui/core";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { prettyJson, type ModelCall } from "../../lib/debug";
import { CopyButton } from "./CopyButton";
import { ModelCallView, ToggleChip } from "./ModelCallView";
import { Pre } from "./PromptMessageView";

interface DebugPanelProps {
  modelCalls: ModelCall[];
  /** The conversation as the client holds it — what each run sends the server. */
  messages: Message[];
  isRunning: boolean;
  onClose: () => void;
}

type Tab = "calls" | "messages";

/**
 * The raw conversation, for debugging: every model call of the thread exactly
 * as the server made it (system prompt, messages, tool calls and results,
 * tool declarations, the response), and the client's AG-UI messages.
 */
export function DebugPanel({ modelCalls, messages, isRunning, onClose }: DebugPanelProps) {
  const [tab, setTab] = useState<Tab>("calls");
  // Undefined follows the latest call as new ones stream in.
  const [selectedKey, setSelectedKey] = useState<string>();

  const runNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    for (const call of modelCalls) {
      if (!numbers.has(call.runId)) {
        numbers.set(call.runId, numbers.size + 1);
      }
    }
    return numbers;
  }, [modelCalls]);

  const latest = modelCalls.at(-1);
  const selected = modelCalls.find((call) => call.key === selectedKey) ?? latest;
  const messagesJson = prettyJson(messages);

  return (
    <aside className="fixed inset-0 z-20 flex flex-col bg-elevated md:static md:z-auto md:w-[min(600px,45vw)] md:shrink-0 md:border-l md:border-border">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="m-0 text-sm font-semibold">Debug</h2>
        <span className="ml-2 flex items-center gap-1">
          <ToggleChip active={tab === "calls"} onClick={() => setTab("calls")}>
            Model calls ({modelCalls.length})
          </ToggleChip>
          <ToggleChip active={tab === "messages"} onClick={() => setTab("messages")}>
            AG-UI messages ({messages.length})
          </ToggleChip>
        </span>
        <button
          type="button"
          className="ml-auto inline-flex cursor-pointer rounded-md border-0 bg-transparent p-1 text-muted hover:text-ink"
          onClick={onClose}
          aria-label="Close debug panel"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "messages" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center text-xs text-muted">
              <span>Sent as RunAgentInput.messages on every run</span>
              <span className="ml-auto">
                <CopyButton text={messagesJson} label="Copy messages as JSON" />
              </span>
            </div>
            <Pre capped={false}>{messagesJson}</Pre>
          </div>
        ) : selected ? (
          <div className="flex flex-col gap-3">
            <select
              className="w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-[13px]"
              value={selected.key}
              onChange={(event) =>
                setSelectedKey(event.target.value === latest?.key ? undefined : event.target.value)
              }
              aria-label="Model call"
            >
              {modelCalls.map((call) => (
                <option key={call.key} value={call.key}>
                  Run {runNumbers.get(call.runId)} · call {call.iteration + 1}
                  {call.key === latest?.key ? " (latest)" : ""}
                  {call.response ? "" : " · no response"}
                </option>
              ))}
            </select>
            <ModelCallView
              key={selected.key}
              call={selected}
              isRunning={isRunning && selected.key === latest?.key}
            />
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">
            {messages.length === 0
              ? "Send a message to see the model calls it makes."
              : "No model calls captured. Start agui-server with AGENT_DEBUG_EVENTS=on to stream them here."}
          </p>
        )}
      </div>
    </aside>
  );
}
