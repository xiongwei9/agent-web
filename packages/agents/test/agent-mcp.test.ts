import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";
import { lastValueFrom, toArray } from "rxjs";

import { runAgentLoop } from "../src/loop/loop.ts";
import { mcpCapability } from "../src/mcp/capability.ts";
import { createMcpToolRegistry } from "../src/mcp/registry.ts";
import { builtinCapability } from "../src/tools/builtin.ts";
import { resolveRunTools } from "../src/tools/toolset.ts";
import type { LanguageModel, ModelMessage } from "../src/model/types.ts";
import type { McpConfig } from "../src/types.ts";
import {
  MAX_TOOL_ITERATIONS,
  scriptedModel,
  textTurn,
  toolCallTurn,
  unreachableMcpUrl,
} from "./helpers.ts";

type AnyEvent = BaseEvent & Record<string, unknown>;

const USER_MESSAGE: Message = { id: "m1", role: "user", content: "北京天气怎么样？" };

async function runWithMcp(
  t: { after: (fn: () => Promise<void>) => void },
  mcp: McpConfig,
  model: LanguageModel,
): Promise<AnyEvent[]> {
  const registry = createMcpToolRegistry(mcp)!;
  t.after(() => registry.close());
  const tools = await resolveRunTools([builtinCapability(), mcpCapability(registry)]);

  const events = runAgentLoop({
    threadId: "thread-1",
    runId: "run-1",
    messages: [USER_MESSAGE],
    clientTools: [],
    context: [],
    persona: undefined,
    model,
    serverTools: tools.serverTools,
    maxToolIterations: MAX_TOOL_ITERATIONS,
  });
  return (await lastValueFrom(events.pipe(toArray()))) as AnyEvent[];
}

function ofType(events: AnyEvent[], type: EventType): AnyEvent[] {
  return events.filter((event) => event.type === type);
}

/** The tool results the loop fed back to the model on a given turn. */
function toolResults(prompt: ModelMessage[]): string[] {
  return prompt.flatMap((message) =>
    message.role === "tool" ? message.content.map((part) => part.output.value) : [],
  );
}

describe("agent loop with MCP tools", () => {
  let server: DemoHttpServer;
  let other: DemoHttpServer;

  before(async () => {
    [server, other] = await Promise.all([startDemoHttpServer(), startDemoHttpServer()]);
  });

  after(() => Promise.all([server.close(), other.close()]).then(() => {}));

  test("advertises MCP tools to the model next to the builtins", async (t) => {
    const { model, calls } = scriptedModel([textTurn("hi")]);
    await runWithMcp(t, { servers: { demo: { url: server.url } } }, model);

    const advertised = new Set(calls[0]!.tools?.map((tool) => tool.name));
    assert.ok(advertised.has("get_server_time"));
    assert.ok(advertised.has("demo__get_weather"));
    assert.ok(advertised.has("demo__echo"));

    const weather = calls[0]!.tools?.find((tool) => tool.name === "demo__get_weather");
    assert.deepEqual(Object.keys(weather!.inputSchema.properties as object), ["city"]);
  });

  test("executes an MCP tool call and feeds the result back to the model", async (t) => {
    const { model, calls } = scriptedModel([
      toolCallTurn("demo__get_weather", { city: "Beijing" }),
      textTurn("北京今天晴，22°C。"),
    ]);
    const events = await runWithMcp(t, { servers: { demo: { url: server.url } } }, model);

    const [start] = ofType(events, EventType.TOOL_CALL_START);
    assert.equal(start?.toolCallName, "demo__get_weather");

    const [result] = ofType(events, EventType.TOOL_CALL_RESULT);
    assert.equal(result?.toolCallId, start?.toolCallId);
    assert.deepEqual(JSON.parse(String(result?.content)), {
      city: "Beijing",
      condition: "sunny",
      temperatureC: 22,
    });

    // Turn 2 sees the MCP result as the tool message for that call.
    assert.equal(calls.length, 2);
    assert.deepEqual(toolResults(calls[1]!.prompt), [result?.content]);

    const text = ofType(events, EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta);
    assert.deepEqual(text, ["北京今天晴，22°C。"]);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  });

  test("runs several MCP calls across servers in one turn", async (t) => {
    const { model, calls } = scriptedModel([
      [
        ...toolCallTurn("local__add", { a: 1, b: 2 }, "c1"),
        ...toolCallTurn("remote__echo", { text: "pong" }, "c2"),
      ],
      textTurn("done"),
    ]);
    const events = await runWithMcp(
      t,
      {
        servers: {
          local: { url: server.url },
          remote: { url: other.url },
        },
      },
      model,
    );

    const results = ofType(events, EventType.TOOL_CALL_RESULT).map((event) => event.content);
    assert.equal(results.length, 2);
    assert.deepEqual(JSON.parse(String(results[0])).structuredContent, { sum: 3 });
    assert.equal(results[1], "pong");
    assert.deepEqual(toolResults(calls[1]!.prompt), results);
  });

  test("hands MCP errors to the model instead of failing the run", async (t) => {
    const { model, calls } = scriptedModel([
      [
        ...toolCallTurn("remote__fail", { message: "upstream down" }, "c1"),
        ...toolCallTurn("remote__sleep", { ms: 5_000 }, "c2"),
      ],
      textTurn("抱歉，工具调用失败了。"),
    ]);
    const events = await runWithMcp(
      t,
      { servers: { remote: { url: server.url, timeoutMs: 300 } } },
      model,
    );

    const [failed, timedOut] = toolResults(calls[1]!.prompt);
    assert.equal(JSON.parse(failed!).isError, true);
    assert.match(timedOut!, /^Error: .*timed out/i);
    assert.equal(ofType(events, EventType.RUN_ERROR).length, 0);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  });

  test("still runs when every MCP server is unavailable", async (t) => {
    t.mock.method(console, "warn", () => {});
    const { model, calls } = scriptedModel([toolCallTurn("get_server_time", {}), textTurn("ok")]);
    const { url } = await unreachableMcpUrl();
    const events = await runWithMcp(t, { servers: { broken: { url } } }, model);

    const advertised = calls[0]!.tools?.map((tool) => tool.name) ?? [];
    assert.ok(advertised.includes("get_server_time"));
    assert.ok(!advertised.some((name) => name.startsWith("broken__")));
    assert.ok(JSON.parse(toolResults(calls[1]!.prompt)[0]!).iso);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  });
});
