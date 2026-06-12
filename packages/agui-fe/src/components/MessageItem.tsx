import { A2uiMessageListWrapperSchema, type A2uiMessage } from "@a2ui/web_core/v0_9";
import type { Message } from "@ag-ui/core";

import type { A2uiActionPayload } from "../lib/a2ui";
import { A2uiSurface } from "./A2uiSurface";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

/** Tool the agent calls to render an A2UI surface; rendered specially below. */
const A2UI_RENDER_TOOL_NAME = "render_a2ui";

interface MessageItemProps {
  message: Message;
  toolResults: Map<string, string>;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (payload: A2uiActionPayload) => void;
}

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
};

export function MessageItem({ message, toolResults, onA2uiAction }: MessageItemProps) {
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
        {toolCalls.map((call) => {
          const surfaceMessages =
            call.function.name === A2UI_RENDER_TOOL_NAME
              ? parseA2uiMessages(call.function.arguments)
              : undefined;
          if (surfaceMessages) {
            return <A2uiSurface key={call.id} messages={surfaceMessages} onAction={onA2uiAction} />;
          }
          return (
            <ToolCall
              key={call.id}
              name={call.function.name}
              args={call.function.arguments}
              result={toolResults.get(call.id)}
            />
          );
        })}
      </div>
    </li>
  );
}

/**
 * Parses the `render_a2ui` tool arguments into the A2UI message list. Returns
 * undefined while the arguments are still streaming / incomplete (invalid JSON
 * or no `messages` array yet), so we keep showing the generic tool view until
 * the full surface has arrived.
 */
function parseA2uiMessages(args: string): A2uiMessage[] | undefined {
  if (!args) {
    return undefined;
  }
  try {
    const result = A2uiMessageListWrapperSchema.safeParse(JSON.parse(args));
    return result.success && result.data.messages.length > 0 ? result.data.messages : undefined;
  } catch {
    return undefined;
  }
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
