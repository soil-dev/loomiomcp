/**
 * OAuth 2.1 server provider for loomiomcp.
 *
 * Three client stores are exported:
 *
 *   - StatelessClientsStore — open DCR, but the registered client is
 *                             encoded into a SIGNED client_id (HMAC under
 *                             the "client" sub-key of the signing key)
 *                             rather than kept in memory. So any instance
 *                             recognises any client with zero shared
 *                             state, and a client survives restarts /
 *                             scale-to-zero / redeploys / multi-instance —
 *                             i.e. the connector doesn't make people
 *                             re-authenticate every time the process
 *                             recycles. This is the production open-DCR
 *                             store. Registration is capped and every
 *                             redirect_uri must pass ./redirect-policy.ts.
 *
 *   - InMemoryClientsStore  — open DCR, clients held in a per-process
 *                             Map. Simple, but every registration is
 *                             lost on restart and not shared across
 *                             instances. Fine for local/dev (single
 *                             process); not for a scaled deployment.
 *                             Same caps and redirect policy.
 *
 *   - FixedClientStore      — one hard-coded client; DCR disabled at
 *                             the SDK level. The shared client_secret
 *                             is the real auth boundary.
 *
 * In all cases /authorize is auto-approved — per-user identity isn't
 * part of the model; the underlying Loomio API key is shared for all
 * callers.
 *
 * Authorization codes are stateless too (v0.0.17, review §6): a signed blob
 * bound to the client, PKCE challenge, redirect_uri and resource, so the
 * /authorize leg (the user's browser) and the /token leg (the MCP client's
 * backend) may land on different instances. Single use is enforced per
 * instance by a used-nonce set; a replay that reaches ANOTHER instance
 * within the 5-minute TTL would succeed, but it needs the same client
 * credentials and PKCE verifier, so it only re-issues tokens to the party
 * that already holds them. Every failed exchange burns the code (nit 17).
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
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
  DEFAULT_REDIRECT_POLICY,
  type RedirectPolicy,
  redirectUrisProblem,
} from "./redirect-policy.js";
import {
  isV2Blob,
  issueToken,
  openBlob,
  openLegacyBlob,
  randomNonce,
  type SignedTokenClaims,
  SigningKeys,
  signBlob,
  TokenExpiredError,
  type VerifiedToken,
  verifyToken,
} from "./token.js";

const ACCESS_TOKEN_TTL_MS = 1 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Hard horizon on a refresh CHAIN (nit 1): refresh tokens are not rotated or
 * revocable one by one (stateless; rotating would need a shared reuse store),
 * so a stolen refresh token used to slide forever. Each refresh token now
 * carries `orig_iat` — when the user last completed /authorize — forward
 * unchanged, every new refresh token expires no later than orig_iat + 90 d,
 * and a refresh past that is refused: re-authorize at least quarterly. The
 * global kill switch is still rotating MCP_OAUTH_SIGNING_KEY (and, in static
 * mode, MCP_OAUTH_CLIENT_SECRET, which every refresh must present).
 */
const REFRESH_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Clock skew tolerated when checking that a token's expiry is one we could have issued. */
const ISSUE_SKEW_MS = 5 * 60 * 1000;

// Per-process used-code nonces (single use within an instance). Bounded so a
// flood of valid codes cannot grow it without limit; evicting a nonce early
// only re-opens the cross-instance-replay case documented above.
const USED_CODE_NONCES_MAX = 10_000;
const AUTH_CODE_GC_INTERVAL_MS = 60 * 1000;

// RFC 7636: an S256 challenge is base64url(SHA-256) = exactly 43 chars; a
// verifier is 43–128 unreserved chars. v0.0.16 stored any string (F-05: a
// 90 kB challenge pinned ~100 KB of heap per pending code).
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

// Open-DCR registration caps (F-13, nit 22): bound what a registrant can
// make the connector sign and later echo in logs and Location headers.
const MAX_CLIENT_NAME_CHARS = 256;
const MAX_SCOPE_CHARS = 256;
/** A v2 client_id longer than this is refused at /register and at lookup. */
const MAX_CLIENT_ID_BYTES = 2048;
/** Legacy (v0.0.16) client_ids could be this long; above it nothing could ever use them. */
const MAX_LEGACY_CLIENT_ID_BYTES = 16_384;

// One message for every way a code exchange can fail (nit 4): distinct texts
// told a holder of someone else's code whether it was live, theirs, or
// merely paired with the wrong verifier.
const INVALID_CODE = "invalid authorization code";
const INVALID_REFRESH = "invalid refresh token";

