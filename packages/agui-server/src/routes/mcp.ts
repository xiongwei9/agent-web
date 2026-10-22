import type { McpConnections } from "@ai-chat/agents";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { MCP_OAUTH_CALLBACK_PATH } from "../config.ts";

interface McpRoutesOptions {
  mcp: McpConnections | undefined;
}

const serverInfoSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "connected", "needs_auth", "failed"]),
  toolCount: z.number().int(),
  authorizationUrl: z.string().url().optional(),
  error: z.string().optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const mcpRoutes: FastifyPluginAsyncZod<McpRoutesOptions> = async (app, { mcp }) => {
  app.get(
    "/mcp/servers",
    {
      schema: {
        tags: ["mcp"],
        summary: "MCP server status",
        description:
          "Connects any MCP server that isn't connected yet, then reports each one's status. " +
          "A `needs_auth` server carries the `authorizationUrl` the user has to open.",
        response: {
          200: z.object({ servers: z.array(serverInfoSchema) }),
        },
      },
    },
    async () => {
      if (!mcp) {
        return { servers: [] };
      }
      await mcp.connect();
      return { servers: mcp.status() };
    },
  );

  app.get(
    MCP_OAUTH_CALLBACK_PATH,
    {
      schema: {
        tags: ["mcp"],
        summary: "MCP OAuth callback",
        description:
          "Redirect target of the MCP authorization servers. Exchanges the code for tokens " +
          "and connects the server, then renders a page the user can close.",
        querystring: callbackQuerySchema,
      },
    },
    async (request, reply) => {
      const { code, state, error, error_description: errorDescription } = request.query;
      reply.type("text/html; charset=utf-8");

      if (error) {
        return reply
          .status(400)
          .send(callbackPage("Authorization failed", errorDescription ?? error, false));
      }
      if (!mcp || !code || !state) {
        return reply
          .status(400)
          .send(callbackPage("Authorization failed", "Missing code or state.", false));
      }

      try {
        const server = await mcp.finishAuth(state, code);
        request.log.info({ server: server.id, status: server.status }, "mcp server authorized");
        return callbackPage(
          `Connected to ${server.id}`,
          `${server.toolCount} tools are now available to the agent. You can close this tab.`,
          true,
        );
      } catch (finishError) {
        request.log.warn(finishError, "mcp oauth callback failed");
        const message = finishError instanceof Error ? finishError.message : String(finishError);
        return reply.status(400).send(callbackPage("Authorization failed", message, false));
      }
    },
  );
};

function callbackPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, -apple-system, sans-serif; background: Canvas; color: CanvasText; }
  main { width: min(420px, calc(100% - 32px)); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; color: ${ok ? "#16a34a" : "#e5484d"}; }
  p { margin: 0; opacity: 0.75; }
</style>
</head>
<body>
<main>
  <h1>${ok ? "✓" : "⚠"} ${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
${ok ? "<script>setTimeout(() => window.close(), 1500);</script>" : ""}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
