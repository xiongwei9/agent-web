import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, mock, test } from "node:test";

import type { RunAgentInput } from "@ag-ui/core";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";
import { lastValueFrom, toArray } from "rxjs";

import { createAgent } from "../src/agent.ts";
import type { Agent } from "../src/types.ts";
import { submitConsent } from "./helpers.ts";

const HINT = 'The user authorizes it with the "Authorize" button above the chat.';

interface ChatRequest {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

/**
 * A fake OpenAI-compatible `/chat/completions` endpoint: records each request
 * and streams back a one-word answer, so a test can inspect exactly what the
 * agent sent the model.
 */
async function startFakeModel(): Promise<{
  baseURL: string;
  requests: ChatRequest[];
  server: Server;
}> {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body) as ChatRequest);
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, requests, server };
}

function runInput(runId: string): RunAgentInput {
  return {
    threadId: "thread-1",
    runId,
    messages: [{ id: `${runId}-user`, role: "user", content: "北京天气怎么样？" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

function systemPrompt(request: ChatRequest | undefined): string {
  const system = request?.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

function toolNames(request: ChatRequest | undefined): string[] {
  return request?.tools?.map((tool) => tool.function.name) ?? [];
}

describe("createAgent with an MCP server awaiting authorization", () => {
  let demo: DemoHttpServer;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let agent: Agent;

  before(async () => {
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {}); // the loop logs every LLM request
    [demo, model] = await Promise.all([startDemoHttpServer({ oauth: true }), startFakeModel()]);
    agent = createAgent({
      languageModel: {
        provider: "openai-compatible",
        api: "chat",
        apiKey: "test-key",
        baseURL: model.baseURL,
        model: "fake",
      },
      mcp: {
        servers: { demo: { url: demo.url } },
        oauth: { redirectUrl: "http://127.0.0.1:9/callback", authorizationHint: HINT },
      },
    });
  });

  after(async () => {
    mock.restoreAll();
    await agent.mcp?.close();
    await demo.close();
    await new Promise((resolve) => model.server.close(resolve));
  });

  test("tells the model the server needs authorization, without its tools", async () => {
    await lastValueFrom(agent.run(runInput("run-1")).pipe(toArray()));

    const request = model.requests.at(-1);
    const prompt = systemPrompt(request);
    assert.match(prompt, /## MCP servers awaiting authorization/);
    assert.match(prompt, /`demo`/);
    assert.ok(prompt.includes(HINT), "the app's hint reaches the model");
    assert.ok(toolNames(request).includes("get_server_time"));
    assert.ok(!toolNames(request).some((name) => name.startsWith("demo__")));
  });

  test("scopes authorization per user", async () => {
    await lastValueFrom(agent.run(runInput("alice-1"), { userId: "alice" }).pipe(toArray()));
    const [info] = agent.mcp!.status("alice");
    const callback = await submitConsent(info!.authorizationUrl!);
    await agent.mcp!.finishAuth(
      callback.searchParams.get("state")!,
      callback.searchParams.get("code")!,
    );

    await lastValueFrom(agent.run(runInput("alice-2"), { userId: "alice" }).pipe(toArray()));
    const alice = model.requests.at(-1);
    await lastValueFrom(agent.run(runInput("bob-1"), { userId: "bob" }).pipe(toArray()));
    const bob = model.requests.at(-1);

    assert.ok(toolNames(alice).includes("demo__echo"));
    assert.doesNotMatch(systemPrompt(alice), /awaiting authorization/);
    assert.ok(!toolNames(bob).some((name) => name.startsWith("demo__")));
    assert.match(systemPrompt(bob), /awaiting authorization/);
  });

  test("drops the note and adds the tools on the next run once authorized", async () => {
    const [info] = agent.mcp!.status();
    const callback = await submitConsent(info!.authorizationUrl!);
    await agent.mcp!.finishAuth(
      callback.searchParams.get("state")!,
      callback.searchParams.get("code")!,
    );

    await lastValueFrom(agent.run(runInput("run-2")).pipe(toArray()));

    const request = model.requests.at(-1);
    assert.doesNotMatch(systemPrompt(request), /awaiting authorization/);
    assert.ok(toolNames(request).includes("demo__get_weather"));
  });
});
