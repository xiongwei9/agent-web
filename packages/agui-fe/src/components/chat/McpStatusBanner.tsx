import { Lock, TriangleAlert } from "lucide-react";

import { useMcpServers } from "../../hooks/useMcpServers";
import { Button } from "../ui/Button";

/**
 * Surfaces MCP servers the agent can't use yet: one that needs OAuth gets an
 * "Authorize" button that opens the authorization server's consent page in a
 * new tab (its callback closes the tab when done), one that failed shows why.
 * Connected servers render nothing.
 */
export function McpStatusBanner() {
  const servers = useMcpServers().filter(
    (server) => server.status === "needs_auth" || server.status === "failed",
  );
  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {servers.map((server) =>
        server.status === "needs_auth" ? (
          <div
            key={server.id}
            className="flex items-center gap-3 rounded-[10px] border border-accent bg-elevated px-3.5 py-2.5 text-sm"
          >
            <Lock className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              MCP server <code className="font-mono text-[13px]">{server.id}</code> needs
              authorization before the agent can use its tools.
            </span>
            <Button size="sm" onClick={() => window.open(server.authorizationUrl, "_blank")}>
              Authorize
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
