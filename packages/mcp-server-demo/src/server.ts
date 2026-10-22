import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const DEMO_SERVER_VERSION = "0.1.0";

/** 1×1 transparent PNG, used by `get_image` to exercise non-text tool results. */
export const DEMO_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const WEATHER: Record<string, { condition: string; temperatureC: number }> = {
  beijing: { condition: "sunny", temperatureC: 22 },
  shanghai: { condition: "cloudy", temperatureC: 25 },
  singapore: { condition: "rain", temperatureC: 31 },
};

export interface DemoServerOptions {
  /** Server name reported in the MCP `initialize` handshake. */
  name?: string;
}

/**
 * Builds a demo MCP server whose tools cover each result shape the agent's MCP
 * client has to handle:
 *
 * - `echo` / `get_weather` — plain text results
 * - `add` — text plus `structuredContent`
 * - `get_image` — an image content block
 * - `fail` — a tool-level error (`isError: true`)
 * - `sleep` — a slow call, for timeout and cancellation
 * - `whoami` — echoes the HTTP request headers and the OAuth client, if any
 *
 * Served over Streamable HTTP by `http.ts`.
 */
export function createDemoServer(options: DemoServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "ai-chat-mcp-server-demo",
    version: DEMO_SERVER_VERSION,
  });

  server.registerTool(
    "echo",
    {
      description: "Echo the given text back.",
      inputSchema: { text: z.string().describe("Text to echo.") },
    },
    ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  server.registerTool(
    "add",
    {
      description: "Add two numbers.",
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { sum: z.number() },
    },
    ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
      structuredContent: { sum: a + b },
    }),
  );

  server.registerTool(
    "get_weather",
    {
      description: "Get the (fake) current weather for a city.",
      inputSchema: { city: z.string().describe("City name, e.g. Beijing.") },
    },
    ({ city }) => {
      const weather = WEATHER[city.trim().toLowerCase()];
      const text = weather
        ? JSON.stringify({ city, ...weather })
        : JSON.stringify({ city, condition: "unknown" });
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool("get_image", { description: "Return a tiny PNG image." }, () => ({
    content: [{ type: "image", data: DEMO_IMAGE_BASE64, mimeType: "image/png" }],
  }));

  server.registerTool(
    "fail",
    {
      description: "Always fails with a tool-level error.",
      inputSchema: { message: z.string().optional() },
    },
    ({ message }) => ({
      isError: true,
      content: [{ type: "text", text: message ?? "demo failure" }],
    }),
  );

  server.registerTool(
    "sleep",
    {
      description: "Wait for the given number of milliseconds, then reply.",
      inputSchema: { ms: z.number().int().min(0).max(60_000) },
    },
    async ({ ms }, extra) => {
      await delay(ms, extra.signal);
      return { content: [{ type: "text", text: `slept ${ms}ms` }] };
    },
  );

  server.registerTool(
    "whoami",
    { description: "Return the HTTP headers and OAuth client the request arrived with." },
    (extra) => {
      const auth = extra.authInfo
        ? { clientId: extra.authInfo.clientId, scopes: extra.authInfo.scopes }
        : null;
      const text = JSON.stringify({ headers: extra.requestInfo?.headers ?? {}, auth });
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
