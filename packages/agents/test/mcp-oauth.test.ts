import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, mock, test } from "node:test";

import { DEMO_SCOPE, startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";

import { McpToolRegistry } from "../src/mcp/registry.ts";
import { createFileMcpOAuthStore } from "../src/mcp/oauth/store.ts";
import type { McpOAuthStore, McpServerConfig, McpServerInfo } from "../src/types.ts";
import { submitConsent } from "./helpers.ts";

// Never actually requested: the tests read `code` / `state` off the redirect.
const REDIRECT_URL = "http://127.0.0.1:9/mcp/oauth/callback";
const OAUTH = { redirectUrl: REDIRECT_URL, clientName: "agents-test" };

function openRegistry(
  t: { after: (fn: () => Promise<void>) => void },
  servers: Record<string, McpServerConfig>,
  {
    oauth = true,
    store,
    authorizationHint,
  }: { oauth?: boolean; store?: McpOAuthStore; authorizationHint?: string } = {},
): McpToolRegistry {
  const registry = new McpToolRegistry(servers, {
    oauth: oauth ? { ...OAUTH, store, authorizationHint } : undefined,
    retryDelayMs: 0,
  });
  t.after(() => registry.close());
  return registry;
}

function serverInfo(registry: McpToolRegistry, id = "demo"): McpServerInfo {
  const info = registry.status().find((server) => server.id === id);
  assert.ok(info, `server "${id}" should be configured`);
  return info;
}

/** Runs the whole flow: connect → consent → callback → finishAuth. */
async function authorize(registry: McpToolRegistry, id = "demo"): Promise<McpServerInfo> {
  await registry.connect();
  const { authorizationUrl } = serverInfo(registry, id);
  assert.ok(authorizationUrl, `server "${id}" should be waiting for authorization`);

  const callback = await submitConsent(authorizationUrl);
  return registry.finishAuth(
    callback.searchParams.get("state")!,
    callback.searchParams.get("code")!,
  );
}

describe("McpToolRegistry with an OAuth-protected server", () => {
  let server: DemoHttpServer;

  before(async () => {
    server = await startDemoHttpServer({ oauth: true });
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await server.close();
  });

  test("waits in needs_auth with a PKCE authorization URL", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    assert.equal((await registry.getTools()).size, 0);
    const info = serverInfo(registry);
    assert.equal(info.status, "needs_auth");
    assert.equal(info.toolCount, 0);

    const url = new URL(info.authorizationUrl!);
    assert.equal(url.origin + url.pathname, new URL("/authorize", server.url).href);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URL);
    assert.equal(url.searchParams.get("scope"), DEMO_SCOPE);
    assert.ok(url.searchParams.get("client_id"), "the client registered dynamically");
    assert.ok(url.searchParams.get("state"));
    assert.ok(url.searchParams.get("code_challenge"));
  });

  test("logs the authorization URL", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const registry = openRegistry(t, { demo: { url: server.url } });

    await registry.connect();
    assert.match(
      String(warn.mock.calls[0]?.arguments[0]),
      /server "demo" needs authorization; open http:\/\/127\.0\.0\.1:\d+\/authorize\?/,
    );
  });

  test("keeps the same authorization URL while the user is authorizing", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    await registry.connect();
    const first = serverInfo(registry).authorizationUrl;
    await registry.getTools();
    await registry.connect();
    assert.equal(serverInfo(registry).authorizationUrl, first);
  });

  test("connects and calls tools with the access token once authorized", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });

    const info = await authorize(registry);
    assert.deepEqual(info, { id: "demo", status: "connected", toolCount: 7 });

    const whoami = JSON.parse(await (await registry.getTools()).get("demo__whoami")!.execute({}));
    assert.equal(whoami.auth.scopes.join(" "), DEMO_SCOPE);
    assert.match(whoami.headers.authorization, /^Bearer /);
    assert.equal(
      await (await registry.getTools()).get("demo__echo")!.execute({ text: "authorized" }),
      "authorized",
    );
  });

  test("lets the user retry after denying consent", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    await registry.connect();
    const { authorizationUrl } = serverInfo(registry);

    const denied = await submitConsent(authorizationUrl!, "deny");
    assert.equal(denied.searchParams.get("error"), "access_denied");
    assert.equal(serverInfo(registry).status, "needs_auth");

    const approved = await submitConsent(authorizationUrl!, "approve");
    const info = await registry.finishAuth(
      approved.searchParams.get("state")!,
      approved.searchParams.get("code")!,
    );
    assert.equal(info.status, "connected");
  });

  test("rejects a callback with an unknown state", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    await registry.connect();

    await assert.rejects(registry.finishAuth("not-a-real-state", "code"), /Unknown or expired/);
    assert.equal(serverInfo(registry).status, "needs_auth");
  });

  test("rejects a replayed authorization code", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    await registry.connect();
    const callback = await submitConsent(serverInfo(registry).authorizationUrl!);
    const state = callback.searchParams.get("state")!;
    const code = callback.searchParams.get("code")!;

    await registry.finishAuth(state, code);
    // `state` is consumed by the first exchange.
    await assert.rejects(registry.finishAuth(state, code), /Unknown or expired/);
  });

  test("fails without OAuth configured", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } }, { oauth: false });

    await registry.connect();
    const info = serverInfo(registry);
    assert.equal(info.status, "failed");
    assert.match(info.error ?? "", /invalid_token/);
    assert.equal(info.authorizationUrl, undefined);
  });

  test("authorizes each protected server separately", async (t) => {
    const other = await startDemoHttpServer({ oauth: true });
    t.after(() => other.close());
    const registry = openRegistry(t, { demo: { url: server.url }, other: { url: other.url } });

    await registry.connect();
    assert.deepEqual(
      registry.status().map((info) => info.status),
      ["needs_auth", "needs_auth"],
    );

    await authorize(registry, "other");
    assert.deepEqual(
      registry.status().map((info) => [info.id, info.status]),
      [
        ["demo", "needs_auth"],
        ["other", "connected"],
      ],
    );
    assert.ok((await registry.getToolNames()).has("other__echo"));
    assert.ok(!(await registry.getToolNames()).has("demo__echo"));
  });
});

