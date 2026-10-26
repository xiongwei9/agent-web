import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

import type { McpServerInfo } from "@ai-chat/agents";
import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";

import { loadSessionSecret, SESSION_COOKIE } from "../src/session.ts";
import { Browser, startApp, submitConsent, type App } from "./helpers.ts";

async function servers(app: App, browser: Browser): Promise<McpServerInfo[]> {
  return (await browser.get(app, "/mcp/servers")).json<{ servers: McpServerInfo[] }>().servers;
}

/** One browser's whole OAuth flow, through the app's callback route. */
async function authorize(app: App, browser: Browser): Promise<void> {
  const [server] = await servers(app, browser);
  const callback = await submitConsent(server!.authorizationUrl!);
  const response = await app.inject({ method: "GET", url: callback.pathname + callback.search });
  assert.equal(response.statusCode, 200);
}

describe("session cookie", () => {
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

  test("issues a signed, httpOnly session cookie once", async () => {
    const browser = new Browser();
    const first = await browser.get(app, "/mcp/servers");
    const setCookie = String(first.headers["set-cookie"]);
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[^;]+\\.[^;]+;`), "value.signature");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const second = await browser.get(app, "/mcp/servers");
    assert.equal(second.headers["set-cookie"], undefined, "an existing session is kept");
  });

  test("keeps each browser's MCP authorization to itself", async () => {
    const alice = new Browser();
    const bob = new Browser();
    await authorize(app, alice);

    assert.equal((await servers(app, alice))[0]?.status, "connected");
    assert.equal((await servers(app, bob))[0]?.status, "needs_auth");
  });

  test("ignores a tampered cookie and starts a new session", async () => {
    const alice = new Browser();
    await authorize(app, alice);

    // Forge another session id under alice's signature.
    const [name, signed] = alice.cookie!.split("=");
    const signature = signed!.slice(signed!.lastIndexOf("."));
    const mallory = new Browser(`${name}=someone-else${signature}`);

    assert.equal((await servers(app, mallory))[0]?.status, "needs_auth");
    assert.notEqual(mallory.cookie, alice.cookie, "issued a fresh session instead");
  });

  test("sets the cookie on the streamed /agui response too", async (t) => {
    // A model endpoint on a closed local port: the run fails fast, offline.
    const offline = await startApp(undefined, {
      env: { MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "http://127.0.0.1:9/v1" },
    });
    t.after(() => offline.close());
    const browser = new Browser();
    const response = await browser.request(offline, {
      method: "POST",
      url: "/agui",
      headers: { accept: "text/event-stream" },
      payload: {
        threadId: "t1",
        runId: "r1",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      },
    });

    assert.match(String(response.headers["set-cookie"]), new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
  });
});

describe("loadSessionSecret", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agui-session-"));
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test("prefers the configured secret and writes nothing", async () => {
    const path = join(dir, "unused");
    assert.equal(loadSessionSecret("configured", path), "configured");
    await assert.rejects(stat(path));
  });

  test("generates a secret once, owner-only, and reuses it", async () => {
    const path = join(dir, "secret");
    const first = loadSessionSecret(undefined, path);

    assert.ok(first.length >= 32);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).trim(), first);
    assert.equal(loadSessionSecret(undefined, path), first);
  });

  test("creates the secret's directory", async () => {
    const path = join(dir, "data", "session-secret");
    const secret = loadSessionSecret(undefined, path);
    assert.equal((await readFile(path, "utf8")).trim(), secret);
  });
});
