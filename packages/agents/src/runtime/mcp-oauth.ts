import { randomBytes } from "node:crypto";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuthConfig } from "../types.ts";

const DEFAULT_CLIENT_NAME = "ai-chat agent";

/**
 * The OAuth client state for one MCP server, kept in memory for the process
 * lifetime (so a restart means authorizing again).
 *
 * The SDK drives the flow — discovery, dynamic client registration, PKCE, token
 * refresh. When it needs the user, it calls {@link redirectToAuthorization};
 * this server-side client can't open a browser, so it parks the URL in
 * {@link authorizationUrl} for the app to show, and the app later hands the
 * redirect's `code` back via `McpToolRegistry.finishAuth`, matched by
 * {@link pendingState}.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  /** Where the user has to go to approve this client, while authorization is pending. */
  authorizationUrl: URL | undefined;
  /** The `state` of the authorization request in flight, if any. */
  pendingState: string | undefined;

  private client: OAuthClientInformationMixed | undefined;
  private savedTokens: OAuthTokens | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private readonly config: McpOAuthConfig;

  constructor(config: McpOAuthConfig) {
    this.config = config;
  }

  get redirectUrl(): string {
    return this.config.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? DEFAULT_CLIENT_NAME,
      redirect_uris: [this.config.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: PKCE protects the code exchange, there is no secret.
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.pendingState = randomBytes(16).toString("base64url");
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.client = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens;
    this.authorizationUrl = undefined;
    this.pendingState = undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("No PKCE code verifier saved for this authorization");
    }
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") {
      this.client = undefined;
    }
    if (scope === "all" || scope === "tokens") {
      this.savedTokens = undefined;
    }
    if (scope === "all" || scope === "verifier") {
      this.verifier = undefined;
    }
    if (scope === "all" || scope === "discovery") {
      this.discovery = undefined;
    }
  }
}