describe("McpToolRegistry token lifecycle", () => {
  before(() => {
    mock.method(console, "warn", () => {});
  });

  after(() => {
    mock.restoreAll();
  });

  test("refreshes an expired access token transparently", async (t) => {
    const server = await startDemoHttpServer({ oauth: { accessTokenTtlSeconds: 1 } });
    t.after(() => server.close());
    const registry = openRegistry(t, { demo: { url: server.url } });
    await authorize(registry);
    const echo = (await registry.getTools()).get("demo__echo")!;
    assert.equal(await echo.execute({ text: "fresh" }), "fresh");

    await sleep(1_100);
    assert.equal(await echo.execute({ text: "refreshed" }), "refreshed");
    assert.equal(serverInfo(registry).status, "connected");
  });

  test("keeps the tools and asks for authorization when the token stops working", async (t) => {
    const first = await startDemoHttpServer({ oauth: true });
    const { port } = first;
    const registry = openRegistry(t, { demo: { url: first.url } });
    await authorize(registry);
    const echo = (await registry.getTools()).get("demo__echo")!;
    assert.equal(await echo.execute({ text: "before" }), "before");

    // A restarted demo server has an empty client + token store.
    await first.close();
    const second = await startDemoHttpServer({ oauth: true, port });
    t.after(() => second.close());
    await sleep(50); // see "reconnects when the server restarts" in mcp.test.ts

    // The stale token gets 401; refreshing fails (unknown client), so the SDK
    // re-registers and starts a new authorization.
    await assert.rejects(
      async () => echo.execute({ text: "rejected" }),
      /MCP server "demo" needs the user's authorization before its tools can be used/,
    );
    const info = serverInfo(registry);
    assert.equal(info.status, "needs_auth");
    assert.ok(info.authorizationUrl, "a fresh authorization URL for the new server");

    // The model still sees the tools, and calling one explains what's wrong
    // without reconnecting (which would replace the authorization URL).
    assert.ok((await registry.getToolNames()).has("demo__echo"));
    await assert.rejects(
      async () => echo.execute({ text: "again" }),
      /needs the user's authorization/,
    );
    assert.equal(serverInfo(registry).authorizationUrl, info.authorizationUrl);

    await authorize(registry);
    assert.equal(
      await (await registry.getTools()).get("demo__echo")!.execute({ text: "after" }),
      "after",
    );
  });
});

