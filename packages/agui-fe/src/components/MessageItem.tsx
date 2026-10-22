import { A2uiMessageListWrapperSchema, type A2uiMessage } from "@a2ui/web_core/v0_9";
import type { Message } from "@ag-ui/core";

import type { A2uiActionPayload } from "../lib/a2ui";
import { parseHitlRequest } from "../lib/hitl";
import { A2uiSurface } from "./A2uiSurface";
import { HitlPrompt } from "./HitlPrompt";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

/** Tool the agent calls to render an A2UI surface; rendered specially below. */
const A2UI_RENDER_TOOL_NAME = "render_a2ui";

interface MessageItemProps {
  message: Message;
  toolResults: Map<string, string>;
  /** A run is in flight, so the interactive cards can't be answered right now. */
  isRunning: boolean;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (payload: A2uiActionPayload) => void;
  /** Answer a suspended Human-in-the-Loop tool call to resume the run. */
  onHitlRespond: (toolCallId: string, content: string) => void;
}

/**
 * Renders one message's content: its text plus any tool calls. The role label
 * is rendered by {@link MessageList}, once per run of same-role messages.
 */
export function MessageItem({
  message,
  toolResults,
  isRunning,
  onA2uiAction,
  onHitlRespond,
}: MessageItemProps) {
  const role = message.role;
  const text = extractText(message);
  const toolCalls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
  const isUser = role === "user";

  return (
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
        // A HITL call is the agent waiting on the user: render the prompt (or
        // the answer it got) instead of the generic tool card.
        const hitlRequest = parseHitlRequest(call.function.name, call.function.arguments);
        if (hitlRequest) {
          return (
            <HitlPrompt
              key={call.id}
              request={hitlRequest}
              result={toolResults.get(call.id)}
              busy={isRunning}
              onRespond={(content) => onHitlRespond(call.id, content)}
            />
          );
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
  );
}

/** Whether the message has anything to render (text or tool calls). */
export function hasRenderableContent(message: Message): boolean {
  if (extractText(message).trim().length > 0) {
    return true;
  }
  return message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0;
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