type RegistrationInput = Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">;

/**
 * Registration-time caps and redirect policy shared by both open-DCR stores.
 * Throws InvalidClientMetadataError (→ 400 invalid_client_metadata).
 */
function assertRegistrable(client: RegistrationInput, policy: RedirectPolicy): void {
  const problem = redirectUrisProblem(client.redirect_uris, policy);
  if (problem) throw new InvalidClientMetadataError(problem);
  if ((client.client_name?.length ?? 0) > MAX_CLIENT_NAME_CHARS) {
    throw new InvalidClientMetadataError(
      `client_name may be at most ${MAX_CLIENT_NAME_CHARS} chars`,
    );
  }
  if ((client.scope?.length ?? 0) > MAX_SCOPE_CHARS) {
    throw new InvalidClientMetadataError(`scope may be at most ${MAX_SCOPE_CHARS} chars`);
  }
}

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly redirectPolicy: RedirectPolicy = DEFAULT_REDIRECT_POLICY) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: RegistrationInput): OAuthClientInformationFull {
    assertRegistrable(client, this.redirectPolicy);
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

// Payload of a v2 signed client_id. Only the fields that vary per
// registration; the MAC guarantees integrity, `nonce` makes two identical
// registrations in the same second distinct (nit 2), `.strict()` refuses a
// blob that also carries some other artefact's claims.
const V2ClientClaimsSchema = z
  .object({
    type: z.literal("client"),
    redirect_uris: z.array(z.string()).min(1),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
    client_name: z.string().optional(),
    iat: z.number().int(),
    nonce: z.string().min(16),
  })
  .strict();

// Exactly what v0.0.7 – v0.0.16 signed (accepted until LEGACY_ACCEPT_UNTIL_MS).
const LegacyClientClaimsSchema = z
  .object({
    k: z.literal("client"),
    redirect_uris: z.array(z.string()).min(1),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
    client_name: z.string().optional(),
    iat: z.number().int(),
  })
  .strict();

type ClientClaims = Omit<z.infer<typeof V2ClientClaimsSchema>, "type" | "nonce">;

const DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"];
const DEFAULT_RESPONSE_TYPES = ["code"];
const DEFAULT_AUTH_METHOD = "client_secret_post";

/**
 * Open-DCR store with NO server-side state. `registerClient` mints a
 * `client_id` that is itself a signed blob (HMAC over the registration
 * metadata); `getClient` verifies that signature and reconstructs the
 * client instead of looking it up. The `client_secret` is derived
 * deterministically from the `client_id`, so every instance recomputes the
 * same one.
 *
 * Consequence: a client registered against one instance is honoured by
 * any other instance, and by the same instance after a restart — refresh
 * and re-authorize keep working without the caller having to
 * re-register. Revocation is global only (rotate `MCP_OAUTH_SIGNING_KEY`,
 * which also invalidates all outstanding tokens) — acceptable here
 * because every caller already shares one upstream Loomio identity.
 */
export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  private readonly keys: SigningKeys;
  private readonly redirectPolicy: RedirectPolicy;

  constructor(signingKey: string, redirectPolicy: RedirectPolicy = DEFAULT_REDIRECT_POLICY) {
    this.keys = new SigningKeys(signingKey);
    this.redirectPolicy = redirectPolicy;
  }

  // Deterministic per-client secret for confidential clients: any instance
  // recomputes the same value, so client_secret_post auth works without
  // storing the secret. A legacy client keeps its v0.0.16 secret (raw-key
  // HMAC) — Claude.ai stored it at registration and has no way to learn a
  // new one; a v2 client's secret comes from its own HKDF sub-key.
  private deriveSecret(clientId: string, legacy: boolean): string {
    return legacy
      ? createHmacB64(this.keys.legacy, `client_secret:${clientId}`)
      : createHmacB64(this.keys.key("client-secret"), clientId);
  }

  private reconstruct(clientId: string, c: ClientClaims, legacy: boolean) {
    const authMethod = c.token_endpoint_auth_method ?? DEFAULT_AUTH_METHOD;
    const isPublicClient = authMethod === "none";
    return {
      client_id: clientId,
      client_id_issued_at: c.iat,
      redirect_uris: c.redirect_uris,
      grant_types: c.grant_types ?? DEFAULT_GRANT_TYPES,
      response_types: c.response_types ?? DEFAULT_RESPONSE_TYPES,
      token_endpoint_auth_method: authMethod,
      ...(isPublicClient
        ? {}
        : {
            client_secret: this.deriveSecret(clientId, legacy),
            client_secret_expires_at: 0, // never expires — there's nothing to rotate per-client
          }),
      ...(c.scope ? { scope: c.scope } : {}),
      ...(c.client_name ? { client_name: c.client_name } : {}),
    } satisfies OAuthClientInformationFull;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const bytes = Buffer.byteLength(clientId, "utf8");
    let claims: ClientClaims;
    let legacy: boolean;
    try {
      if (isV2Blob(clientId)) {
        if (bytes > MAX_CLIENT_ID_BYTES) return undefined;
        const parsed = V2ClientClaimsSchema.safeParse(openBlob(this.keys, "client", clientId));
        if (!parsed.success) return undefined;
        claims = parsed.data;
        legacy = false;
      } else {
        if (bytes > MAX_LEGACY_CLIENT_ID_BYTES) return undefined;
        const parsed = LegacyClientClaimsSchema.safeParse(openLegacyBlob(this.keys, clientId));
        if (!parsed.success) return undefined;
        claims = parsed.data;
        legacy = true;
      }
    } catch {
      return undefined; // bad signature / malformed / legacy after sunset → unknown client
    }
    // F-09 at USE time, not only at registration: a blob signed before the
    // policy existed (or under a wider MCP_OAUTH_REDIRECT_HOSTS) stops
    // resolving instead of redirecting wherever it was registered to.
    if (redirectUrisProblem(claims.redirect_uris, this.redirectPolicy)) return undefined;
    return this.reconstruct(clientId, claims, legacy);
  }

  registerClient(client: RegistrationInput): OAuthClientInformationFull {
    assertRegistrable(client, this.redirectPolicy);
    const iat = Math.floor(Date.now() / 1000);
    const claims: ClientClaims = {
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types ?? DEFAULT_GRANT_TYPES,
      response_types: client.response_types ?? DEFAULT_RESPONSE_TYPES,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? DEFAULT_AUTH_METHOD,
      ...(client.scope ? { scope: client.scope } : {}),
      ...(client.client_name ? { client_name: client.client_name } : {}),
      iat,
    };
    const clientId = signBlob(this.keys, "client", {
      type: "client",
      ...claims,
      nonce: randomNonce(),
    });
    // The total cap catches what the per-field caps let through (long
    // grant_types arrays, ten 512-char URIs): v0.0.16 answered 201 with ids
    // up to the 100 kB body limit that /authorize and /token then refused.
    if (Buffer.byteLength(clientId, "utf8") > MAX_CLIENT_ID_BYTES) {
      throw new InvalidClientMetadataError(
        `client metadata too large (signed client_id over ${MAX_CLIENT_ID_BYTES} bytes)`,
      );
    }
    return { ...client, ...this.reconstruct(clientId, claims, false) };
  }
}

