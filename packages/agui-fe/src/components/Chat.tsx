import { useEffect, useRef } from "react";

import { useChat } from "../hooks/useChat";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

interface ChatProps {
  agentId: string;
}

export function Chat({ agentId }: ChatProps) {
  const { messages, status, error, send, stop, reset } = useChat({ agentId });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as the stream grows.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, status]);

  const isRunning = status === "running";

  return (
    <main className="mx-auto flex w-full min-h-0 max-w-205 flex-1 flex-col">
      <div className="flex items-center justify-between px-5 py-2.5">
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${
            isRunning ? "text-accent" : "text-muted"
          }`}
        >
          <span
            className={`size-1.75 rounded-full ${
              isRunning ? "animate-pulse-soft bg-accent" : "bg-muted"
            }`}
            aria-hidden="true"
          />
          {isRunning ? "Streaming…" : "Ready"}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-border bg-transparent px-3 py-1.25 text-[13px] text-muted enabled:hover:border-accent enabled:hover:text-ink disabled:cursor-default disabled:opacity-40"
          onClick={reset}
          disabled={messages.length === 0 && !isRunning}
        >
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-2" ref={scrollRef}>
        <MessageList messages={messages} isRunning={isRunning} />
        {error ? (
          <div className="mt-3 rounded-xl border border-danger bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            ⚠ {error}
          </div>
        ) : null}
      </div>

      <Composer onSend={send} onStop={stop} isRunning={isRunning} />
    </main>
  );
}
