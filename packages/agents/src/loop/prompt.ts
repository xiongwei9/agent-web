import type { Context, Message } from "@ag-ui/core";

import type { ModelAssistantContentPart, ModelMessage, ModelTextPart } from "../model/types.ts";
import { joinSections, parseToolArguments } from "../shared/utils.ts";
import type { FrontendTool } from "../tools/types.ts";

const UNANSWERED_RESULT = "No result was returned for this tool call; it was not completed.";

/**
 * Maps an AG-UI run (agent persona + request context + message history) onto
 * the standardized model prompt. This is what reconstructs a multi-turn,
 * tool-calling conversation. A client tool can ask for its calls to be replayed
 * as conversation instead (`FrontendTool.replayAsText`, e.g. A2UI surfaces,
 * whose "result" is the user's next turn).
 *
 * To emit spec-valid tool-result parts (which require the tool's name) we track
 * each tool call's name from the assistant messages as we walk the history.
 *
 * Tool calls the client never answered are backfilled with a placeholder result
 * (the tool's `unansweredResult`, or a generic note). A run suspended on a
 * Human-in-the-Loop prompt leaves one open by design, and the user may simply
 * type instead of answering it — model APIs reject a prompt whose tool call
 * has no result, so the history is closed out here rather than failing the
 * next run.
 *
 * Each user message's text goes through `expandUserText` (e.g. a
 * `/skill-name` command becomes the skill's instructions plus the request).
 */
export function buildPrompt(
  messages: Message[],
  persona: string | undefined,
  context: Context[],
  clientTools: ReadonlyMap<string, FrontendTool> = new Map(),
  expandUserText: (text: string) => string = (text) => text,
): ModelMessage[] {
  const prompt: ModelMessage[] = [];

  const systemText = joinSections([persona, contextToText(context)]);
  if (systemText) {
    prompt.push({ role: "system", content: systemText });
  }

  const toolNameById = new Map<string, string>();
  /** Calls replayed as text, by id → the tool that formats their result. */
  const textReplays = new Map<string, NonNullable<FrontendTool["replayAsText"]>>();
  const answeredToolCallIds = new Set(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId: string }).toolCallId),
  );

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
        const text = expandUserText(extractUserText(message.content));
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
          const replay = clientTools.get(toolName)?.replayAsText;
          if (replay) {
            textReplays.set(toolCall.id, replay);
            content.push({ type: "text", text: replay.call(toolCall.function.arguments) });
            continue;
          }

          toolNameById.set(toolCall.id, toolName);
          content.push({
            type: "tool-call",
            toolCallId: toolCall.id,
            toolName,
            input: parseToolArguments(toolCall.function.arguments),
          });
        }
        if (content.length > 0) {
          prompt.push({ role: "assistant", content });
        }
        for (const part of content) {
          if (part.type === "tool-call" && !answeredToolCallIds.has(part.toolCallId)) {
            prompt.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: {
                    type: "text",
                    value: clientTools.get(part.toolName)?.unansweredResult ?? UNANSWERED_RESULT,
                  },
                },
              ],
            });
          }
        }
        break;
      }
      case "tool": {
        const replay = textReplays.get(message.toolCallId);
        if (replay) {
          prompt.push({
            role: "user",
            content: [{ type: "text", text: replay.result(message.content) }],
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

function contextToText(context: Context[]): string | undefined {
  if (context.length === 0) {
    return undefined;
  }

  return context.map((item) => `${item.description}: ${item.value}`).join("\n");
}
