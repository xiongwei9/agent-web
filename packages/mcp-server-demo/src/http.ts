import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type RequestHandler, type Response } from "express";

import { CONSENT_PATH, DEMO_SCOPE, DemoOAuthProvider } from "./oauth.ts";
import { createDemoServer, type DemoServerOptions } from "./server.ts";

const MCP_PATH = "/mcp";
const SESSION_HEADER = "mcp-session-id";
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;

export interface DemoHttpServerOptions extends DemoServerOptions {
  /** Port to listen on. Defaults to 0 (an ephemeral port). */
  port?: number;
  host?: string;
  /**
   * Protect `/mcp` with OAuth 2.1: the server doubles as its own authorization
   * server (discovery metadata, dynamic client registration, PKCE, refresh
   * tokens) and asks the user to approve each client on a consent page.
   */
  oauth?:
    | boolean
    | {
        accessTokenTtlSeconds?: number;
        /** JSON file to persist registered clients to; omitted, they live in memory. */
        clientsFile?: string;
        /**
         * JSON file to persist refresh tokens to, so a restart doesn't mean
         * authorizing again; omitted, they live in memory.
         */
        refreshTokensFile?: string;
      };
  /**
   * Serve without sessions: a fresh MCP server per POST, no `Mcp-Session-Id`,
   * and no standalone GET stream. Defaults to false (stateful sessions).
   */
  stateless?: boolean;
}

export interface DemoHttpServer {
  /** Streamable HTTP endpoint, e.g. `http://127.0.0.1:3901/mcp`. */
  url: string;
  port: number;
  /** Number of open MCP sessions (always 0 in stateless mode). */
  readonly sessionCount: number;
  close: () => Promise<void>;
}

/**
 * Serves the demo MCP server over Streamable HTTP at `/mcp`.
 *
 * Stateful mode (the default) follows the spec's session flow: `initialize`
 * opens a session whose id comes back in `Mcp-Session-Id`; later POST / GET /
 * DELETE requests must carry it, and an unknown id gets 404 so the client
 * re-initializes.
 */
export async function startDemoHttpServer(
  options: DemoHttpServerOptions = {},
): Promise<DemoHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = createMcpExpressApp({ host });
  const httpServer = createServer(app);

  // Listen first: the OAuth metadata has to advertise the real (maybe
  // ephemeral) port, and express picks up routes added after listen().
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const { port } = httpServer.address() as AddressInfo;
  const origin = new URL(`http://${host}:${port}`);
  const mcpUrl = new URL(MCP_PATH, origin);

  const handleStateless = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "POST") {
      res.status(405).set("allow", "POST").end();
      return;
    }

    const server = createDemoServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const handleStateful = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers[SESSION_HEADER];
    if (typeof sessionId === "string") {
      const transport = sessions.get(sessionId);
      if (!transport) {
        sendJsonRpcError(res, 404, "Session not found");
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session yet: only an `initialize` POST may open one.
    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      sendJsonRpcError(res, 400, "Missing Mcp-Session-Id header");
      return;
    }

    const server = createDemoServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
      void server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const mcpHandlers: RequestHandler[] = [];
  if (options.oauth) {
    const oauth = typeof options.oauth === "object" ? options.oauth : {};
    const provider = new DemoOAuthProvider({
      accessTokenTtlSeconds: oauth.accessTokenTtlSeconds || DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      clientsFile: oauth.clientsFile,
      refreshTokensFile: oauth.refreshTokensFile,
    });
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: origin,
        resourceServerUrl: mcpUrl,
        scopesSupported: [DEMO_SCOPE],
        resourceName: "ai-chat MCP server demo",
        // The demo runs locally and in tests; don't throttle it.
        authorizationOptions: { rateLimit: false },
        clientRegistrationOptions: { rateLimit: false },
        revocationOptions: { rateLimit: false },
        tokenOptions: { rateLimit: false },
      }),
    );
    app.post(CONSENT_PATH, express.urlencoded({ extended: false }), (req, res) =>
      provider.handleConsent(req, res),
    );
    mcpHandlers.push(
      requireBearerAuth({
        verifier: provider,
        requiredScopes: [DEMO_SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
      }),
    );
  }

  app.all(MCP_PATH, ...mcpHandlers, (req, res, next) => {
    (options.stateless ? handleStateless(req, res) : handleStateful(req, res)).catch(next);
  });

  return {
    url: mcpUrl.href,
    port,
    get sessionCount() {
      return sessions.size;
    },
    close: async () => {
      await Promise.allSettled([...sessions.values()].map((transport) => transport.close()));
      // Standalone GET streams never end on their own; drop them so close() can finish.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function sendJsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
