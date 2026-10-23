import { Diamond, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

import { useChat } from "../../hooks/useChat";
import { useSkills } from "../../hooks/useSkills";
import { HitlDock } from "../hitl/HitlDock";
import { Button } from "../ui/Button";
import { Composer } from "./Composer";
import { McpStatusBanner } from "./McpStatusBanner";
import { MessageList } from "../messages/MessageList";

/** How close to the bottom (px) still counts as "following" the stream. */
const STICK_THRESHOLD = 48;

export function Chat() {
  const {
    messages,
    status,
    error,
    pendingPrompt,
    send,
    submitA2uiAction,
    respondToToolCall,
    stop,
    reset,
  } = useChat();
  const skills = useSkills();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether to keep the latest message in view as the stream grows. Scrolling
  // up to read releases it; scrolling back down (or sending) re-engages it.
  const stickRef = useRef(true);

  const isRunning = status === "running";

  useEffect(() => {
    if (isRunning) {
      stickRef.current = true;
    }
  }, [isRunning]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, status]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (node) {
      stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_THRESHOLD;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Diamond className="size-4 fill-current text-accent" aria-hidden="true" />
        <h1 className="m-0 text-base font-semibold">AG-UI Chat</h1>
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${
            isRunning ? "text-accent" : "text-muted"
          }`}
        >
          <span
            className={`size-1.75 rounded-full ${
              isRunning ? "animate-pulse-soft bg-accent" : "bg-success"
            }`}
            aria-hidden="true"
          />
          {isRunning ? "Streaming…" : "Ready"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={reset}
          disabled={messages.length === 0 && !isRunning}
        >
          New chat
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
        <div className="mx-auto flex max-w-205 flex-col gap-4 px-5 pb-8 pt-5">
          <McpStatusBanner />
          <MessageList messages={messages} isRunning={isRunning} onA2uiAction={submitA2uiAction} />
          {error ? (
            <div className="flex items-start gap-2 rounded-xl border border-danger bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
              <TriangleAlert className="mt-0.75 size-4 shrink-0" />
              <span className="min-w-0 wrap-break-word">{error}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-205">
        {pendingPrompt ? (
          <HitlDock
            key={pendingPrompt.toolCallId}
            request={pendingPrompt.request}
            onRespond={(content) => respondToToolCall(pendingPrompt.toolCallId, content)}
          />
        ) : null}
        {/* The agent is waiting on the prompt above, so it takes the composer's
            place until answered. Hidden, not unmounted, to keep any draft. */}
        <div hidden={pendingPrompt !== undefined}>
          <Composer onSend={send} onStop={stop} isRunning={isRunning} skills={skills} />
        </div>
      </div>
    </div>
  );
}
