/**
 * Express app factory for the HTTP transport. Pure — takes a fully
 * constructed OAuth provider and config, returns an `express.Express`
 * instance. Doesn't call `app.listen()` itself; the caller decides
 * when to start serving (or not, in tests).
 */

import express from "express";
import type { OAuthProvider } from "../auth/provider.js";
import { ICON_SVG } from "../icon.js";
import { mountOAuthRoutes } from "./oauth-routes.js";
import { mountTransport } from "./transport.js";

export interface AppOptions {
  oauthProvider: OAuthProvider;
  issuerUrl: URL;
  jsonLimit: string;
  allowedOrigins: string[];
  resourceName?: string;
  trustProxy?: boolean | number | string;
}

export function createApp(opts: AppOptions): express.Express {
  const { oauthProvider, issuerUrl, jsonLimit, allowedOrigins } = opts;
  const resourceName = opts.resourceName ?? "Loomio MCP";
  const trustProxy = opts.trustProxy ?? 1;

  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  const app = express();
  app.set("trust proxy", trustProxy);

  mountOAuthRoutes(app, {
    oauthProvider,
    issuerUrl,
    resourceName,
    mcpResourceUrl,
  });

  const iconHandler = (_req: express.Request, res: express.Response): void => {
    res
      .set("Content-Type", "image/svg+xml")
      .set("Cache-Control", "public, max-age=86400")
      .send(ICON_SVG);
  };
  app.get("/icon.svg", iconHandler);
  app.get("/favicon.ico", iconHandler);

  mountTransport(app, {
    oauthProvider,
    mcpResourceUrl,
    jsonLimit,
    allowedOrigins,
  });

  return app;
}
