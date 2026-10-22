import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";

import {
  DEMO_IMAGE_BASE64,
  startDemoHttpServer,
  type DemoHttpServer,
} from "@ai-chat/mcp-server-demo";

import {
  createMcpToolRegistry,
  McpToolRegistry,
  type McpToolRegistryOptions,
} from "../src/mcp/registry.ts";
import type { McpServerConfig } from "../src/types.ts";
import { unreachableMcpUrl } from "./helpers.ts";

const DEMO_TOOLS = ["add", "echo", "fail", "get_image", "get_weather", "sleep", "whoami"];

/** Opens a registry for the test and closes its clients afterwards. */
function openRegistry(
  t: { after: (fn: () => Promise<void>) => void },
  servers: Record<string, McpServerConfig>,
  options?: McpToolRegistryOptions,
): McpToolRegistry {
  const registry = new McpToolRegistry(servers, options);
  t.after(() => registry.close());
  return registry;
}

async function callTool(
  registry: McpToolRegistry,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = (await registry.getTools()).get(name);
  assert.ok(tool, `tool "${name}" should be registered`);
  return tool.execute(args);
}

async function whoami(registry: McpToolRegistry, name: string) {
  return JSON.parse(await callTool(registry, name)) as {
    headers: Record<string, string>;
    auth: { clientId: string; scopes: string[] } | null;
  };
}

describe("createMcpToolRegistry", () => {
  test("returns undefined when no servers are configured", () => {
    assert.equal(createMcpToolRegistry(undefined), undefined);
    assert.equal(createMcpToolRegistry({}), undefined);
    assert.equal(createMcpToolRegistry({ servers: {} }), undefined);
  });

  test("returns a registry when servers are configured", () => {
    assert.ok(createMcpToolRegistry({ servers: { demo: { url: "http://127.0.0.1:1/mcp" } } }));
  });
});

describe("McpToolRegistry over Streamable HTTP", () => {
  let server: DemoHttpServer;

  before(async () => {
    server = await startDemoHttpServer();
  });

  after(() => server.close());

  test("defaults a url-only server to Streamable HTTP", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    assert.deepEqual(
      [...(await registry.getToolNames())].sort(),
      DEMO_TOOLS.map((name) => `demo__${name}`),
    );
  });

  test("describes tools with their server namespace and input schema", async (t) => {
    const registry = openRegistry(t, { demo: { transport: "http", url: server.url } });

    const echo = (await registry.getTools()).get("demo__echo");
    assert.equal(echo?.description, "MCP demo/echo: Echo the given text back.");
    assert.equal(echo?.parameters.type, "object");
    assert.deepEqual(Object.keys(echo?.parameters.properties as object), ["text"]);
  });

  test("reports per-server status", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    assert.deepEqual(registry.status(), [{ id: "demo", status: "pending", toolCount: 0 }]);
    await registry.connect();
    assert.deepEqual(registry.status(), [
      { id: "demo", status: "connected", toolCount: DEMO_TOOLS.length },
    ]);
  });

  test("returns plain text results verbatim", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    assert.equal(await callTool(registry, "demo__echo", { text: "你好 MCP" }), "你好 MCP");
    assert.deepEqual(
      JSON.parse(await callTool(registry, "demo__get_weather", { city: "Beijing" })),
      { city: "Beijing", condition: "sunny", temperatureC: 22 },
    );
  });

  test("serializes results with structured content as JSON", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    const result = JSON.parse(await callTool(registry, "demo__add", { a: 2, b: 3 }));
    assert.deepEqual(result.structuredContent, { sum: 5 });
    assert.deepEqual(result.content, [{ type: "text", text: "5" }]);
  });

  test("serializes non-text content as JSON", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    const result = JSON.parse(await callTool(registry, "demo__get_image"));
    assert.deepEqual(result.content, [
      { type: "image", data: DEMO_IMAGE_BASE64, mimeType: "image/png" },
    ]);
  });

  test("surfaces tool-level errors (isError) to the caller", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    const result = JSON.parse(await callTool(registry, "demo__fail", { message: "boom" }));
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "boom" }]);
  });

  test("ignores non-object arguments instead of forwarding them", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    const tool = (await registry.getTools()).get("demo__get_image");

    // The loop passes `{}` for unparseable args, but guard the boundary anyway.
    const result = await tool!.execute(["not", "an", "object"] as unknown as Record<
      string,
      unknown
    >);
    assert.equal(JSON.parse(result).content[0].type, "image");
  });

  test("sends the configured headers on every request", async (t) => {
    const registry = openRegistry(t, {
      demo: { url: server.url, headers: { "x-demo-client": "agents-test" } },
    });

    const { headers, auth } = await whoami(registry, "demo__whoami");
    assert.equal(headers["x-demo-client"], "agents-test");
    assert.equal(auth, null);
  });

  test("reuses one MCP session for every call", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    const before = server.sessionCount;

    const first = await whoami(registry, "demo__whoami");
    const second = await whoami(registry, "demo__whoami");
    assert.ok(first.headers["mcp-session-id"], "requests carry the Mcp-Session-Id header");
    assert.equal(second.headers["mcp-session-id"], first.headers["mcp-session-id"]);
    assert.equal(server.sessionCount, before + 1);
  });

  test("reconnects with a new session after close()", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    const first = await whoami(registry, "demo__whoami");
    await registry.close();
    const second = await whoami(registry, "demo__whoami");
    assert.notEqual(second.headers["mcp-session-id"], first.headers["mcp-session-id"]);
  });

  test("cancels an in-flight call when the run is aborted", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    const sleepTool = (await registry.getTools()).get("demo__sleep")!;
    const session = (await whoami(registry, "demo__whoami")).headers["mcp-session-id"];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const started = Date.now();
    await assert.rejects(
      async () => sleepTool.execute({ ms: 5_000 }, { signal: controller.signal }),
      /abort/i,
    );
    assert.ok(Date.now() - started < 2_000, "returned well before the 5s sleep finished");
    // An abort is our own cancel, not a transport failure: same session after.
    assert.equal((await whoami(registry, "demo__whoami")).headers["mcp-session-id"], session);
  });

  test("enforces timeoutMs on tool calls", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url, timeoutMs: 300 } });

    assert.equal(await callTool(registry, "demo__sleep", { ms: 10 }), "slept 10ms");
    await assert.rejects(callTool(registry, "demo__sleep", { ms: 5_000 }), /timed out/i);
    // A timeout is a JSON-RPC error: the session stays usable.
    assert.equal(await callTool(registry, "demo__echo", { text: "still here" }), "still here");
  });
});

