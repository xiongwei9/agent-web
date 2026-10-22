import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";

import { runAgentLoop, type RunOptions } from "../src/loop/loop.ts";
import type { ServerTool } from "../src/tools/types.ts";
import type { AgentLogger } from "../src/types.ts";
import { scriptedModel, textTurn, toolCallTurn } from "./helpers.ts";

type AnyEvent = BaseEvent & Record<string, unknown>;

const USER_MESSAGE: Message = { id: "m1", role: "user", content: "hi" };

function counterTool(): ServerTool & { calls: number } {
  const tool = {
    calls: 0,
    name: "count",
    description: "Counts calls.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      tool.calls += 1;
      return String(tool.calls);
    },
  };
  return tool;
}

function recordingLogger(): AgentLogger & { lines: Record<string, string[]> } {
  const lines: Record<string, string[]> = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (message) => lines.debug!.push(message),
    info: (message) => lines.info!.push(message),
    warn: (message) => lines.warn!.push(message),
    error: (message) => lines.error!.push(message),
  };
}

async function run(options: Partial<RunOptions> & Pick<RunOptions, "model">) {
  const events = runAgentLoop({
    threadId: "thread-1",
    runId: "run-1",
    messages: [USER_MESSAGE],
    clientTools: [],
    context: [],
    persona: undefined,
    serverTools: new Map(),
    ...options,
  });
  return (await lastValueFrom(events.pipe(toArray()))) as AnyEvent[];
}

describe("runAgentLoop tool budget", () => {
  test("ends with a tools-disabled turn once the budget is spent", async () => {
    const tool = counterTool();
    const { model, calls } = scriptedModel([
      toolCallTurn("count", {}, "c1"),
      toolCallTurn("count", {}, "c2"),
      textTurn("counted twice"),
    ]);
    const events = await run({
      model,
      serverTools: new Map([[tool.name, tool]]),
      maxToolIterations: 2,
    });

    assert.equal(tool.calls, 2);
    assert.deepEqual(
      calls.map((call) => call.toolChoice?.type),
      ["auto", "auto", "none"],
    );
    // The final turn still sees both tool results.
    assert.equal(calls[2]!.prompt.filter((message) => message.role === "tool").length, 2);
    const text = events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
    assert.deepEqual(
      text.map((event) => event.delta),
      ["counted twice"],
    );
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  });

  test("doesn't run tools the model calls after the budget", async () => {
    const tool = counterTool();
    const logger = recordingLogger();
    const { model, calls } = scriptedModel([
      toolCallTurn("count", {}, "c1"),
      toolCallTurn("count", {}, "c2"), // ignores toolChoice: none
    ]);
    const events = await run({
      model,
      serverTools: new Map([[tool.name, tool]]),
      maxToolIterations: 1,
      logger,
    });

    assert.equal(tool.calls, 1);
    assert.equal(calls.length, 2);
    assert.match(logger.lines.warn![0] ?? "", /after the 1-round limit/);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  });

  test("doesn't add a final turn when the model stops on its own", async () => {
    const { model, calls } = scriptedModel([textTurn("done")]);
    await run({ model, maxToolIterations: 1 });

    assert.equal(calls.length, 1);
  });
});

describe("runAgentLoop logging", () => {
  test("logs prompts and responses at debug level only", async () => {
    const logger = recordingLogger();
    const { model } = scriptedModel([textTurn("secret answer")]);
    await run({ model, logger });

    assert.equal(logger.lines.debug!.length, 2);
    assert.match(logger.lines.debug![0]!, /→ LLM request/);
    assert.match(logger.lines.debug![1]!, /secret answer/);
    assert.deepEqual([...logger.lines.info!, ...logger.lines.warn!], []);
  });

  test("prints nothing to the console by default", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    const info = t.mock.method(console, "info", () => {});
    const { model } = scriptedModel([textTurn("quiet")]);
    await run({ model });

    assert.equal(log.mock.callCount() + info.mock.callCount(), 0);
  });
});

describe("runAgentLoop abort", () => {
  test("passes the run's abort signal to tools", async () => {
    let received: AbortSignal | undefined;
    const tool: ServerTool = {
      name: "slow",
      description: "Waits for abort.",
      parameters: { type: "object", properties: {} },
      execute: (_args, context) =>
        new Promise((_resolve, reject) => {
          received = context?.signal;
          context?.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const { model } = scriptedModel([toolCallTurn("slow", {})]);
    const subscription = runAgentLoop({
      threadId: "thread-1",
      runId: "run-1",
      messages: [USER_MESSAGE],
      clientTools: [],
      context: [],
      persona: undefined,
      model,
      serverTools: new Map([[tool.name, tool]]),
    }).subscribe();

    while (!received) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(received.aborted, false);
    subscription.unsubscribe(); // the client disconnected
    assert.equal(received.aborted, true);
  });
});
