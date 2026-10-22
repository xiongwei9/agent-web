import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

import type { McpServerInfo } from "@ai-chat/agents";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";

import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/server.ts";

const PORT = "3999";

async function startApp(mcpServers?: Record<string, unknown>) {
  const config = loadConfig({
    MODEL_API_KEY: "test-key",
    PORT,
    MCP_SERVERS: mcpServers ? JSON.stringify(mcpServers) : undefined,
  });
  const app = await buildApp({ config });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof startApp>>;

async function getServers(app: App): Promise<McpServerInfo[]> {
  const response = await app.inject({ method: "GET", url: "/mcp/servers" });
  assert.equal(response.statusCode, 200);
  return response.json<{ servers: McpServerInfo[] }>().servers;
}

/** The user's part: open the consent page, click a button, follow the redirect. */
async function submitConsent(
  authorizationUrl: string,
  decision: "approve" | "deny" = "approve",
): Promise<URL> {
  const page = await fetch(authorizationUrl, { redirect: "manual" });
  const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(requestId, "the authorization URL renders the consent page");

  const response = await fetch(new URL("/consent", authorizationUrl), {
    method: "POST",
    body: new URLSearchParams({ request_id: requestId, decision }),
    redirect: "manual",
  });
  return new URL(response.headers.get("location")!);
}

describe("MCP routes", () => {
  let demo: DemoHttpServer;
  let app: App;

  before(async () => {
    demo = await startDemoHttpServer({ oauth: true });
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await demo.close();
  });

  beforeEach(async () => {
    app = await startApp({ demo: { url: demo.url } });
  });

  afterEach(() => app.close());

  test("reports an OAuth-protected server as needs_auth", async () => {
    const [server] = await getServers(app);
    assert.equal(server?.id, "demo");
    assert.equal(server?.status, "needs_auth");

    const url = new URL(server!.authorizationUrl!);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      `http://localhost:${PORT}/mcp/oauth/callback`,
    );
  });

  test("completes the OAuth flow through the callback route", async () => {
    const [server] = await getServers(app);
    const callback = await submitConsent(server!.authorizationUrl!);
    assert.equal(callback.origin, `http://localhost:${PORT}`);

    const response = await app.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] as string, /text\/html/);
    assert.match(response.body, /Connected to demo/);

    assert.deepEqual(await getServers(app), [{ id: "demo", status: "connected", toolCount: 7 }]);
  });

  test("shows the error when the user denies access", async () => {
    const [server] = await getServers(app);
    const callback = await submitConsent(server!.authorizationUrl!, "deny");

    const response = await app.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Authorization failed/);
    assert.match(response.body, /denied/);
    assert.equal((await getServers(app))[0]?.status, "needs_auth");
  });

  test("rejects a callback with an unknown state", async () => {
    await getServers(app);
    const response = await app.inject({
      method: "GET",
      url: "/mcp/oauth/callback?code=abc&state=forged",
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Unknown or expired OAuth state/);
  });

  test("rejects a callback without code or state", async () => {
    const response = await app.inject({ method: "GET", url: "/mcp/oauth/callback" });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Missing code or state/);
  });
});

describe("MCP routes without MCP servers", () => {
  test("report no servers", async (t) => {
    const app = await startApp();
    t.after(() => app.close());
    assert.deepEqual(await getServers(app), []);
  });
});
