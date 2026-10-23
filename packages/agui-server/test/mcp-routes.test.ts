import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

import type { McpServerInfo } from "@ai-chat/agents";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";

import { Browser, PORT, startApp, submitConsent, type App } from "./helpers.ts";

async function getServers(app: App, browser = new Browser()): Promise<McpServerInfo[]> {
  const response = await browser.get(app, "/mcp/servers");
  assert.equal(response.statusCode, 200);
  return response.json<{ servers: McpServerInfo[] }>().servers;
}

describe("MCP routes", () => {
  let demo: DemoHttpServer;
  let app: App;
  let browser: Browser;

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
    browser = new Browser();
  });

  afterEach(() => app.close());

  test("reports an OAuth-protected server as needs_auth", async () => {
    const [server] = await getServers(app, browser);
    assert.equal(server?.id, "demo");
    assert.equal(server?.status, "needs_auth");

    const url = new URL(server!.authorizationUrl!);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      `http://localhost:${PORT}/mcp/oauth/callback`,
    );
  });

  test("completes the OAuth flow through the callback route", async () => {
    const [server] = await getServers(app, browser);
    const callback = await submitConsent(server!.authorizationUrl!);
    assert.equal(callback.origin, `http://localhost:${PORT}`);

    const response = await app.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] as string, /text\/html/);
    assert.match(response.body, /Connected to demo/);

    assert.deepEqual(await getServers(app, browser), [
      { id: "demo", status: "connected", toolCount: 8 },
    ]);
  });

  test("shows the error when the user denies access", async () => {
    const [server] = await getServers(app, browser);
    const callback = await submitConsent(server!.authorizationUrl!, "deny");

    const response = await app.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Authorization failed/);
    assert.match(response.body, /denied/);
    assert.equal((await getServers(app, browser))[0]?.status, "needs_auth");
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

describe("MCP OAuth persistence", () => {
  let demo: DemoHttpServer;
  let dir: string;

  before(async () => {
    demo = await startDemoHttpServer({ oauth: true });
    dir = await mkdtemp(join(tmpdir(), "agui-mcp-oauth-"));
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await demo.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a restarted server reuses the stored tokens", async () => {
    const storePath = join(dir, "tokens.json");
    const browser = new Browser(); // the same browser before and after the restart
    const first = await startApp({ demo: { url: demo.url } }, { storePath });
    const [server] = await getServers(first, browser);
    const callback = await submitConsent(server!.authorizationUrl!);
    await first.inject({ method: "GET", url: callback.pathname + callback.search });
    await first.close();
    assert.ok(existsSync(storePath), "tokens were written to the store file");

    const second = await startApp({ demo: { url: demo.url } }, { storePath });
    try {
      assert.deepEqual(await getServers(second, browser), [
        { id: "demo", status: "connected", toolCount: 8 },
      ]);
    } finally {
      await second.close();
    }
  });
});
