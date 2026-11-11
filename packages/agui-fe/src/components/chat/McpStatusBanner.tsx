import { Lock, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useMcpServers } from "../../hooks/useMcpServers";
import { Button } from "../ui/Button";

/**
 * Surfaces MCP servers the agent can't use yet: one that needs OAuth gets an
 * "Authorize" button that opens the authorization server's consent page in a
 * new tab (its callback closes the tab when done), one that failed shows why.
 * Connected servers render nothing.
 */
export function McpStatusBanner() {
  const { servers: allServers, resetAuthorization } = useMcpServers();
  const [resettingId, setResettingId] = useState<string>();
  const [resetError, setResetError] = useState<{ id: string; message: string }>();
  const servers = allServers.filter(
    (server) => server.status === "needs_auth" || server.status === "failed",
  );
  if (servers.length === 0) {
    return null;
  }

  const reset = async (id: string) => {
    setResettingId(id);
    setResetError(undefined);
    try {
      await resetAuthorization(id);
    } catch (error) {
      setResetError({ id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setResettingId(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {servers.map((server) =>
        server.status === "needs_auth" ? (
          <div
            key={server.id}
            className="flex flex-wrap items-center gap-3 rounded-[10px] border border-accent bg-elevated px-3.5 py-2.5 text-sm"
          >
            <Lock className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              MCP server <code className="font-mono text-[13px]">{server.id}</code> needs
              authorization before the agent can use its tools.
              {resetError?.id === server.id && (
                <span role="alert" className="block text-danger">
                  {resetError.message}
                </span>
              )}
            </span>
            <Button
              size="sm"
              disabled={resettingId !== undefined || !server.authorizationUrl}
              onClick={() => window.open(server.authorizationUrl, "_blank", "noopener,noreferrer")}
            >
              Authorize
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={resettingId !== undefined}
              title="Start over if the authorization page reports an invalid or unknown client."
              onClick={() => void reset(server.id)}
            >
              {resettingId === server.id ? "Resetting…" : "Reset authorization"}
            </Button>
          </div>
        ) : (
          <div
            key={server.id}
            className="flex items-start gap-2 rounded-[10px] border border-border bg-elevated px-3.5 py-2 text-[13px] text-muted"
          >
            <TriangleAlert className="mt-0.75 size-3.5 shrink-0" />
            <span className="min-w-0">
              MCP server <code className="font-mono">{server.id}</code> is unavailable
              {server.error ? `: ${server.error}` : "."}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
