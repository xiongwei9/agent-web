import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { EventType, type BaseEvent } from "@ag-ui/core";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";
import { lastValueFrom, toArray } from "rxjs";

import { declareTools, schemaToType, toIdentifiers } from "../src/code-mode/declarations.ts";
import { runInSandbox } from "../src/code-mode/sandbox.ts";
import {
  EXECUTE_CODE_TOOL,
  SEARCH_TOOLS_TOOL,
  searchDeclarations,
  withCodeMode,
} from "../src/code-mode/toolset.ts";
import { runAgentLoop } from "../src/loop/loop.ts";
import { mcpCapability } from "../src/mcp/capability.ts";
import { createMcpToolRegistry } from "../src/mcp/registry.ts";
import { SkillsToolset } from "../src/skills/toolset.ts";
import { builtinCapability } from "../src/tools/builtin.ts";
import { resolveRunTools, type RunTools } from "../src/tools/toolset.ts";
import type { ServerTool } from "../src/tools/types.ts";
import { scriptedModel, textTurn, toolCallTurn } from "./helpers.ts";

type AnyEvent = BaseEvent & Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runTools(tools: ServerTool[]): RunTools {
  return {
    systemPrompt: "base",
    serverTools: new Map(tools.map((tool) => [tool.name, tool])),
    frontendTools: new Map(),
  };
}

function tool(name: string, execute: ServerTool["execute"], hidden?: boolean): ServerTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute,
    hidden,
  };
}

