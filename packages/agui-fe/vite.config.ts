import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The AG-UI server defaults to http://localhost:3000. During dev we proxy
// `/agui` to it so the browser talks to the Vite origin and avoids CORS edge
// cases. Override with VITE_AGUI_TARGET (build-time) if the server lives
// elsewhere.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_AGUI_TARGET ?? "http://localhost:3000";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/agui": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
