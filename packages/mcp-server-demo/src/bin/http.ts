import { startDemoHttpServer } from "../http.ts";

// Prefixed env names so `pnpm dev` can run this next to agui-server (which owns
// PORT / HOST) without the two fighting over the same port.
const server = await startDemoHttpServer({
  port: Number(process.env.MCP_DEMO_PORT ?? 3901),
  host: process.env.MCP_DEMO_HOST,
  oauth: process.env.MCP_DEMO_OAUTH !== "false",
  stateless: process.env.MCP_DEMO_STATELESS === "true",
});

const auth = process.env.MCP_DEMO_OAUTH === "false" ? "no auth" : "OAuth required";
console.log(`[mcp-server-demo] streamable HTTP MCP server listening on ${server.url} (${auth})`);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
