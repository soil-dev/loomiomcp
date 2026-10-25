/**
 * OAuth-related Express routes: the /token guard chain plus the SDK's
 * mcpAuthRouter mount.
 *
 * Split from `app.ts` so the OAuth surface is reviewable as one unit;
 * `transport.ts` owns the /mcp surface.
 *
 * /register and /authorize get a per-source-IP limiter (the SDK's own
 * 20 / h and 100 / 15 min) mounted BEFORE the SDK router, so a request
 * whose body the SDK's parser rejects is still counted (review F-06).
 *
 * What runs for anything under /token, in order (review F-11):
 *
 *   1. a per-source-IP limiter (50 / 15 min, `createIpRateLimit` keying;
 *      CORS preflights exempt) — ahead of client authentication, so failed
 *      authentications count. v0.0.16's pre-check answered 401 itself,
 *      before the SDK's limiter, so secret guessing on the exact path was
 *      never throttled;
 *   2. 404 for every sub-path. The SDK mounts its token router with
 *      `router.use("/token")` (a PREFIX), while the pre-check was
 *      `app.post("/token")` (exact): `POST /token/x` skipped the pre-check
 *      and reached the SDK's `authenticateClient` (`!==` compare, distinct
 *      messages for unknown id / missing / wrong secret). Sub-paths never
 *      issue tokens, so they now never reach anything;
 *   3. the constant-time client-authentication pre-check below. It also
 *      arranges that an authorization code presented in a request that
 *      does not end in a 200 is burnt, whichever step refused it (nit 17);
 *   4. the SDK token handler, its own limiter switched off (step 1 is the
 *      same budget, keyed better; see the mount below).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthProvider } from "../auth/provider.js";
import { createIpRateLimit } from "./rate-limit.js";

/** /token budget per source IP: the SDK's own default, now applied before client auth. */
export const TOKEN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const TOKEN_RATE_LIMIT_MAX = 50;
/** /register and /authorize budgets per source IP: the SDK's own defaults (register.js, authorize.js). */
export const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const REGISTER_RATE_LIMIT_MAX = 20;
export const AUTHORIZE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AUTHORIZE_RATE_LIMIT_MAX = 100;

/**
 * A per-IP limiter for an OAuth route, mounted AHEAD of the SDK's router
 * (security review F-06). The SDK parses the body (`express.json()` on
 * /register, `urlencoded` on /authorize and /token) BEFORE its own
 * limiter, and a parse error skips every later middleware — so malformed
 * bodies were never counted and could be sent without bound (each one a
 * stderr dump in v0.0.16). Same figures as the SDK's own limiters, which
 * are switched off at the mount below: one budget per route, one keying
 * rule. CORS preflights carry no body and are not charged, so a browser
 * client's OPTIONS + POST costs one unit, not two.
 */
