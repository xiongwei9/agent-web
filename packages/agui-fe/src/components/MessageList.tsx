import type { Message } from "@ag-ui/core";
import { useMemo } from "react";

import type { A2uiActionPayload } from "./A2uiSurface";
import { MessageItem } from "./MessageItem";

interface MessageListProps {
  messages: Message[];
  isRunning: boolean;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (toolCallId: string, payload: A2uiActionPayload) => void;
}

export function MessageList({ messages, isRunning, onA2uiAction }: MessageListProps) {
  // Tool results arrive as standalone `tool` messages keyed by toolCallId. We
  // attach them to the originating tool call instead of rendering them on their
  // own, so map them up front.
  const toolResults = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "tool" && message.toolCallId) {
        map.set(message.toolCallId, message.content ?? "");
      }
    }
    return map;
  }, [messages]);

  const visible = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );

  if (visible.length === 0) {
    return (
      <div className="px-4 py-16 text-center text-muted">
        <p className="m-0 mb-1.5 text-base text-ink">Start the conversation</p>
        <p className="m-0 text-sm">Ask the agent anything to see the AG-UI stream render live.</p>
      </div>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-5 p-0">
      {visible.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          toolResults={toolResults}
          onA2uiAction={onA2uiAction}
        />
      ))}
      {isRunning ? (
        <li className="flex gap-1.25 px-0.5 py-1.5" aria-live="polite">
          <span className="size-1.75 animate-blink rounded-full bg-muted" />
          <span className="size-1.75 animate-blink rounded-full bg-muted [animation-delay:0.2s]" />
          <span className="size-1.75 animate-blink rounded-full bg-muted [animation-delay:0.4s]" />
        </li>
      ) : null}
    </ul>
  );
}
