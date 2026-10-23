import { useCallback, useEffect, useState } from "react";

import { apiUrl } from "../lib/api";

/** Mirrors `McpServerInfo` from `@ai-chat/agents` (served by `GET /mcp/servers`). */
export interface McpServerInfo {
  id: string;
  status: "pending" | "connected" | "needs_auth" | "failed";
  toolCount: number;
  authorizationUrl?: string;
  error?: string;
}

const MCP_SERVERS_URL = apiUrl("mcp/servers");
const POLL_INTERVAL_MS = 3_000;

/**
 * Tracks the agent's MCP servers. Polls while any of them isn't connected yet —
 * e.g. waiting for the user to finish an OAuth flow in another tab — and stops
 * once they all are; refocusing the window checks again.
 */
export function useMcpServers(): McpServerInfo[] {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [settled, setSettled] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      // `include`: the session cookie identifies whose MCP servers these are,
      // also when the server is on another origin.
      const response = await fetch(MCP_SERVERS_URL, { signal, credentials: "include" });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { servers: McpServerInfo[] };
      setServers(body.servers);
      setSettled(body.servers.every((server) => server.status === "connected"));
    } catch {
      // Server not up yet, or the request was aborted: the next poll retries.
    }
  }, []);

  useEffect(() => {
    if (settled) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, settled]);

  useEffect(() => {
    const onFocus = () => {
      setSettled(false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return servers;
}
