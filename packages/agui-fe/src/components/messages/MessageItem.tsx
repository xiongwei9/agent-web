import { A2uiMessageListWrapperSchema, type A2uiMessage } from "@a2ui/web_core/v0_9";
import type { Message, ToolCall as ToolCallData } from "@ag-ui/core";

import type { A2uiActionPayload } from "../../lib/a2ui";
import { isHitlToolName } from "../../lib/hitl";
import { A2uiSurface } from "../cards/A2uiSurface";
import { Markdown } from "../ui/Markdown";
import { UserBubble } from "../ui/UserBubble";
import { StepGroup } from "../steps/StepGroup";
import { ToolCall } from "../steps/ToolCall";

/** Tool the agent calls to render an A2UI surface; rendered specially below. */
const A2UI_RENDER_TOOL_NAME = "render_a2ui";

interface MessageItemProps {
  /** One run of same-role messages (see {@link MessageList}). */
  messages: Message[];
  toolResults: Map<string, string>;
  /** A run is in flight, so steps without a result are still working. */
  isRunning: boolean;
  /** Send a user's A2UI interaction back to the agent to resume the run. */
  onA2uiAction: (payload: A2uiActionPayload) => void;
}

/** A piece of an assistant reply, in the order it was streamed. */
type Block =
  | { kind: "text"; id: string; text: string }
  /** Consecutive tool calls / skill activations, folded into one group. */
  | { kind: "steps"; calls: ToolCallData[] }
  /** A call that renders its own card: an A2UI surface. */
  | { kind: "card"; call: ToolCallData };

/**
 * Renders the content of one run of same-role messages. The role label is
 * rendered by {@link MessageList}, once per run.
 */
export function MessageItem({ messages, toolResults, isRunning, onA2uiAction }: MessageItemProps) {
  if (messages[0]?.role === "user") {
    return messages.map((message) => (
      <UserBubble key={message.id}>{extractText(message)}</UserBubble>
    ));
  }

  const renderCard = (call: ToolCallData) => {
    const result = toolResults.get(call.id);
    const surfaceMessages = parseA2uiMessages(call.function.arguments);
    if (surfaceMessages) {
      return <A2uiSurface key={call.id} messages={surfaceMessages} onAction={onA2uiAction} />;
    }
    // Arguments still streaming in.
    return (
      <ToolCall
        key={call.id}
        name={call.function.name}
        args={call.function.arguments}
        result={result}
        isRunning={isRunning}
      />
    );
  };

  return (
    <div className="flex max-w-full flex-col gap-3">
      {toBlocks(messages).map((block) => {
        switch (block.kind) {
          case "text":
            return <Markdown key={block.id} content={block.text} />;
          case "steps":
            return (
              <StepGroup
                key={block.calls[0]!.id}
                calls={block.calls}
                toolResults={toolResults}
                isRunning={isRunning}
              />
            );
          case "card":
            return renderCard(block.call);
        }
      })}
    </div>
  );
}

/**
 * Lays a reply's messages out as blocks. Tool calls between two pieces of text
 * merge into one step group even across messages (one per loop iteration), so
 * a long tool-using turn reads as text, one collapsed line, text. Cards break
 * the group: they're addressed to the user, so they stay in view.
 */
function toBlocks(messages: Message[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    const text = extractText(message);
    if (text.trim()) {
      blocks.push({ kind: "text", id: message.id, text });
    }
    const toolCalls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
    for (const call of toolCalls) {
      // HITL calls aren't part of the reply: an open one is answered in the dock
      // over the composer, an answered one is its own entry in MessageList.
      if (isHitlToolName(call.function.name)) {
        continue;
      }
      if (call.function.name === A2UI_RENDER_TOOL_NAME) {
        blocks.push({ kind: "card", call });
        continue;
      }
      const last = blocks.at(-1);
      if (last?.kind === "steps") {
        last.calls.push(call);
      } else {
        blocks.push({ kind: "steps", calls: [call] });
      }
    }
  }
  return blocks;
}

/** Whether the message has anything to render (text or non-HITL tool calls). */
export function hasRenderableContent(message: Message): boolean {
  if (extractText(message).trim().length > 0) {
    return true;
  }
  return (
    message.role === "assistant" &&
    (message.toolCalls ?? []).some((call) => !isHitlToolName(call.function.name))
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