describe("McpToolRegistry authorization prompt section", () => {
  let server: DemoHttpServer;
  let open: DemoHttpServer;

  before(async () => {
    [server, open] = await Promise.all([
      startDemoHttpServer({ oauth: true }),
      startDemoHttpServer(),
    ]);
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await Promise.all([server.close(), open.close()]);
  });

  test("is undefined when no server waits for authorization", async (t) => {
    const registry = openRegistry(t, { open: { url: open.url } });

    assert.equal(registry.authorizationPromptSection(), undefined, "before connecting");
    await registry.connect();
    assert.equal(registry.authorizationPromptSection(), undefined, "once connected");
  });

  test("names the servers waiting for authorization", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url }, open: { url: open.url } });
    await registry.connect();

    const section = registry.authorizationPromptSection();
    assert.match(section ?? "", /^## MCP servers awaiting authorization/);
    assert.match(section ?? "", /authorization before you can use them: `demo`\./);
    assert.doesNotMatch(section ?? "", /`open`/);
    assert.match(section ?? "", /Ask the user to authorize it, then try again\./);
  });

  test("uses the configured authorization hint", async (t) => {
    const hint = 'The user authorizes it with the "Authorize" button above the chat.';
    const registry = openRegistry(t, { demo: { url: server.url } }, { authorizationHint: hint });
    await registry.connect();

    assert.ok(registry.authorizationPromptSection()?.endsWith(hint));
  });

  test("goes away once the server is authorized", async (t) => {
    const registry = openRegistry(t, { demo: { url: server.url } });
    await authorize(registry);

    assert.equal(registry.authorizationPromptSection(), undefined);
  });
});

describe("McpToolRegistry with a file OAuth store", () => {
  let server: DemoHttpServer;
  let dir: string;

  before(async () => {
    server = await startDemoHttpServer({ oauth: true });
    dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("reuses the stored tokens after a restart", async (t) => {
    const path = join(dir, "restart.json");
    const first = openRegistry(
      t,
      { demo: { url: server.url } },
      { store: createFileMcpOAuthStore(path) },
    );
    await authorize(first);
    await first.close();

    // A new process: fresh registry, fresh store instance, same file.
    const second = openRegistry(
      t,
      { demo: { url: server.url } },
      { store: createFileMcpOAuthStore(path) },
    );
    await second.connect();
    assert.deepEqual(serverInfo(second), { id: "demo", status: "connected", toolCount: 7 });
    assert.equal(
      await (await second.getTools()).get("demo__echo")!.execute({ text: "no re-auth" }),
      "no re-auth",
    );
  });

  test("starts over when the server's URL changes", async (t) => {
    const path = join(dir, "moved.json");
    const store = createFileMcpOAuthStore(path);
    const first = openRegistry(t, { demo: { url: server.url } }, { store });
    await authorize(first);
    await first.close();

    // Same server id, different URL (a trailing query keeps it the same server).
    const second = openRegistry(t, { demo: { url: `${server.url}?v=2` } }, { store });
    await second.connect();
    assert.equal(serverInfo(second).status, "needs_auth");
  });
});
