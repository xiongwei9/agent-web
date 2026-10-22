import { useMcpServers } from "../hooks/useMcpServers";

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
    <div className="flex flex-col gap-2 px-5 pb-1">
      {servers.map((server) =>
        server.status === "needs_auth" ? (
          <div
            key={server.id}
            className="flex items-center gap-3 rounded-[10px] border border-accent bg-elevated px-3.5 py-2.5 text-sm"
          >
            <span aria-hidden="true" className="text-accent">
              ⚿
            </span>
            <span className="min-w-0 flex-1">
              MCP server <code className="font-mono text-[13px]">{server.id}</code> needs
              authorization before the agent can use its tools.
            </span>
            <button
              type="button"
              className="cursor-pointer rounded-lg border border-accent bg-accent px-3 py-1.25 text-[13px] font-medium text-white hover:bg-accent-strong"
              onClick={() => window.open(server.authorizationUrl, "_blank")}
            >
              Authorize
            </button>
          </div>
        ) : (
          <div
            key={server.id}
            className="rounded-[10px] border border-border bg-elevated px-3.5 py-2 text-[13px] text-muted"
          >
            ⚠ MCP server <code className="font-mono">{server.id}</code> is unavailable
            {server.error ? `: ${server.error}` : "."}
          </div>
        ),
      )}
    </div>
  );
}
