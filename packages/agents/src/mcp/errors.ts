/**
 * Thrown by `McpConnections.resetAuth` for a server that isn't configured or
 * doesn't use OAuth: a bad request, unlike a failure while resetting (say, the
 * credential store can't be written).
 */
export class McpOAuthUnsupportedError extends Error {
  readonly serverId: string;

  constructor(serverId: string) {
    super(`MCP server "${serverId}" does not support OAuth`);
    this.name = "McpOAuthUnsupportedError";
    this.serverId = serverId;
  }
}
