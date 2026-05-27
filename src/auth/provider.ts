/**
 * OAuth 2.1 server provider for loomiomcp.
 *
 * Two stores are exported:
 *
 *   - InMemoryClientsStore  — open DCR; auto-approve mode. Anyone who
 *                             can reach the URL can register and get
 *                             in. Suitable for local development or
 *                             private-network deployments only.
 *
 *   - FixedClientStore      — one hard-coded client; DCR disabled at
 *                             the SDK level. The shared client_secret
 *                             is the real auth boundary. Recommended
 *                             for any public deployment.
 *
 * In both cases /authorize is auto-approved — per-user identity isn't
 * part of the model; the underlying Loomio API key is shared for all
 * callers.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  issueToken,
  verifyToken,
  TokenExpiredError,
  TokenSignatureError,
  type SignedTokenClaims,
} from "./token.js";

const ACCESS_TOKEN_TTL_MS = 1 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

const AUTH_CODE_MAX_ENTRIES = 10_000;
const AUTH_CODE_GC_INTERVAL_MS = 60 * 1000;

interface AuthCodeState {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(clientId, full);
    return full;
  }
}

export class FixedClientStore implements OAuthRegisteredClientsStore {
  private readonly client: OAuthClientInformationFull;

  constructor(args: {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    clientName?: string;
  }) {
    if (!args.clientId || args.clientId.length < 1) {
      throw new Error("FixedClientStore: clientId is required");
    }
    if (!args.clientSecret || args.clientSecret.length < 16) {
      throw new Error("FixedClientStore: clientSecret must be at least 16 chars");
    }
    if (!args.redirectUris.length) {
      throw new Error("FixedClientStore: at least one redirectUri is required");
    }
    this.client = {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: args.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      ...(args.clientName ? { client_name: args.clientName } : {}),
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId !== this.client.client_id) return undefined;
    return this.client;
  }
}

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly authCodes = new Map<string, AuthCodeState>();
  private readonly signingKey: string;
  private readonly resourceUrl: URL | undefined;
  private readonly gcTimer: NodeJS.Timeout | undefined;

  readonly skipLocalPkceValidation = true;

  constructor(args: {
    clientsStore: OAuthRegisteredClientsStore;
    signingKey: string;
    resourceUrl?: URL | string;
    enableAuthCodeGc?: boolean;
  }) {
    if (!args.signingKey || args.signingKey.length < 16) {
      throw new Error("OAuthProvider: signing key must be at least 16 chars long");
    }
    this.clientsStore = args.clientsStore;
    this.signingKey = args.signingKey;
    this.resourceUrl = args.resourceUrl ? resourceUrlFromServerUrl(args.resourceUrl) : undefined;
    if (args.enableAuthCodeGc ?? true) {
      this.gcTimer = setInterval(() => this.gcAuthCodes(), AUTH_CODE_GC_INTERVAL_MS);
      this.gcTimer.unref();
    }
  }

  shutdown(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const resource = this.resolveResource(params.resource);
    const code = randomBytes(32).toString("hex");
    this.authCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    this.gcAuthCodes();
    while (this.authCodes.size > AUTH_CODE_MAX_ENTRIES) {
      const oldest = this.authCodes.keys().next().value;
      if (oldest === undefined) break;
      this.authCodes.delete(oldest);
    }

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const state = this.authCodes.get(authorizationCode);
    if (!state || state.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return state.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const state = this.authCodes.get(authorizationCode);
    if (!state || state.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    if (state.clientId !== client.client_id) {
      throw new InvalidGrantError("authorization code was issued to a different client");
    }
    if (redirectUri && redirectUri !== state.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    if (!codeVerifier) {
      throw new InvalidGrantError("code_verifier required");
    }
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    const expectedBuf = Buffer.from(expected, "utf8");
    const storedBuf = Buffer.from(state.codeChallenge, "utf8");
    if (expectedBuf.length !== storedBuf.length || !timingSafeEqual(expectedBuf, storedBuf)) {
      throw new InvalidGrantError("code_verifier does not match the challenge");
    }
    const requestedResource = this.resolveResource(resource);
    if (requestedResource && state.resource && requestedResource !== state.resource) {
      throw new InvalidGrantError("resource mismatch");
    }
    this.authCodes.delete(authorizationCode);
    return this.issueTokenPair(client.client_id, requestedResource ?? state.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    let claims: SignedTokenClaims;
    try {
      claims = verifyToken(refreshToken, this.signingKey);
    } catch (err) {
      if (err instanceof TokenSignatureError || err instanceof TokenExpiredError) {
        throw new InvalidGrantError("invalid refresh token");
      }
      throw err;
    }
    if (claims.type !== "refresh") {
      throw new InvalidGrantError("not a refresh token");
    }
    if (claims.clientId !== client.client_id) {
      throw new InvalidGrantError("refresh token was issued to a different client");
    }
    this.assertClaimsResource(claims, InvalidGrantError);
    const requestedResource = this.resolveResource(resource);
    if (requestedResource && claims.resource && requestedResource !== claims.resource) {
      throw new InvalidGrantError("refresh token resource mismatch");
    }
    return this.issueTokenPair(client.client_id, requestedResource ?? claims.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: SignedTokenClaims;
    try {
      claims = verifyToken(token, this.signingKey);
    } catch (err) {
      if (err instanceof TokenSignatureError) {
        throw new InvalidTokenError("invalid token");
      }
      if (err instanceof TokenExpiredError) {
        throw new InvalidTokenError("token expired");
      }
      throw err;
    }
    if (claims.type !== "access") {
      throw new InvalidTokenError("not an access token");
    }
    this.assertClaimsResource(claims, InvalidTokenError);
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: Math.floor(claims.expiresAt / 1000),
    };
  }

  private issueTokenPair(clientId: string, resource?: string): OAuthTokens {
    const now = Date.now();
    const access = issueToken(
      {
        type: "access",
        clientId,
        ...(resource ? { resource } : {}),
        scopes: [],
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
        nonce: randomBytes(8).toString("hex"),
      },
      this.signingKey,
    );
    const refresh = issueToken(
      {
        type: "refresh",
        clientId,
        ...(resource ? { resource } : {}),
        scopes: [],
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        nonce: randomBytes(8).toString("hex"),
      },
      this.signingKey,
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
    };
  }

  private resolveResource(requestedResource?: URL): string | undefined {
    if (!this.resourceUrl) {
      return requestedResource ? resourceUrlFromServerUrl(requestedResource).href : undefined;
    }
    if (!requestedResource) return this.resourceUrl.href;
    if (
      !checkResourceAllowed({
        requestedResource,
        configuredResource: this.resourceUrl,
      })
    ) {
      throw new InvalidTargetError(
        `requested resource is not this MCP server: ${requestedResource.href}`,
      );
    }
    return this.resourceUrl.href;
  }

  private assertClaimsResource(
    claims: SignedTokenClaims,
    ErrorClass: typeof InvalidGrantError | typeof InvalidTokenError,
  ): void {
    if (!this.resourceUrl) return;
    if (!claims.resource) {
      throw new ErrorClass("token is missing MCP resource audience");
    }
    if (
      !checkResourceAllowed({
        requestedResource: claims.resource,
        configuredResource: this.resourceUrl,
      })
    ) {
      throw new ErrorClass("token was issued for a different MCP resource");
    }
  }

  private gcAuthCodes(): void {
    const now = Date.now();
    for (const [code, state] of this.authCodes.entries()) {
      if (state.expiresAt < now) this.authCodes.delete(code);
    }
  }
}