describe("code mode declarations", () => {
  test("turns JSON Schema into TypeScript", () => {
    const type = schemaToType({
      type: "object",
      properties: {
        city: { type: "string", description: "City name." },
        days: { type: "integer", default: 1 },
        unit: { enum: ["c", "f"] },
        tags: { type: "array", items: { type: ["string", "null"] } },
        "x-meta": { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["city"],
    });
    assert.equal(
      type,
      [
        "{",
        "  /** City name. */",
        "  city: string;",
        "  /** Default: 1 */",
        "  days?: number;",
        '  unit?: "c" | "f";',
        "  tags?: (string | null)[];",
        '  "x-meta"?: Record<string, number>;',
        "}",
      ].join("\n"),
    );
  });

  test("declares each tool as a method of `tools`; args are optional when nothing is required", () => {
    const declarations = declareTools([
      {
        identifier: "demo__get_weather",
        description: "Get the weather.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      { identifier: "get_server_time", description: "", parameters: { type: "object" } },
    ]);
    assert.match(declarations, /^interface Tools \{/);
    assert.match(declarations, /\ndeclare const tools: Tools;$/);
    assert.match(declarations, /\/\*\* Get the weather\. \*\/\n {2}demo__get_weather\(args: \{/);
    assert.match(
      declarations,
      /get_server_time\(args\?: Record<string, unknown>\): Promise<string>;/,
    );
  });

  test("types the result from the output schema", () => {
    const declarations = declareTools([
      {
        identifier: "add",
        description: "",
        parameters: { type: "object", properties: { a: { type: "number" } } },
        outputSchema: {
          type: "object",
          properties: { sum: { type: "number" } },
          required: ["sum"],
        },
      },
    ]);
    assert.match(declarations, /\): Promise<\{\n {4}sum: number;\n {2}\}>;/);
  });

  test("maps tool names onto unique identifiers", () => {
    const identifiers = toIdentifiers(["a-b", "a_b", "1st", "ok"]);
    assert.deepEqual([...identifiers.values()], ["a_b", "a_b_2", "_1st", "ok"]);
  });
});

describe("code mode sandbox", () => {
  const functions = {
    echo: async (args: Record<string, unknown>) => {
      await sleep(20);
      return JSON.stringify(args);
    },
    fail: async () => {
      throw new Error("boom");
    },
    hang: () => new Promise<string>(() => {}),
  };

  test("runs tool calls concurrently and returns the value and logs", async () => {
    const started = Date.now();
    const result = await runInSandbox({
      code: `
        const results = await Promise.all([1, 2, 3, 4, 5].map((n) => tools.echo({ n })));
        console.log("count", results.length, { done: true });
        return results.map((text) => JSON.parse(text).n);
      `,
      functions,
      timeoutMs: 5_000,
    });
    assert.deepEqual(result, {
      ok: true,
      value: [1, 2, 3, 4, 5],
      logs: ['count 5 {\n  "done": true\n}'],
    });
    assert.ok(Date.now() - started < 90, "the five 20ms calls overlap");
  });

  test("a failed tool call throws inside the code", async () => {
    const caught = await runInSandbox({
      code: `try { await tools.fail({}); } catch (error) { return "caught " + error.message; }`,
      functions,
      timeoutMs: 1_000,
    });
    assert.deepEqual(caught, { ok: true, value: "caught boom", logs: [] });

    const uncaught = await runInSandbox({
      code: "await tools.fail({});",
      functions,
      timeoutMs: 1_000,
    });
    assert.deepEqual(uncaught, { ok: false, error: "Error: boom", logs: [] });
  });

  test("reports syntax errors", async () => {
    const result = await runInSandbox({ code: "return )", functions, timeoutMs: 1_000 });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /^SyntaxError/);
  });

  test("stops busy loops and hung calls at the deadline", async () => {
    for (const code of [
      "while (true) {}",
      "await tools.echo({}); while (true) {}",
      "await tools.hang({});",
    ]) {
      const started = Date.now();
      const result = await runInSandbox({ code, functions, timeoutMs: 200 });
      assert.equal(result.ok, false, code);
      assert.match(!result.ok ? result.error : "", /timed out/, code);
      assert.ok(Date.now() - started < 1_000, code);
    }
  });

  test("stops when the run is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runInSandbox({
      code: "await tools.hang({});",
      functions,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    assert.deepEqual(result, { ok: false, error: "Execution was aborted.", logs: [] });
  });

  test("exposes nothing from the host but `tools` and `console`", async () => {
    const result = await runInSandbox({
      code: `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof call, typeof log, Object.isFrozen(tools)];`,
      functions,
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, {
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", true],
      logs: [],
    });
  });
});

describe("withCodeMode", () => {
  test("replaces the visible server tools with execute_code and keeps hidden ones", async () => {
    const tools = withCodeMode(
      runTools([tool("get_server_time", () => "noon"), tool("Skill", () => "instructions", true)]),
      {},
    );
    assert.deepEqual([...tools.serverTools.keys()].sort(), ["Skill", EXECUTE_CODE_TOOL]);
    assert.match(tools.systemPrompt ?? "", /^base\n\n## Code mode/);

    const executeCode = tools.serverTools.get(EXECUTE_CODE_TOOL)!;
    assert.match(executeCode.description, /get_server_time\(args\?: Record<string, unknown>\)/);
    const output = await executeCode.execute(
      { code: 'console.log("hi"); return await tools.get_server_time();' },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(JSON.parse(output), { result: "noon", logs: ["hi"] });
  });

  test("returns the error, with the logs so far, when the code fails", async () => {
    const tools = withCodeMode(runTools([tool("get_server_time", () => "noon")]), {});
    const output = await tools.serverTools
      .get(EXECUTE_CODE_TOOL)!
      .execute({ code: 'console.log("before"); throw new Error("nope");' });
    assert.deepEqual(JSON.parse(output), { error: "Error: nope", logs: ["before"] });
  });

  test("leaves the tools alone when there is nothing to wrap", () => {
    const original = runTools([tool("Skill", () => "", true)]);
    assert.equal(withCodeMode(original, {}), original);
  });

  test("keeps the skills tools direct", async () => {
    const skills = new SkillsToolset();
    const tools = withCodeMode(await resolveRunTools([builtinCapability(), skills]), {});
    assert.ok(tools.serverTools.has(EXECUTE_CODE_TOOL));
    assert.ok(!tools.serverTools.has("get_server_time"));
    if (skills.size > 0) {
      assert.ok(tools.serverTools.has("Skill"));
    }
  });

  test("runs nothing when the code fails to type-check", async () => {
    let calls = 0;
    const tools = withCodeMode(
      runTools([
        {
          ...tool("add", () => ""),
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          code: {
            outputSchema: { type: "object", properties: { sum: { type: "number" } } },
            execute: async () => {
              calls += 1;
              return { sum: 3 };
            },
          },
        },
      ]),
      {},
    );
    const executeCode = tools.serverTools.get(EXECUTE_CODE_TOOL)!;

    const failed = JSON.parse(
      await executeCode.execute({
        code: [
          "const first = await tools.add({ a: 1, b: 2 });",
          'const second = await tools.add({ a: "1" });',
          "await tools.subtract({});",
          "return first.total;",
        ].join("\n"),
      }),
    );
    assert.equal(calls, 0, "the first call is fine, but nothing ran");
    assert.match(failed.error, /failed to type-check/);
    assert.deepEqual(failed.typeErrors, [
      "line 2: Type 'string' is not assignable to type 'number'.",
      "line 3: Property 'subtract' does not exist on type 'Tools'.",
      "line 4: Property 'total' does not exist on type '{ sum?: number; }'.",
    ]);

    const typed = JSON.parse(
      await executeCode.execute({
        code: "const { sum }: { sum?: number } = await tools.add({ a: 1, b: 2 }); return sum * 2;",
      }),
    );
    assert.deepEqual(typed, { result: 6 }, "TypeScript runs once its types are stripped");
    assert.equal(calls, 1);
  });

  test("with typeCheck off, the code runs as written", async () => {
    const tools = withCodeMode(runTools([tool("get_server_time", () => "noon")]), {
      typeCheck: false,
    });
    const output = await tools.serverTools
      .get(EXECUTE_CODE_TOOL)!
      .execute({ code: "const time: number = await tools.get_server_time(); return time;" });
    assert.deepEqual(JSON.parse(output), { result: "noon" });
  });

  test("search discovery names the tools and looks their declarations up on demand", async () => {
    const tools = withCodeMode(
      runTools([
        { ...tool("demo__get_weather", () => ""), description: "Get the current weather." },
        { ...tool("demo__echo", () => ""), description: "Echo text back." },
        { ...tool("get_server_time", () => ""), description: "Get the server's time." },
      ]),
      { toolDiscovery: "search" },
    );
    assert.deepEqual(
      [...tools.serverTools.keys()].sort(),
      [EXECUTE_CODE_TOOL, SEARCH_TOOLS_TOOL].sort(),
    );
    assert.match(tools.systemPrompt ?? "", /look up its declaration with `search_tools`/);

    const description = tools.serverTools.get(EXECUTE_CODE_TOOL)!.description;
    assert.match(description, /demo__get_weather, demo__echo, get_server_time$/);
    assert.doesNotMatch(description, /interface Tools/);

    const search = tools.serverTools.get(SEARCH_TOOLS_TOOL)!;
    assert.equal(search.hidden, true);
    const weather = await search.execute({ query: "weather" });
    assert.match(weather, /Get the current weather\. \*\/\n {2}demo__get_weather\(/);
    assert.doesNotMatch(weather, /demo__echo/);
    const byName = await search.execute({ names: ["demo__echo", "get_server_time"] });
    assert.match(byName, /demo__echo\(/);
    assert.match(byName, /get_server_time\(/);
    assert.match(
      await search.execute({ query: "stock price" }),
      /^No tool matches\. The tools are: /,
    );

    // The code is still checked against every tool, searched or not.
    const output = JSON.parse(
      await tools.serverTools.get(EXECUTE_CODE_TOOL)!.execute({ code: "await tools.nope();" }),
    );
    assert.deepEqual(output.typeErrors, [
      "line 1: Property 'nope' does not exist on type 'Tools'.",
    ]);
  });

  test("auto discovery switches to search once the declarations get long", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...tool(`tool_${index}`, () => ""),
      description: "A tool with a fairly long description that adds up across many tools.",
    }));
    assert.ok(!withCodeMode(runTools(many.slice(0, 3)), {}).serverTools.has(SEARCH_TOOLS_TOOL));
    assert.ok(withCodeMode(runTools(many), {}).serverTools.has(SEARCH_TOOLS_TOOL));
    assert.ok(
      !withCodeMode(runTools(many), { toolDiscovery: "inline" }).serverTools.has(SEARCH_TOOLS_TOOL),
    );
  });

  test("ranks keyword matches on the name above the description", () => {
    const found = searchDeclarations(
      [
        { identifier: "send_mail", description: "Send an email.", parameters: {} },
        { identifier: "mail_search", description: "Find mail by query.", parameters: {} },
        { identifier: "calendar", description: "Events.", parameters: {} },
      ],
      "search mail",
      5,
    );
    assert.deepEqual(
      found.map((declaration) => declaration.identifier),
      ["mail_search", "send_mail"],
    );
  });
});

describe("agent loop in code mode", () => {
  let server: DemoHttpServer;

  before(async () => {
    server = await startDemoHttpServer();
  });

  after(() => server.close());

  test("the model calls MCP tools from code", async (t) => {
    const registry = createMcpToolRegistry({ servers: { demo: { url: server.url } } })!;
    t.after(() => registry.close());
    const tools = withCodeMode(
      await resolveRunTools([builtinCapability(), mcpCapability(registry)]),
      {},
    );

    const code = `
      const cities = ["Beijing", "Shanghai"];
      const reports = await Promise.all(cities.map((city) => tools.demo__get_weather({ city })));
      return reports.map((report) => JSON.parse(report)).map((r) => r.city + ": " + r.temperatureC);
    `;
    const { model, calls } = scriptedModel([
      toolCallTurn(EXECUTE_CODE_TOOL, { code }),
      textTurn("ok"),
    ]);
    const events = (await lastValueFrom(
      runAgentLoop({
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "m1", role: "user", content: "北京和上海的天气？" }],
        clientTools: [],
        context: [],
        persona: tools.systemPrompt,
        model,
        serverTools: tools.serverTools,
      }).pipe(toArray()),
    )) as AnyEvent[];

    const advertised = calls[0]!.tools!.map((def) => def.name);
    assert.deepEqual(advertised, [EXECUTE_CODE_TOOL]);
    const description = calls[0]!.tools![0]!.description ?? "";
    assert.match(description, /demo__get_weather\(args: \{/);
    assert.match(description, /get_server_time\(/);

    const [result] = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.deepEqual(JSON.parse(String(result?.content)), {
      result: ["Beijing: 22", "Shanghai: 25"],
    });
  });

  test("MCP tools with an output schema resolve to typed structured content; tool errors throw", async (t) => {
    const registry = createMcpToolRegistry({ servers: { demo: { url: server.url } } })!;
    t.after(() => registry.close());
    const tools = withCodeMode(await resolveRunTools([mcpCapability(registry)]), {});
    const executeCode = tools.serverTools.get(EXECUTE_CODE_TOOL)!;
    assert.match(
      executeCode.description,
      /demo__add\(args: \{[\s\S]*?\}\): Promise<\{\n\s+sum: number;/,
    );

    const output = await executeCode.execute({
      code: `
        const { sum } = await tools.demo__add({ a: 2, b: 3 });
        let failure = "";
        try {
          await tools.demo__fail({ message: "out of stock" });
        } catch (error) {
          failure = error.message;
        }
        return { doubled: sum * 2, failure };
      `,
    });
    assert.deepEqual(JSON.parse(output), { result: { doubled: 10, failure: "out of stock" } });
  });
});
