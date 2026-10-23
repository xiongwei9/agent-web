import type { Message } from "@ag-ui/core";
import { Diamond } from "lucide-react";
import { useMemo } from "react";

import type { A2uiActionPayload } from "../../lib/a2ui";
import {
  isHitlToolName,
  parseHitlRequest,
  parseHitlResult,
  type HitlRequest,
  type HitlResult,
} from "../../lib/hitl";
import { HitlExchange } from "../hitl/HitlExchange";
import { hasRenderableContent, MessageItem } from "./MessageItem";

interface MessageListProps {
  messages: Message[];
  isRunning: boolean;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (payload: A2uiActionPayload) => void;
}

/** One entry in the transcript. */
type Entry =
  /** A user message, or one agent reply spanning several messages. */
  | { kind: "turn"; messages: Message[] }
  /** An answered Human-in-the-Loop prompt: the question with the user's answer. */
  | { kind: "hitl"; id: string; request: HitlRequest; result: HitlResult };

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

  // One reply from the agent spans several AG-UI messages — one per text block
  // or tool-call batch, across loop iterations. Group consecutive assistant
  // messages so each reply renders as one block. An answered HITL prompt is
  // the user's turn, so its result goes in as an entry of its own, between the
  // reply that asked and the one that carries on.
  const entries = useMemo(() => {
    const result: Entry[] = [];
    const hitlCalls = new Map<string, HitlRequest>();
    for (const message of messages) {
      if (message.role === "tool") {
        const request = hitlCalls.get(message.toolCallId);
        // Unparseable results are the server bouncing a malformed call back to
        // the model, which retries on its own: nothing for the user to see.
        const outcome = request ? parseHitlResult(message.content ?? "") : undefined;
        if (request && outcome) {
          result.push({ kind: "hitl", id: message.id, request, result: outcome });
        }
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) {
          const request = isHitlToolName(call.function.name)
            ? parseHitlRequest(call.function.name, call.function.arguments)
            : undefined;
          if (request) {
            hitlCalls.set(call.id, request);
          }
        }
      }
      if (!hasRenderableContent(message)) {
        continue;
      }
      const last = result.at(-1);
      if (
        last?.kind === "turn" &&
        message.role === "assistant" &&
        last.messages[0]!.role === "assistant"
      ) {
        last.messages.push(message);
      } else {
        result.push({ kind: "turn", messages: [message] });
      }
    }
    return result;
  }, [messages]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
        <Diamond className="size-6 fill-current text-accent" aria-hidden="true" />
        <p className="m-0 text-base font-medium text-ink">Start the conversation</p>
        <p className="m-0 text-sm text-muted">
          Ask the agent anything to see the AG-UI stream render live.
        </p>
      </div>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-6 p-0">
      {entries.map((entry) =>
        entry.kind === "hitl" ? (
          <li key={entry.id} className="flex flex-col">
            <HitlExchange request={entry.request} result={entry.result} />
          </li>
        ) : (
          // The side tells the roles apart: user turns are right-aligned bubbles.
          <li
            key={entry.messages[0]!.id}
            className={`flex flex-col gap-1.5 ${entry.messages[0]!.role === "user" ? "items-end" : ""}`}
          >
            <MessageItem
              messages={entry.messages}
              toolResults={toolResults}
              isRunning={isRunning}
              onA2uiAction={onA2uiAction}
            />
          </li>
        ),
      )}
      {isRunning ? (
        <li className="flex gap-1.25 py-1" aria-live="polite" aria-label="Agent is responding">
          <span className="size-1.75 animate-blink rounded-full bg-muted" />
          <span className="size-1.75 animate-blink rounded-full bg-muted [animation-delay:0.2s]" />
          <span className="size-1.75 animate-blink rounded-full bg-muted [animation-delay:0.4s]" />
        </li>
      ) : null}
    </ul>
  );
}