function oauthRouteLimit(windowMs: number, limit: number, what: string): express.RequestHandler {
  const limiter = createIpRateLimit({
    windowMs,
    limit,
    // MCP_HTTP_RATE_LIMIT_DISABLED never reached these routes in v0.0.16
    // (the SDK's limiters ignored it) and still does not (round 1).
    ignoreKillSwitch: true,
    handler: (_req, res) => {
      res.status(429).json({
        error: "too_many_requests",
        error_description: `too many ${what} requests from this address; retry later`,
      });
    },
  });
  return (req, res, next) => (req.method === "OPTIONS" ? next() : limiter(req, res, next));
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function timingSafeSecretEqual(provided: string, expected: string): boolean {
  return timingSafeEqual(secretDigest(provided), secretDigest(expected));
}

export interface OAuthRoutesOptions {
  oauthProvider: OAuthProvider;
  issuerUrl: URL;
  resourceName: string;
  mcpResourceUrl: URL;
}

/** Mount the /token guard chain (see the module comment) and the SDK's auth router onto `app`. */
export function mountOAuthRoutes(app: express.Express, opts: OAuthRoutesOptions): void {
  const { oauthProvider, issuerUrl, resourceName, mcpResourceUrl } = opts;

  app.use(
    "/register",
    oauthRouteLimit(REGISTER_RATE_LIMIT_WINDOW_MS, REGISTER_RATE_LIMIT_MAX, "registration"),
  );
  app.use(
    "/authorize",
    oauthRouteLimit(AUTHORIZE_RATE_LIMIT_WINDOW_MS, AUTHORIZE_RATE_LIMIT_MAX, "authorization"),
  );

  app.use("/token", oauthRouteLimit(TOKEN_RATE_LIMIT_WINDOW_MS, TOKEN_RATE_LIMIT_MAX, "token"));

  // `app.use("/token")` matches with the same prefix semantics as the SDK's
  // router (case-insensitive, any sub-path) and strips the mount: `req.path`
  // is "/" for /token, /token/ and /token?…, anything longer is a sub-path.
  app.use("/token", (req, res, next) => {
    if (req.path === "/") {
      next();
      return;
    }
    res.status(404).json({ error: "not_found" });
  });

  app.post("/token", express.urlencoded({ extended: false }), async (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // nit 17, at the HTTP level: a code presented in ANY /token request
    // that reaches this point and does not end in a delivered 200 is dead
    // afterwards — whoever answers (this pre-check's 401, the SDK's 400 for
    // a missing code_verifier or a malformed resource, its 429, a 500) and
    // also when the caller hangs up first. The provider burns on its own
    // failures too; this covers the ones decided before it is reached, so a
    // code never survives a failed attempt to be retried with other inputs.
    // (The per-IP limiter's 429 above comes before the body is read and
    // burns nothing.) 'close' fires once the response is flushed or the
    // socket drops, so by the time a client reads the error the code is dead.
    const presentedCode =
      body["grant_type"] === "authorization_code" && typeof body["code"] === "string"
        ? body["code"]
        : undefined;
    if (presentedCode !== undefined) {
      res.once("close", () => {
        if (!(res.writableFinished && res.statusCode === 200)) {
          oauthProvider.burnAuthorizationCode(presentedCode);
        }
      });
    }
    const sendInvalidClient = (description: string): void => {
      res.status(401).json({
        error: "invalid_client",
        error_description: description,
      });
    };

    const clientId =
      typeof body["client_id"] === "string" ? (body["client_id"] as string) : undefined;
    const providedSecret =
      typeof body["client_secret"] === "string" ? (body["client_secret"] as string) : undefined;

    if (!clientId) {
      sendInvalidClient("client credentials required");
      return;
    }

    let expected: Awaited<ReturnType<typeof oauthProvider.clientsStore.getClient>>;
    try {
      expected = await oauthProvider.clientsStore.getClient(clientId);
    } catch {
      res.status(500).json({
        error: "server_error",
        error_description: "client lookup failed",
      });
      return;
    }

    const expectedSecret =
      expected && typeof expected.client_secret === "string" && expected.client_secret
        ? expected.client_secret
        : "";
    // Compare even for an unknown client so its timing matches a known one.
    const secretsMatch = timingSafeSecretEqual(providedSecret ?? "", expectedSecret);
    if (!expected) {
      sendInvalidClient("client authentication failed");
      return;
    }

    if (!expectedSecret) {
      // Public client (token_endpoint_auth_method "none"): PKCE is its proof.
      next();
      return;
    }

    const expiresAt = expected.client_secret_expires_at;
    const secretExpired =
      typeof expiresAt === "number" && expiresAt !== 0 && expiresAt < Math.floor(Date.now() / 1000);
    if (providedSecret === undefined || !secretsMatch || secretExpired) {
      sendInvalidClient("client authentication failed");
      return;
    }
    next();
  });

  // The SDK's own per-route limiters are switched off: the ones above
  // already apply the same figures to the same prefixes, BEFORE the body is
  // parsed, keyed by `clientIpKey`. The SDK's key on `req.ip` verbatim, so
  // behind a trusted proxy a junk X-Forwarded-For value became a fresh
  // MemoryStore bucket per value (security review F-12) and the first one
  // was echoed into stderr by express-rate-limit's IP validation.
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: [],
      resourceName,
      resourceServerUrl: mcpResourceUrl,
      authorizationOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
    }),
  );
}
