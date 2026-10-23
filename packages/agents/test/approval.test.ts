import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { EventType, type AssistantMessage, type BaseEvent, type Message } from "@ag-ui/core";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";
import { lastValueFrom, toArray } from "rxjs";

import { HITL_REQUEST_APPROVAL_TOOL_NAME } from "../src/client-tools/hitl.ts";
import { withCodeMode, EXECUTE_CODE_TOOL } from "../src/code-mode/toolset.ts";
import { runAgentLoop, type RunOptions } from "../src/loop/loop.ts";
import { McpToolRegistry } from "../src/mcp/registry.ts";
import type { ModelCallOptions } from "../src/model/types.ts";
import { buildModelToolDefs } from "../src/tools/toolset.ts";
import type { ServerTool } from "../src/tools/types.ts";
import type { McpToolApproval } from "../src/types.ts";
import {
  CODE_MODE,
  MAX_TOOL_ITERATIONS,
  scriptedModel,
  textTurn,
  toolCallTurn,
} from "./helpers.ts";

type AnyEvent = BaseEvent & Record<string, unknown>;

const USER_MESSAGE: Message = { id: "m1", role: "user", content: "delete item 42" };

function recordingTool(
  name: string,
  requiresApproval: boolean,
): ServerTool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { id: { type: "string" } } },
    requiresApproval,
    execute: (args) => {
      calls.push(args);
      return `${name} done`;
    },
  };
}

async function run(
  options: Partial<RunOptions> & Pick<RunOptions, "model" | "serverTools">,
): Promise<AnyEvent[]> {
  const events = runAgentLoop({
    threadId: "thread-1",
    runId: "run-1",
    messages: [USER_MESSAGE],
    clientTools: [],
    context: [],
    persona: undefined,
    ...options,
    maxToolIterations: options.maxToolIterations ?? MAX_TOOL_ITERATIONS,
  });
  return (await lastValueFrom(events.pipe(toArray()))) as AnyEvent[];
}

/**
 * Folds a run's events into the history the way an AG-UI client does, so the
 * next run sees what a real client would send back.
 */
function applyEvents(messages: Message[], events: AnyEvent[]): Message[] {
  const next = structuredClone(messages);
  for (const event of events) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        next.push({ id: event.messageId as string, role: "assistant", content: "" });
        break;
      case EventType.TEXT_MESSAGE_CONTENT: {
        const message = next.find((candidate) => candidate.id === event.messageId)!;
        message.content = `${message.content as string}${event.delta as string}`;
        break;
      }
      case EventType.TOOL_CALL_START: {
        const parentId = (event.parentMessageId as string | undefined) ?? event.toolCallId;
        let parent = next.find((candidate) => candidate.id === parentId) as
          | AssistantMessage
          | undefined;
        if (!parent) {
          parent = { id: parentId as string, role: "assistant" };
          next.push(parent);
        }
        (parent.toolCalls ??= []).push({
          id: event.toolCallId as string,
          type: "function",
          function: { name: event.toolCallName as string, arguments: "" },
        });
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const call = next
          .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
          .find((candidate) => candidate.id === event.toolCallId)!;
        call.function.arguments += event.delta as string;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        next.push({
          id: event.messageId as string,
          role: "tool",
          toolCallId: event.toolCallId as string,
          content: event.content as string,
        });
        break;
      default:
        break;
    }
  }
  return next;
}

function approvalCall(messages: Message[]) {
  return messages
    .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
    .find((call) => call.function.name === HITL_REQUEST_APPROVAL_TOOL_NAME)!;
}

/** The client answers the approval prompt, as `agui-fe` does. */
function answer(messages: Message[], content: Record<string, unknown>): Message[] {
  return [
    ...messages,
    {
      id: "answer",
      role: "tool",
      toolCallId: approvalCall(messages).id,
      content: JSON.stringify(content),
    },
  ];
}

/** Every tool call and tool result the model was shown, in order. */
function toolTraffic(call: ModelCallOptions): string[] {
  return call.prompt.flatMap((message) => {
    if (message.role === "assistant") {
      return message.content.flatMap((part) =>
        part.type === "tool-call" ? [`call ${part.toolName}`] : [],
      );
    }
    if (message.role === "tool") {
      return message.content.map((part) => `result ${part.toolName}`);
    }
    return [`${message.role}`];
  });
}

/** Runs the first turn: the model calls `delete`, which needs approval. */
async function suspendOnApproval(tool: ServerTool) {
  const serverTools = new Map([[tool.name, tool]]);
  const first = scriptedModel([toolCallTurn("delete", { id: "42" })]);
  const events = await run({ model: first.model, serverTools });
  return { serverTools, events, history: applyEvents([USER_MESSAGE], events) };
}

