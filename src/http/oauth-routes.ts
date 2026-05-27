/**
 * OAuth-related Express routes: constant-time client_secret pre-check
 * on /token, plus the SDK's mcpAuthRouter mount.
 *
 * Split from `app.ts` so the OAuth surface is reviewable as one unit;
 * `transport.ts` owns the /mcp surface.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthProvider } from "../auth/provider.js";

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

/**
 * Mount /token pre-check and the SDK's auth router onto `app`. The
 * /token pre-check authenticates the client first using a constant-
 * time secret compare; the SDK's downstream client auth runs only on
 * a known-valid secret, closing the timing channel for invalid-
 * secret attackers.
 */
export function mountOAuthRoutes(app: express.Express, opts: OAuthRoutesOptions): void {
  const { oauthProvider, issuerUrl, resourceName, mcpResourceUrl } = opts;

  app.post("/token", express.urlencoded({ extended: false }), async (req, res, next) => {
    const sendInvalidClient = (description: string): void => {
      res.status(401).json({
        error: "invalid_client",
        error_description: description,
      });
    };

    const body = (req.body ?? {}) as Record<string, unknown>;
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
    const secretsMatch = timingSafeSecretEqual(providedSecret ?? "", expectedSecret);
    if (!expected) {
      sendInvalidClient("client authentication failed");
      return;
    }

    if (!expectedSecret) {
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

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: [],
      resourceName,
      resourceServerUrl: mcpResourceUrl,
    }),
  );
}
