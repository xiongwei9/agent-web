import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startDemoHttpServer } from "../http.ts";

/** The repo's `data/`, next to the other local state. Gitignored. */
const DATA_DIR = new URL("../../../../data/", import.meta.url);

/**
 * Where the OAuth server keeps some state: the env value (relative to the
 * working directory; `off` keeps it in memory), else `fileName` in `data/`.
 */
function stateFile(value: string | undefined, fileName: string): string | undefined {
  const path = value?.trim() || fileURLToPath(new URL(fileName, DATA_DIR));
  return path === "off" ? undefined : resolve(path);
}

// Prefixed env names so `pnpm dev` can run this next to agui-server (which owns
// PORT / HOST) without the two fighting over the same port.
const server = await startDemoHttpServer({
  port: Number(process.env.MCP_DEMO_PORT ?? 3901),
  host: process.env.MCP_DEMO_HOST,
  oauth: process.env.MCP_DEMO_OAUTH !== "false" && {
    clientsFile: stateFile(process.env.MCP_DEMO_CLIENTS_FILE, "mcp-demo-clients.json"),
    refreshTokensFile: stateFile(
      process.env.MCP_DEMO_REFRESH_TOKENS_FILE,
      "mcp-demo-refresh-tokens.json",
    ),
  },
  stateless: process.env.MCP_DEMO_STATELESS === "true",
});

const auth = process.env.MCP_DEMO_OAUTH === "false" ? "no auth" : "OAuth required";
console.log(`[mcp-server-demo] streamable HTTP MCP server listening on ${server.url} (${auth})`);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
