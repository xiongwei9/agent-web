import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadConfig } from "../src/config.ts";

describe("loadConfig defaults", () => {
  test("fills in the agent's settings", () => {
    const { agent } = loadConfig({ MODEL_API_KEY: "key", MCP_OAUTH_STORE_PATH: "off" });

    assert.deepEqual(agent.languageModel, {
      provider: "openai",
      api: "responses",
      apiKey: "key",
      baseURL: undefined,
      model: undefined,
      contextWindow: 1_000_000,
      headers: undefined,
    });
    assert.deepEqual(agent.execution, { maxToolIterations: 16 });
    assert.deepEqual(agent.codeMode, { enabled: false, timeoutMs: 30_000, toolDiscovery: "auto" });
    assert.equal(agent.debugEvents, false);
  });

  test("a base URL without a provider means an OpenAI-compatible gateway", () => {
    const { languageModel } = loadConfig({
      MODEL_BASE_URL: "http://localhost:4000/v1",
      MCP_OAUTH_STORE_PATH: "off",
    }).agent;

    assert.equal(languageModel.provider, "openai-compatible");
    assert.equal(languageModel.api, "responses");
  });

  test("set values win", () => {
    const { agent } = loadConfig({
      MODEL_PROVIDER: "anthropic",
      MODEL_NAME: "claude-sonnet-4-5",
      MODEL_API: "chat",
      MODEL_CONTEXT_WINDOW: "500000",
      AGENT_MAX_TOOL_ITERATIONS: "4",
      AGENT_DEBUG_EVENTS: "on",
      MCP_OAUTH_STORE_PATH: "off",
    });

    assert.equal(agent.languageModel.model, "claude-sonnet-4-5");
    assert.equal(agent.languageModel.api, "chat");
    assert.equal(agent.languageModel.contextWindow, 500_000);
    assert.equal(agent.execution.maxToolIterations, 4);
    assert.equal(agent.debugEvents, true);
  });
});

describe("required settings", () => {
  test("the server doesn't start without MODEL_NAME", async () => {
    const { buildApp } = await import("../src/server.ts");
    const config = loadConfig({ MODEL_API_KEY: "key", MCP_OAUTH_STORE_PATH: "off" });
    await assert.rejects(buildApp({ config }), /MODEL_NAME is required/);
  });
});
