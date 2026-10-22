import { randomBytes, randomUUID } from "node:crypto";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";

export const DEMO_SCOPE = "mcp:tools";
export const CONSENT_PATH = "/consent";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const PENDING_REQUEST_TTL_MS = 10 * 60_000;

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

type IssuedCode = PendingAuthorization;

interface IssuedToken {
  clientId: string;
  scopes: string[];
  resource?: URL;
  /** Milliseconds since epoch. */
  expiresAt: number;
}

interface IssuedRefreshToken {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}

/**
 * A minimal in-memory OAuth 2.1 authorization server for the demo. The SDK's
 * `mcpAuthRouter` handles metadata, dynamic client registration, PKCE checks,
 * and request validation; this class only stores clients, codes, and tokens,
 * and renders a consent page the user has to approve.
 *
 * Everything lives in memory, so restarting the demo invalidates every client
 * and token and the agent has to authorize again.
 */
export class DemoOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, IssuedRefreshToken>();
  private readonly accessTokenTtlSeconds: number;

  constructor(accessTokenTtlSeconds: number) {
    this.accessTokenTtlSeconds = accessTokenTtlSeconds;
  }

  /** Shows the consent page; the decision comes back via {@link handleConsent}. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const requestId = randomUUID();
    this.pending.set(requestId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_REQUEST_TTL_MS,
    });
    res
      .status(200)
      .type("html")
      .send(renderConsentPage(requestId, client, params));
  }

  /** `POST /consent`: approve → redirect with a code, deny → `access_denied`. */
  handleConsent(req: Request, res: Response): void {
    const requestId = String(req.body?.request_id ?? "");
    const request = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!request || request.expiresAt < Date.now()) {
      res.status(400).type("text").send("This authorization request is invalid or has expired.");
      return;
    }

    const redirect = new URL(request.params.redirectUri);
    if (request.params.state !== undefined) {
      redirect.searchParams.set("state", request.params.state);
    }

    if (req.body?.decision === "approve") {
      const code = randomToken();
      this.codes.set(code, { ...request, expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS });
      redirect.searchParams.set("code", code);
    } else {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The user denied the request.");
    }
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.getCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.getCode(client, authorizationCode);
    this.codes.delete(authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(
      client.client_id,
      code.params.scopes ?? [DEMO_SCOPE],
      code.params.resource,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const issued = this.refreshTokens.get(refreshToken);
    if (!issued || issued.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, scopes ?? issued.scopes, issued.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const issued = this.accessTokens.get(token);
    if (!issued || issued.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: issued.clientId,
      scopes: issued.scopes,
      expiresAt: Math.floor(issued.expiresAt / 1000),
      resource: issued.resource,
    };
  }

  private getCode(client: OAuthClientInformationFull, authorizationCode: string): IssuedCode {
    const code = this.codes.get(authorizationCode);
    if (!code || code.expiresAt < Date.now() || code.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return code;
  }

  private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
    });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function renderConsentPage(
  requestId: string,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): string {
  const clientName = escapeHtml(client.client_name ?? client.client_id);
  const scopes = escapeHtml((params.scopes ?? [DEMO_SCOPE]).join(" "));
  const redirectUri = escapeHtml(params.redirectUri);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize MCP access</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f6f8; --card: #fff; --ink: #1f2330; --muted: #6b7280; --border: #e2e5ec; --accent: #5a78f0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161c; --card: #1d2029; --ink: #e8eaf0; --muted: #9aa0ad; --border: #2e3240; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { width: min(420px, calc(100% - 32px)); background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: var(--muted); }
  dl { margin: 0 0 22px; display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; }
  form { display: flex; gap: 10px; }
  button { flex: 1; padding: 10px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
  button[value="approve"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Authorize MCP access</h1>
  <p><strong>${clientName}</strong> wants to use the tools of the ai-chat MCP demo server.</p>
  <dl>
    <dt>Scopes</dt><dd>${scopes}</dd>
    <dt>Redirect</dt><dd>${redirectUri}</dd>
  </dl>
  <form method="post" action="${CONSENT_PATH}">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="approve" autofocus>Approve</button>
  </form>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
