import type { Message } from "@ag-ui/core";
import { useMemo } from "react";

import type { A2uiActionPayload } from "../lib/a2ui";
import { hasRenderableContent, MessageItem } from "./MessageItem";

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
};

interface MessageListProps {
  messages: Message[];
  isRunning: boolean;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (payload: A2uiActionPayload) => void;
  /** Answer a suspended Human-in-the-Loop tool call to resume the run. */
  onHitlRespond: (toolCallId: string, content: string) => void;
}

export function MessageList({
  messages,
  isRunning,
  onA2uiAction,
  onHitlRespond,
}: MessageListProps) {
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

  // One reply from the agent spans several AG-UI messages — one per text block
  // or tool-call batch, across loop iterations and HITL resumes. Group
  // consecutive same-role messages so each reply gets a single label.
  const groups = useMemo(() => {
    const result: Message[][] = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      if (!hasRenderableContent(message)) {
        continue;
      }
      const last = result.at(-1);
      if (last && last[0]!.role === message.role && message.role === "assistant") {
        last.push(message);
      } else {
        result.push([message]);
      }
    }
    return result;
  }, [messages]);

  if (groups.length === 0) {
    return (
      <div className="px-4 py-16 text-center text-muted">
        <p className="m-0 mb-1.5 text-base text-ink">Start the conversation</p>
        <p className="m-0 text-sm">Ask the agent anything to see the AG-UI stream render live.</p>
      </div>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-5 p-0">
      {groups.map((group) => {
        const role = group[0]!.role;
        const isUser = role === "user";
        return (
          <li key={group[0]!.id} className={`flex flex-col gap-1.5 ${isUser ? "items-end" : ""}`}>
            <div
              className={`text-xs font-semibold uppercase tracking-[0.04em] ${
                isUser ? "text-accent" : "text-muted"
              }`}
            >
              {ROLE_LABEL[role] ?? role}
            </div>
            {group.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                toolResults={toolResults}
                isRunning={isRunning}
                onA2uiAction={onA2uiAction}
                onHitlRespond={onHitlRespond}
              />
            ))}
          </li>
        );
      })}
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