function createHmacB64(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
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

// Claims of a signed authorization code. `cid` is SHA-256(client_id), not
// the id itself: a legacy client_id can be 16 kB and the code travels in a
// Location header and a form body. `redirectUriSent` records whether the
// authorization request itself carried redirect_uri (the SDK fills in the
// sole registered URI when it did not); RFC 6749 §4.1.3 then makes it
// REQUIRED, and identical, at /token.
const CodeClaimsSchema = z
  .object({
    type: z.literal("code"),
    cid: z.string().length(43),
    codeChallenge: z.string().regex(S256_CHALLENGE),
    redirectUri: z.string().min(1),
    redirectUriSent: z.boolean(),
    resource: z.string().optional(),
    scopes: z.array(z.string()),
    expiresAt: z.number().int(),
    nonce: z.string().min(16),
  })
  .strict();

type CodeClaims = z.infer<typeof CodeClaimsSchema>;

function clientDigest(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("base64url");
}

/** Whether the /authorize request (GET query or POST form) itself carried redirect_uri. */
function authorizationRequestCarriedRedirectUri(res: Response): boolean {
  const req = (res as Response & { req?: Request }).req;
  // No request to inspect (a unit test's fake response): assume it did,
  // which is the strict reading — /token must then present it.
  if (!req) return true;
  const source = (req.method === "POST" ? req.body : req.query) as
    | Record<string, unknown>
    | undefined;
  return typeof source?.["redirect_uri"] === "string";
}

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly keys: SigningKeys;
  /** nonce → the code's expiresAt; entries past it are useless (the code is expired) and GC'd. */
  private readonly usedCodeNonces = new Map<string, number>();
  private readonly resourceUrl: URL | undefined;
  private readonly gcTimer: NodeJS.Timeout | undefined;

  readonly skipLocalPkceValidation = true;

  constructor(args: {
    clientsStore: OAuthRegisteredClientsStore;
    signingKey: string;
    resourceUrl?: URL | string;
    enableAuthCodeGc?: boolean;
  }) {
    this.keys = new SigningKeys(args.signingKey);
    this.clientsStore = args.clientsStore;
    this.resourceUrl = args.resourceUrl ? resourceUrlFromServerUrl(args.resourceUrl) : undefined;
    if (args.enableAuthCodeGc ?? true) {
      this.gcTimer = setInterval(() => this.gcUsedCodeNonces(), AUTH_CODE_GC_INTERVAL_MS);
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
    // Thrown errors here are phase-2 errors: the SDK redirects them to the
    // (already policy-checked) redirect_uri as ?error=invalid_request.
    if (!S256_CHALLENGE.test(params.codeChallenge)) {
      throw new InvalidRequestError(
        "code_challenge must be an S256 challenge (43 base64url characters)",
      );
    }
    const scopes = params.scopes ?? [];
    if (scopes.join(" ").length > MAX_SCOPE_CHARS) {
      throw new InvalidRequestError(`scope may be at most ${MAX_SCOPE_CHARS} chars`);
    }
    const resource = this.resolveResource(params.resource);
    const claims: CodeClaims = {
      type: "code",
      cid: clientDigest(client.client_id),
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      redirectUriSent: authorizationRequestCarriedRedirectUri(res),
      ...(resource ? { resource } : {}),
      scopes,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      nonce: randomNonce(),
    };
    const code = signBlob(this.keys, "code", claims);

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    res.redirect(url.toString());
  }

  /** Verify a code's MAC, shape and expiry (no single-use check, no burn). */
  private openCode(code: string): CodeClaims | undefined {
    try {
      const parsed = CodeClaimsSchema.safeParse(openBlob(this.keys, "code", code));
      if (!parsed.success) return undefined;
      const now = Date.now();
      // authorize() never mints an expiry beyond the 5-minute TTL; a later
      // one came from a key holder by hand, and would also pin its nonce in
      // usedCodeNonces (GC'd by expiry) for as long as it claims to live.
      const { expiresAt } = parsed.data;
      if (expiresAt < now || expiresAt > now + AUTH_CODE_TTL_MS + ISSUE_SKEW_MS) return undefined;
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  /**
   * Burn a code without exchanging it — the /token client-authentication
   * pre-check calls this when the presenting client fails authentication,
   * so a code is dead after ANY failed attempt (nit 17), not only a failed
   * PKCE check. A forged or expired code has nothing worth burning.
   */
  burnAuthorizationCode(code: string): void {
    const claims = this.openCode(code);
    if (claims) this.markCodeUsed(claims);
  }

  private markCodeUsed(claims: CodeClaims): void {
    this.usedCodeNonces.set(claims.nonce, claims.expiresAt);
    if (this.usedCodeNonces.size > USED_CODE_NONCES_MAX) {
      this.gcUsedCodeNonces();
      while (this.usedCodeNonces.size > USED_CODE_NONCES_MAX) {
        const oldest = this.usedCodeNonces.keys().next().value;
        if (oldest === undefined) break;
        this.usedCodeNonces.delete(oldest);
      }
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    // Unused while skipLocalPkceValidation is true (the SDK hands the
    // verifier to exchangeAuthorizationCode instead); kept correct anyway.
    const claims = this.openCode(authorizationCode);
    if (
      !claims ||
      this.usedCodeNonces.has(claims.nonce) ||
      claims.cid !== clientDigest(client.client_id)
    ) {
      throw new InvalidGrantError(INVALID_CODE);
    }
    return claims.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const opened = this.openCode(authorizationCode);
    const claims = opened && !this.usedCodeNonces.has(opened.nonce) ? opened : undefined;
    // Burn BEFORE any other check: from here on every outcome, success or
    // any failure, leaves the code unusable on this instance.
    if (claims) this.markCodeUsed(claims);
    // The resource check runs whether or not the code is live, so its
    // invalid_target says nothing about the code (nit 4).
    const requestedResource = this.resolveResource(resource);
    if (!claims) throw new InvalidGrantError(INVALID_CODE);

    const redirectOk = claims.redirectUriSent
      ? redirectUri === claims.redirectUri
      : redirectUri === undefined || redirectUri === claims.redirectUri;
    const verifierOk =
      typeof codeVerifier === "string" &&
      PKCE_VERIFIER.test(codeVerifier) &&
      safeEqual(
        createHash("sha256").update(codeVerifier).digest("base64url"),
        claims.codeChallenge,
      );
    if (claims.cid !== clientDigest(client.client_id) || !redirectOk || !verifierOk) {
      throw new InvalidGrantError(INVALID_CODE);
    }
    if (requestedResource && claims.resource && requestedResource !== claims.resource) {
      throw new InvalidGrantError(INVALID_CODE);
    }
    const now = Date.now();
    return this.issueTokenPair(client.client_id, requestedResource ?? claims.resource, now, now);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const now = Date.now();
    let verified: VerifiedToken;
    try {
      verified = verifyToken(refreshToken, this.keys, "refresh", now);
    } catch {
      throw new InvalidGrantError(INVALID_REFRESH);
    }
    const { claims } = verified;
    if (
      claims.expiresAt > now + REFRESH_TOKEN_TTL_MS + ISSUE_SKEW_MS ||
      claims.clientId !== client.client_id
    ) {
      throw new InvalidGrantError(INVALID_REFRESH);
    }
    this.assertClaimsResource(claims, InvalidGrantError, INVALID_REFRESH);
    // A legacy (v0.0.16) refresh token has no orig_iat: it is honoured until
    // its own expiry, and its issue time (expiresAt − 30 d) — the earliest
    // instant we can vouch for — starts the 90-day horizon of the chain.
    const origIat =
      "orig_iat" in claims && claims.orig_iat !== undefined
        ? claims.orig_iat
        : Math.min(now, claims.expiresAt - REFRESH_TOKEN_TTL_MS);
    if (now - origIat > REFRESH_HORIZON_MS) {
      throw new InvalidGrantError("refresh token too old; authorize again");
    }
    const requestedResource = this.resolveResource(resource);
    if (requestedResource && claims.resource && requestedResource !== claims.resource) {
      throw new InvalidGrantError(INVALID_REFRESH);
    }
    return this.issueTokenPair(
      client.client_id,
      requestedResource ?? claims.resource,
      now,
      origIat,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = Date.now();
    let verified: VerifiedToken;
    try {
      verified = verifyToken(token, this.keys, "access", now);
    } catch (err) {
      throw new InvalidTokenError(
        err instanceof TokenExpiredError ? "token expired" : "invalid token",
      );
    }
    const { claims } = verified;
    // An expiry further out than any token this server issues means a key
    // holder minted it by hand — refuse rather than honour it for years.
    if (claims.expiresAt > now + ACCESS_TOKEN_TTL_MS + ISSUE_SKEW_MS) {
      throw new InvalidTokenError("invalid token");
    }
    this.assertClaimsResource(claims, InvalidTokenError);
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: Math.floor(claims.expiresAt / 1000),
    };
  }

  private issueTokenPair(
    clientId: string,
    resource: string | undefined,
    now: number,
    origIat: number,
  ): OAuthTokens {
    const base = { clientId, ...(resource ? { resource } : {}), scopes: [], iat: now };
    const access: SignedTokenClaims = {
      type: "access",
      ...base,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      nonce: randomNonce(),
    };
    const refresh: SignedTokenClaims = {
      type: "refresh",
      ...base,
      orig_iat: origIat,
      expiresAt: Math.min(now + REFRESH_TOKEN_TTL_MS, origIat + REFRESH_HORIZON_MS),
      nonce: randomNonce(),
    };
    return {
      access_token: issueToken(access, this.keys),
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: issueToken(refresh, this.keys),
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
    claims: VerifiedToken["claims"],
    ErrorClass: typeof InvalidGrantError | typeof InvalidTokenError,
    message?: string,
  ): void {
    if (!this.resourceUrl) return;
    if (!claims.resource) {
      throw new ErrorClass(message ?? "token is missing MCP resource audience");
    }
    if (
      !checkResourceAllowed({
        requestedResource: claims.resource,
        configuredResource: this.resourceUrl,
      })
    ) {
      throw new ErrorClass(message ?? "token was issued for a different MCP resource");
    }
  }

  private gcUsedCodeNonces(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.usedCodeNonces.entries()) {
      if (expiresAt < now) this.usedCodeNonces.delete(nonce);
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
