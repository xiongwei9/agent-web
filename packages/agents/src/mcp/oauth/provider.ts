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

import type { McpOAuthConfig, McpOAuthCredentials, McpOAuthStore } from "../../types.ts";

const DEFAULT_CLIENT_NAME = "ai-chat agent";

/**
 * The OAuth client state for one MCP server.
 *
 * The SDK drives the flow — discovery, dynamic client registration, PKCE, token
 * refresh. When it needs the user, it calls {@link redirectToAuthorization};
 * this server-side client can't open a browser, so it parks the URL in
 * {@link authorizationUrl} for the app to show, and the app later hands the
 * redirect's `code` back via `McpToolRegistry.finishAuth`, matched by
 * {@link pendingState}.
 *
 * The client registration, tokens, and discovery state go to the configured
 * {@link McpOAuthStore}; the in-flight authorization (state, PKCE verifier,
 * URL) stays in memory, so a restart mid-flow just starts a new one.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  /** Where the user has to go to approve this client, while authorization is pending. */
  authorizationUrl: URL | undefined;
  /** The `state` of the authorization request in flight, if any. */
  pendingState: string | undefined;

  private verifier: string | undefined;
  private readonly config: McpOAuthConfig;
  private readonly store: McpOAuthStore;
  private readonly storeKey: string;

  constructor(config: McpOAuthConfig, store: McpOAuthStore, storeKey: string) {
    this.config = config;
    this.store = store;
    this.storeKey = storeKey;
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

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.credentials()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.credentials()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens });
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

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.credentials()).discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "verifier") {
      this.verifier = undefined;
    }
    await this.update({
      ...(scope === "all" || scope === "client" ? { clientInformation: undefined } : {}),
      ...(scope === "all" || scope === "tokens" ? { tokens: undefined } : {}),
      ...(scope === "all" || scope === "discovery" ? { discoveryState: undefined } : {}),
    });
  }

  private async credentials(): Promise<McpOAuthCredentials> {
    return (await this.store.load(this.storeKey)) ?? {};
  }

  private async update(patch: McpOAuthCredentials): Promise<void> {
    const next: McpOAuthCredentials = { ...(await this.credentials()), ...patch };
    const isEmpty = Object.values(next).every((value) => value === undefined);
    await this.store.save(this.storeKey, isEmpty ? undefined : next);
  }
}
