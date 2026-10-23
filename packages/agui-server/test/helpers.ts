import assert from "node:assert/strict";

import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/server.ts";

export const PORT = "3999";
export const SESSION_SECRET = "test-session-secret-that-is-long-enough";

export interface StartAppOptions {
  /** MCP OAuth token file; defaults to memory (`off`). */
  storePath?: string;
  /** Extra environment, e.g. a fake model endpoint. */
  env?: Record<string, string>;
}

/**
 * Builds the app like `src/index.ts` does. The OAuth store defaults to memory
 * and the session secret is fixed, so tests never touch a developer's real
 * `.mcp-oauth.json` or `.session-secret`.
 */
export async function startApp(
  mcpServers?: Record<string, unknown>,
  { storePath = "off", env = {} }: StartAppOptions = {},
) {
  const config = loadConfig({
    MODEL_API_KEY: "test-key",
    MODEL_NAME: "test-model",
    PORT,
    SESSION_SECRET,
    MCP_SERVERS: mcpServers ? JSON.stringify(mcpServers) : undefined,
    MCP_OAUTH_STORE_PATH: storePath,
    ...env,
  });
  const app = await buildApp({ config });
  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof startApp>>;

/** Keeps the session cookie between requests, like one browser would. */
export class Browser {
  cookie: string | undefined;

  constructor(cookie?: string) {
    this.cookie = cookie;
  }

  get(app: App, url: string): Promise<LightMyRequestResponse> {
    return this.request(app, { method: "GET", url });
  }

  async request(app: App, options: InjectOptions): Promise<LightMyRequestResponse> {
    const response = await app.inject({
      ...options,
      headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    const setCookie = response.headers["set-cookie"];
    if (setCookie) {
      this.cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    }
    return response;
  }
}

/** The user's part: open the consent page, click a button, follow the redirect. */
export async function submitConsent(
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
