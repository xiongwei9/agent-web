import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Message } from "@ag-ui/core";

import { buildPrompt } from "../src/loop/prompt.ts";
import { promptToolsForTest } from "./prompt-tools.ts";

function assistantCall(id: string, name: string, args: object, content?: string): Message {
  return {
    id: `a-${id}`,
    role: "assistant",
    content,
    toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function toolResult(toolCallId: string, content: string): Message {
  return { id: `t-${toolCallId}`, role: "tool", toolCallId, content };
}

const user = (content: string): Message => ({ id: `u-${content}`, role: "user", content });

describe("buildPrompt", () => {
  test("puts persona and request context into one leading system message", () => {
    const prompt = buildPrompt(
      [user("hi")],
      "You are helpful.",
      [{ description: "Timezone", value: "UTC+8" }],
      promptToolsForTest(),
    );

    assert.deepEqual(prompt, [
      { role: "system", content: "You are helpful.\n\nTimezone: UTC+8" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("replays a tool round trip as a tool call and its named result", () => {
    const prompt = buildPrompt(
      [user("time?"), assistantCall("c1", "get_server_time", {}), toolResult("c1", "12:00")],
      undefined,
      [],
      promptToolsForTest(),
    );

    assert.deepEqual(prompt.slice(1), [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_server_time", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "get_server_time",
            output: { type: "text", value: "12:00" },
          },
        ],
      },
    ]);
  });

  test("replays an A2UI surface as assistant text and the interaction as a user message", () => {
    const prompt = buildPrompt(
      [
        user("sign me up"),
        assistantCall("s1", "render_a2ui", { messages: [] }, "Here's a form."),
        toolResult("s1", "name: Ada"),
      ],
      undefined,
      [],
      promptToolsForTest(),
    );

    assert.deepEqual(prompt.slice(1), [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's a form." },
          {
            type: "text",
            text: '[A2UI surface rendered for the user]\n\n{\n  "messages": []\n}',
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "[A2UI user action]\n\nname: Ada" }] },
    ]);
  });

  test("backfills an unanswered HITL prompt as cancelled", () => {
    const prompt = buildPrompt(
      [
        user("delete it"),
        assistantCall("h1", "request_user_approval", { title: "Delete?" }),
        user("never mind"),
      ],
      undefined,
      [],
      promptToolsForTest(),
    );

    const backfill = prompt[2]!;
    assert.equal(backfill.role, "tool");
    assert.deepEqual(backfill.role === "tool" && JSON.parse(backfill.content[0]!.output.value), {
      cancelled: true,
      reason: "The user did not answer this prompt and continued the conversation instead.",
    });
    assert.deepEqual(prompt[3], { role: "user", content: [{ type: "text", text: "never mind" }] });
  });

  test("backfills any other unanswered tool call with a note", () => {
    const prompt = buildPrompt(
      [user("go"), assistantCall("x1", "some_client_tool", {}), user("next")],
      undefined,
      [],
      promptToolsForTest(),
    );

    const backfill = prompt[2]!;
    assert.ok(backfill.role === "tool");
    assert.equal(
      backfill.content[0]!.output.value,
      "No result was returned for this tool call; it was not completed.",
    );
  });
});
