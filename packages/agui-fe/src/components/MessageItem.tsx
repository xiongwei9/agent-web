import type { Message } from "@ag-ui/core";

import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

interface MessageItemProps {
  message: Message;
  toolResults: Map<string, string>;
}

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
};

export function MessageItem({ message, toolResults }: MessageItemProps) {
  const role = message.role;
  const text = extractText(message);
  const toolCalls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
  const isUser = role === "user";

  return (
    <li className={`flex flex-col gap-1.5 ${isUser ? "items-end" : ""}`}>
      <div
        className={`text-xs font-semibold uppercase tracking-[0.04em] ${
          isUser ? "text-accent" : "text-muted"
        }`}
      >
        {ROLE_LABEL[role] ?? role}
      </div>
      <div
        className={
          isUser ? "max-w-full rounded-xl rounded-tr bg-user-bubble px-3.5 py-2.5" : "max-w-full"
        }
      >
        {text ? (
          role === "assistant" ? (
            <Markdown content={text} />
          ) : (
            <p className="m-0 whitespace-pre-wrap wrap-break-word">{text}</p>
          )
        ) : null}
        {toolCalls.map((call) => (
          <ToolCall
            key={call.id}
            name={call.function.name}
            args={call.function.arguments}
            result={toolResults.get(call.id)}
          />
        ))}
      </div>
    </li>
  );
}

/** Normalizes string-or-parts message content down to a display string. */
function extractText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? part.text : ""))
      .join("");
  }
  return "";
}