describe("approval-gated server tools", () => {
  test("holds the call back and asks the user instead of running it", async () => {
    const tool = recordingTool("delete", true);
    const { events, history } = await suspendOnApproval(tool);

    assert.deepEqual(tool.calls, []);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.equal(
      events.filter((event) => event.type === EventType.TOOL_CALL_RESULT).length,
      0,
      "the held-back call has no result yet",
    );

    const prompt = approvalCall(history);
    const args = JSON.parse(prompt.function.arguments) as Record<string, unknown>;
    const gatedId = (history[1] as AssistantMessage).toolCalls![0]!.id;
    assert.deepEqual(args.toolCallIds, [gatedId]);
    assert.equal(args.title, "Run delete");
    assert.deepEqual(args.details, [{ label: "delete", value: '{\n  "id": "42"\n}' }]);
  });

  test("runs the call once approved, and the model sees only the call and its result", async () => {
    const tool = recordingTool("delete", true);
    const { serverTools, history } = await suspendOnApproval(tool);

    const resumed = scriptedModel([textTurn("Deleted.")]);
    const events = await run({
      model: resumed.model,
      serverTools,
      messages: answer(history, { decision: "approved" }),
    });

    assert.deepEqual(tool.calls, [{ id: "42" }]);
    const results = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.deepEqual(
      results.map((event) => event.content),
      ["delete done"],
    );
    assert.deepEqual(toolTraffic(resumed.calls[0]!), ["user", "call delete", "result delete"]);

    // The next run doesn't run it again: the client now has its result.
    const later = scriptedModel([textTurn("ok")]);
    const afterwards = applyEvents(answer(history, { decision: "approved" }), events);
    await run({
      model: later.model,
      serverTools,
      messages: [...afterwards, { id: "m2", role: "user", content: "thanks" }],
    });
    assert.equal(tool.calls.length, 1);
    assert.deepEqual(toolTraffic(later.calls[0]!), [
      "user",
      "call delete",
      "result delete",
      "user",
    ]);
  });

  test("doesn't run a rejected call, and tells the model why", async () => {
    const tool = recordingTool("delete", true);
    const { serverTools, history } = await suspendOnApproval(tool);

    const resumed = scriptedModel([textTurn("Okay, I won't.")]);
    const events = await run({
      model: resumed.model,
      serverTools,
      messages: answer(history, { decision: "rejected", comment: "wrong item" }),
    });

    assert.deepEqual(tool.calls, []);
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)!;
    const content = JSON.parse(result.content as string) as Record<string, unknown>;
    assert.equal(content.executed, false);
    assert.equal(content.comment, "wrong item");
    assert.match(content.reason as string, /rejected/);
  });

  test("doesn't run a call whose prompt the user skipped by typing", async () => {
    const tool = recordingTool("delete", true);
    const { serverTools, history } = await suspendOnApproval(tool);

    const resumed = scriptedModel([textTurn("Sure.")]);
    await run({
      model: resumed.model,
      serverTools,
      messages: [
        ...answer(history, { cancelled: true }),
        { id: "m2", role: "user", content: "actually, never mind" },
      ],
    });

    assert.deepEqual(tool.calls, []);
    // The call's result comes before the user's message, where providers expect it.
    assert.deepEqual(toolTraffic(resumed.calls[0]!), [
      "user",
      "call delete",
      "result delete",
      "user",
    ]);
  });

  test("doesn't act on an approval that isn't the latest thing in the history", async () => {
    const tool = recordingTool("delete", true);
    const { serverTools, history } = await suspendOnApproval(tool);

    const resumed = scriptedModel([textTurn("Noted.")]);
    const events = await run({
      model: resumed.model,
      serverTools,
      messages: [
        ...answer(history, { decision: "approved" }),
        { id: "m2", role: "user", content: "something else" },
      ],
    });

    assert.deepEqual(tool.calls, []);
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)!;
    assert.match(result.content as string, /lapsed/);
  });

  test("runs the other server tools of the same turn right away", async () => {
    const gated = recordingTool("delete", true);
    const free = recordingTool("lookup", false);
    const serverTools = new Map([
      [gated.name, gated],
      [free.name, free],
    ]);
    const { model } = scriptedModel([
      [
        ...toolCallTurn("lookup", { id: "42" }, "c1"),
        ...toolCallTurn("delete", { id: "42" }, "c2"),
      ],
    ]);
    const events = await run({ model, serverTools });

    assert.equal(free.calls.length, 1);
    assert.equal(gated.calls.length, 0);
    const history = applyEvents([USER_MESSAGE], events);
    const args = JSON.parse(approvalCall(history).function.arguments) as { toolCallIds: string[] };
    assert.equal(args.toolCallIds.length, 1);
  });

  test("tells the model the tool asks for approval by itself", () => {
    const [def] = buildModelToolDefs(new Map([["delete", recordingTool("delete", true)]]), []);
    assert.match(def!.description ?? "", /asks the user for approval first/);
  });

  test("keeps gated tools out of code mode's sandbox", () => {
    const gated = recordingTool("delete", true);
    const free = recordingTool("lookup", false);
    const tools = withCodeMode(
      {
        systemPrompt: undefined,
        serverTools: new Map([
          [gated.name, gated],
          [free.name, free],
        ]),
        frontendTools: new Map(),
        expandUserText: (text) => text,
      },
      CODE_MODE,
    );

    assert.deepEqual([...tools.serverTools.keys()].sort(), [EXECUTE_CODE_TOOL, "delete"].sort());
    assert.doesNotMatch(tools.serverTools.get(EXECUTE_CODE_TOOL)!.description, /delete/);
    assert.match(tools.systemPrompt ?? "", /`delete`/);
  });
});

describe("MCP tool approval", () => {
  let demo: DemoHttpServer;

  before(async () => {
    demo = await startDemoHttpServer();
  });

  after(async () => {
    await demo.close();
  });

  async function gatedTools(approval: McpToolApproval | undefined): Promise<string[]> {
    const registry = new McpToolRegistry({ demo: { url: demo.url, approval } });
    try {
      const tools = await registry.getTools();
      return [...tools.values()].filter((tool) => tool.requiresApproval).map((tool) => tool.name);
    } finally {
      await registry.close();
    }
  }

  test("gates the tools annotated as destructive by default", async () => {
    assert.deepEqual(await gatedTools(undefined), ["demo__delete_item"]);
  });

  test("gates every tool or none on request", async () => {
    assert.equal((await gatedTools("always")).length, 8);
    assert.deepEqual(await gatedTools("never"), []);
  });
});