describe("McpToolRegistry against a stateless Streamable HTTP server", () => {
  let server: DemoHttpServer;

  before(async () => {
    server = await startDemoHttpServer({ stateless: true });
  });

  after(() => server.close());

  test("works without a session id", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    assert.equal(await callTool(registry, "demo__echo", { text: "stateless" }), "stateless");
    const { headers } = await whoami(registry, "demo__whoami");
    assert.equal(headers["mcp-session-id"], undefined);
    assert.equal(server.sessionCount, 0);
  });
});

describe("McpToolRegistry with multiple servers", () => {
  let alpha: DemoHttpServer;
  let beta: DemoHttpServer;

  before(async () => {
    [alpha, beta] = await Promise.all([startDemoHttpServer(), startDemoHttpServer()]);
  });

  after(() => Promise.all([alpha.close(), beta.close()]).then(() => {}));

  test("merges tools from every server, each under its own namespace", async (t) => {
    const registry = openRegistry(t, { alpha: { url: alpha.url }, beta: { url: beta.url } });

    assert.equal((await registry.getToolNames()).size, DEMO_TOOLS.length * 2);
    assert.equal(await callTool(registry, "alpha__echo", { text: "a" }), "a");
    assert.equal(await callTool(registry, "beta__echo", { text: "b" }), "b");
  });

  test("keeps the healthy servers when one is unreachable", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { url } = await unreachableMcpUrl();
    const registry = openRegistry(t, { broken: { url }, alpha: { url: alpha.url } });

    const names = [...(await registry.getToolNames())];
    assert.equal(names.length, DEMO_TOOLS.length);
    assert.ok(names.every((name) => name.startsWith("alpha__")));
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /skipping server "broken"/);

    const broken = registry.status().find((server) => server.id === "broken");
    assert.equal(broken?.status, "failed");
    assert.ok(broken?.error);
  });

  test("sanitizes server ids into valid tool names", async (t) => {
    const registry = openRegistry(t, { "my server.v2": { url: alpha.url } });

    assert.ok((await registry.getToolNames()).has("my_server_v2__echo"));
    assert.equal(await callTool(registry, "my_server_v2__echo", { text: "ok" }), "ok");
  });

  test("shortens over-long tool names to 64 chars and keeps them unique", async (t) => {
    const registry = openRegistry(t, { ["x".repeat(80)]: { url: alpha.url } });

    const names = [...(await registry.getToolNames())];
    assert.equal(names.length, DEMO_TOOLS.length);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
      assert.ok(name.length <= 64, `${name} is ${name.length} chars`);
      assert.match(name, /^[A-Za-z0-9_-]+$/);
    }
  });

  test("retries a server that was down on the first load", async (t) => {
    t.mock.method(console, "warn", () => {});
    const { url, port } = await unreachableMcpUrl();
    const registry = openRegistry(t, { late: { url } }, { retryDelayMs: 0 });
    assert.equal((await registry.getTools()).size, 0);

    const late = await startDemoHttpServer({ port });
    t.after(() => late.close());
    assert.equal((await registry.getTools()).size, DEMO_TOOLS.length);
  });

  test("waits retryDelayMs before retrying a failed server", async (t) => {
    t.mock.method(console, "warn", () => {});
    const { url, port } = await unreachableMcpUrl();
    const registry = openRegistry(t, { late: { url } }, { retryDelayMs: 60_000 });
    assert.equal((await registry.getTools()).size, 0);

    const late = await startDemoHttpServer({ port });
    t.after(() => late.close());
    assert.equal((await registry.getTools()).size, 0, "still inside the retry delay");
  });

  test("reconnects when the server restarts and forgets the session", async (t) => {
    const first = await startDemoHttpServer();
    const { port } = first;
    const registry = openRegistry(t, { demo: { url: first.url } });
    const tool = (await registry.getTools()).get("demo__echo")!;
    assert.equal(await tool.execute({ text: "before" }), "before");

    await first.close();
    const second = await startDemoHttpServer({ port });
    t.after(() => second.close());
    // Let the client notice its pooled keep-alive sockets died with the old
    // server; otherwise the next request fails with ECONNRESET instead of 404.
    await sleep(50);

    // The stale session fails once (404), then the next call opens a new one.
    await assert.rejects(async () => tool.execute({ text: "lost" }), /Session not found/);
    assert.equal(await tool.execute({ text: "after" }), "after");
    assert.equal(second.sessionCount, 1);
  });
});
