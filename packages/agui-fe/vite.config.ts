import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// The AG-UI server defaults to http://localhost:3000. During dev we proxy
// `/agui` and `/mcp` to it so the browser talks to the Vite origin and avoids CORS edge
// cases. Override with VITE_AGUI_TARGET (build-time) if the server lives
// elsewhere.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_AGUI_TARGET ?? "http://localhost:3000";

  return {
    plugins: [react(), tailwindcss(), exitOnSigint()],
    server: {
      port: 5173,
      proxy: {
        "/agui": {
          target,
          changeOrigin: true,
        },
        // MCP server status + OAuth callback (see agui-server routes/mcp.ts).
        "/mcp": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});

/**
 * Vite leaves SIGINT to Node's default handler, so Ctrl+C kills it by signal
 * and pnpm reports the dev run as failed. Close the server and exit 0 instead.
 *
 * Under `pnpm dev`, the outer pnpm forwards the interrupt too, and the inner
 * one escalates a second SIGINT to SIGTERM — which Vite stops handling once
 * `server.close()` starts. So swallow every SIGINT / SIGTERM after the first.
 */
function exitOnSigint(): Plugin {
  return {
    name: "exit-on-sigint",
    apply: "serve",
    configureServer(server) {
      let closing = false;
      const close = () => {
        if (closing) {
          return;
        }
        closing = true;
        void server.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
    },
  };
}
