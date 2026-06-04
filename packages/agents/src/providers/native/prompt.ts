import type { Context, Message } from "@ag-ui/core";

import { contextToText } from "../shared.ts";
import type { ModelAssistantContentPart, ModelMessage, ModelTextPart } from "./types.ts";

/**
 * Maps an AG-UI run (agent persona + request context + message history) onto
 * the standardized model prompt. This is what reconstructs a multi-turn,
 * tool-calling conversation — including Human-in-the-Loop resumes, where the
 * client replays prior assistant tool calls and `tool` result messages.
 *
 * To emit spec-valid tool-result parts (which require the tool's name) we track
 * each tool call's name from the assistant messages as we walk the history.
 */
export function buildPrompt(
  messages: Message[],
  persona: string | undefined,
  context: Context[],
): ModelMessage[] {
  const prompt: ModelMessage[] = [];

  const systemText = composeSystemText(persona, context);
  if (systemText) {
    prompt.push({ role: "system", content: systemText });
  }

  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        if (message.content) {
          prompt.push({ role: "system", content: message.content });
        }
        break;
      }
      case "user": {
        const text = extractUserText(message.content);
        prompt.push({ role: "user", content: [{ type: "text", text }] });
        break;
      }
      case "assistant": {
        const content: ModelAssistantContentPart[] = [];
        if (message.content) {
          content.push({ type: "text", text: message.content });
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolNameById.set(toolCall.id, toolCall.function.name);
          content.push({
            type: "tool-call",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            input: parseJsonObject(toolCall.function.arguments),
          });
        }
        if (content.length > 0) {
          prompt.push({ role: "assistant", content });
        }
        break;
      }
      case "tool": {
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: toolNameById.get(message.toolCallId) ?? message.toolCallId,
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
      }
      default:
        // reasoning / activity messages carry no model-prompt content here.
        break;
    }
  }

  return prompt;
}

/**
 * Builds the leading system message text from an agent's persona and the
 * request context. Returns undefined when both are empty. The loop reuses this
 * to rebuild the system message in place when a handoff swaps the active agent.
 */
export function composeSystemText(
  persona: string | undefined,
  context: Context[],
): string | undefined {
  return joinNonEmpty([persona, contextToText(context)]);
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "type" in part && part.type === "text"
          ? String((part as ModelTextPart).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function joinNonEmpty(parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}
