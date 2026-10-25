/**
 * Express app factory for the HTTP transport. Pure — takes a fully
 * constructed OAuth provider and config, returns an `express.Express`
 * instance. Doesn't call `app.listen()` itself; the caller decides
 * when to start serving (or not, in tests).
 *
 * Besides wiring the three surfaces (OAuth routes, /health, /mcp) it owns
 * the app-wide HTTP hygiene of security review F-06 and nit 6 / nit 7:
 *
 *   - a small header set on every response (no `X-Powered-By`; nosniff;
 *     `Referrer-Policy: no-referrer` so an /authorize redirect never
 *     leaks a code-bearing URL onward; HSTS when the issuer is https);
 *   - JSON 404 for every unknown route instead of Express's HTML page;
 *   - a TERMINAL error handler, so no error ever reaches Express's
 *     finalhandler. That one `console.error`s the whole Error — and
 *     body-parser attaches the raw request body to its parse errors — so
 *     in v0.0.16 any anonymous `POST /register` with a malformed body
 *     wrote attacker text (plus absolute node_modules paths) into the
 *     operator's logs, unthrottled. Now a 4xx is answered with a fixed
 *     code and logged nowhere; a 5xx logs its class and status only.
 */

import { createServer, type Server } from "node:http";
import express from "express";
import type { OAuthProvider } from "../auth/provider.js";
import { ICON_SVG } from "../icon.js";
import { mountHealth } from "./health.js";
import { mountOAuthRoutes } from "./oauth-routes.js";
import { mountTransport } from "./transport.js";
import { DEFAULT_JSON_LIMIT, parseByteSize } from "./config.js";
import type { SharedEgress } from "./shared-egress.js";

export interface AppOptions {
  oauthProvider: OAuthProvider;
  issuerUrl: URL;
  /** Body cap for POST /mcp: bytes, or a size string ("256kb"). Default 256 KB. */
  jsonLimit?: number | string;
  allowedOrigins: string[];
  resourceName?: string;
  /** Express `trust proxy` hop count. Default 0 (security review F-12; src/http/config.ts). */
  trustProxy?: number;
  /** MCP_SHARED_EGRESS_CIDRS: addresses whose callers are keyed per client too (src/http/shared-egress.ts). */
  sharedEgress?: SharedEgress;
}

/** HSTS lifetime: one year, this host only (the connector does not speak for sibling subdomains). */
const HSTS_VALUE = "max-age=31536000";

/** The fixed codes a client error is answered with — never the parser's own message. */
function clientErrorCode(status: number): string {
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  return "bad_request";
}

/** An error's HTTP status (body-parser / http-errors style), or 500. */
function errorStatus(err: unknown): number {
  if (err && typeof err === "object") {
    const raw =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw <= 599) return raw;
  }
  return 500;
}

/** The error's class name when it looks like one; never free text. */
function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}

/**
 * The terminal error middleware (see the module comment). Exported for
 * tests; `createApp` mounts it last.
 */
export const terminalErrorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
  const status = errorStatus(err);
  if (status >= 500) console.error(`[loomiomcp] http error: ${errorName(err)} ${status}`);
  if (res.headersSent) {
    // A response already under way cannot be turned into an error page;
    // cut the connection, as Express's own handler would, without its log.
    req.socket?.destroy();
    return;
  }
  if (status < 500) {
    res.status(status).json({ error: clientErrorCode(status) });
    return;
  }
  res.status(status).json({ error: "internal_error" });
};

/**
 * Server timeouts (security review F-14). Node's defaults — 300 s to
 * receive a whole request, 60 s for its headers — let a caller hold a
 * connection with a body trickled in under its rate budget (the review
 * kept one open for 318 s); on Cloud Run only the platform's 60 s cut it.
 * These bound RECEIVING the request only: a long tool call answering it
 * is not cut. Node enforces both on a sweep every
 * `connectionsCheckingInterval` (default 30 s, so a 30 s deadline could
 * really be 60 s); the 5 s sweep keeps the cut within 35 s. That option
 * exists only at construction, which is why the server is built here
 * rather than by `app.listen`.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const CONNECTIONS_CHECK_INTERVAL_MS = 5_000;

/**
 * The HTTP server for `app` with the F-14 receive deadlines; the caller
 * listens. The overrides exist for tests (sub-second deadlines).
 */
export function createHttpServer(
  app: express.Express,
  overrides: {
    requestTimeoutMs?: number;
    headersTimeoutMs?: number;
    checkIntervalMs?: number;
  } = {},
): Server {
  return createServer(
    {
      requestTimeout: overrides.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      // Node requires headersTimeout ≤ requestTimeout.
      headersTimeout: overrides.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: overrides.checkIntervalMs ?? CONNECTIONS_CHECK_INTERVAL_MS,
    },
    app,
  );
}

export function createApp(opts: AppOptions): express.Express {
  const { oauthProvider, issuerUrl, allowedOrigins } = opts;
  const resourceName = opts.resourceName ?? "Loomio MCP";
  const trustProxy = opts.trustProxy ?? 0;
  const jsonLimit =
    typeof opts.jsonLimit === "number"
      ? opts.jsonLimit
      : (parseByteSize(opts.jsonLimit ?? DEFAULT_JSON_LIMIT) ??
        (parseByteSize(DEFAULT_JSON_LIMIT) as number));

  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  const app = express();
  app.set("trust proxy", trustProxy);
  // nit 6: no framework fingerprint. nit 7: Express's own error pages
  // (which the terminal handler below makes unreachable anyway) never
  // carry a stack trace, whatever NODE_ENV the process was started with.
  app.disable("x-powered-by");
  app.set("env", "production");

  const httpsIssuer = issuerUrl.protocol === "https:";
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    if (httpsIssuer) res.set("Strict-Transport-Security", HSTS_VALUE);
    next();
  });

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

  // Unauthenticated, rate-limited; exposes only health fields. See ./health.ts.
  mountHealth(app);

  mountTransport(app, {
    oauthProvider,
    mcpResourceUrl,
    jsonLimit,
    allowedOrigins,
    ...(opts.sharedEgress ? { sharedEgress: opts.sharedEgress } : {}),
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use(terminalErrorHandler);

  return app;
}
