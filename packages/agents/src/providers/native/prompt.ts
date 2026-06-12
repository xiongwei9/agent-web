import type { Context, Message } from "@ag-ui/core";

import { contextToText } from "../shared.ts";
import { A2UI_RENDER_TOOL_NAME } from "./a2ui.ts";
import type { ModelAssistantContentPart, ModelMessage, ModelTextPart } from "./types.ts";

/**
 * Maps an AG-UI run (agent persona + request context + message history) onto
 * the standardized model prompt. This is what reconstructs a multi-turn,
 * tool-calling conversation. A2UI render calls are UI-only history: the client
 * resumes with the user's interaction as a regular `user` message, so those
 * render calls are preserved as assistant text rather than model tool calls.
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

  const systemText = joinNonEmpty([persona, contextToText(context)]);
  if (systemText) {
    prompt.push({ role: "system", content: systemText });
  }

  const toolNameById = new Map<string, string>();
  const a2uiToolCallIds = new Set<string>();

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
          const toolName = toolCall.function.name;
          if (toolName === A2UI_RENDER_TOOL_NAME) {
            a2uiToolCallIds.add(toolCall.id);
            content.push({ type: "text", text: formatA2uiSurface(toolCall.function.arguments) });
            continue;
          }

          toolNameById.set(toolCall.id, toolName);
          content.push({
            type: "tool-call",
            toolCallId: toolCall.id,
            toolName,
            input: parseJsonObject(toolCall.function.arguments),
          });
        }
        if (content.length > 0) {
          prompt.push({ role: "assistant", content });
        }
        break;
      }
      case "tool": {
        if (a2uiToolCallIds.has(message.toolCallId)) {
          prompt.push({
            role: "user",
            content: [{ type: "text", text: formatA2uiAction(message.content) }],
          });
          break;
        }
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

function formatA2uiSurface(rawArgs: string): string {
  const parsed = parseJsonValue(rawArgs);
  const detail = parsed === undefined ? rawArgs : stringifyForPrompt(parsed);
  return (
    joinNonEmpty(["[A2UI surface rendered for the user]", detail]) ??
    "[A2UI surface rendered for the user]"
  );
}

function formatA2uiAction(content: string | undefined): string {
  return joinNonEmpty(["[A2UI user action]", content]) ?? "[A2UI user action]";
}

function parseJsonValue(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringifyForPrompt(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function joinNonEmpty(parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}
