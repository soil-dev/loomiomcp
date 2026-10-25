/**
 * /mcp endpoint wiring: rate limit, origin guard (+ CORS for allowed
 * origins), bearer auth, protocol-version guard, body parse, batch
 * policy, and the StreamableHTTPServerTransport handler that bridges
 * incoming HTTP requests into the MCP server.
 *
 * Order matters and is part of the security posture:
 *
 *   0. CORS grant: an allow-listed browser Origin (MCP_ALLOWED_ORIGINS +
 *      the issuer + claude.ai) gets `Access-Control-Allow-Origin` for
 *      exactly itself on EVERY response — the limiter's 429 and the
 *      bearer 401 included, so a browser client can read why it was
 *      refused — and a real preflight answer (nit 6). Nothing is refused
 *      here and no other origin ever gets a CORS header. Bearer tokens
 *      are never ambient (no cookies), so the grant adds no CSRF
 *      surface: a page must already hold a token to use it.
 *   1. `mcpRateLimit` (security review nit 5). v0.0.16 ran it after the
 *      bearer check, so floods of 401s (400 in 58 ms) were never
 *      metered. Every request to /mcp now costs one unit, authenticated
 *      or not, before anything else is evaluated.
 *   2. Origin guard: an absent Origin passes (server-to-server clients);
 *      a present one must be allow-listed, else 403.
 *   3. Bearer auth, protocol-version guard, then the JSON body parser,
 *      capped at MCP_HTTP_JSON_LIMIT (default 256 KB, F-14) — the same
 *      cap is handed to the SDK transport; an over-cap body is answered
 *      413 in JSON-RPC shape (-32600) so a client can say why.
 *   4. Batch policy (F-01 d): a JSON-RPC array is refused with 400 when
 *      the request declares MCP-Protocol-Version ≥ 2025-06-18 — the
 *      revision that removed batching, so no conforming client of it
 *      sends one. Older clients keep batches, but a batch now shares ONE
 *      upstream budget (below), so it cannot multiply the per-call bounds.
 *   5. The handler runs the request inside a request context
 *      (src/log.ts) carrying the per-HTTP-request upstream budget
 *      (MCP_HTTP_UPSTREAM_BUDGET, F-01 a), an AbortSignal fired when the
 *      response closes — the client went away — (F-01 b), the source
 *      keys of the upstream share and, in open-DCR mode, of the daily
 *      quotas (F-16) — per client as well for an address in
 *      MCP_SHARED_EGRESS_CIDRS (src/http/shared-egress.ts).
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthProvider } from "../auth/provider.js";
import { isOpenDcr } from "../deployment.js";
import { createLoomioMcpServer } from "../server.js";
import { clientIdTag, withRequestContext } from "../log.js";
import { scrubSecrets } from "../loomio/secrets.js";
import { resolveUpstreamBudget } from "../loomio/upstream.js";
import { clientAddress, clientIpKey, createIpRateLimit } from "./rate-limit.js";
import type { SharedEgress } from "./shared-egress.js";

// The limiter config and keying rule live in ./rate-limit.ts so /health
// can share them; re-exported here for callers that knew the old home.
export { resolveMcpRateLimitConfig } from "./rate-limit.js";

export interface TransportOptions {
  oauthProvider: OAuthProvider;
  mcpResourceUrl: URL;
  /** Body cap in bytes, applied by express.json AND the SDK transport. */
  jsonLimit: number;
  allowedOrigins: string[];
  /** MCP_SHARED_EGRESS_CIDRS: addresses keyed per client as well (src/http/shared-egress.ts). */
  sharedEgress?: SharedEgress;
}

/**
 * The request context's source keys. An ordinary source is its address
 * key for everything. An address in a shared egress range with an
 * authenticated client is `${address}|${clientIdTag}` for the per-client
 * caps, plus `sharedEgressKey` = the address for the aggregate ones.
 */
export function sourceKeysFor(
  req: express.Request,
  clientId: string | undefined,
  sharedEgress: SharedEgress | undefined,
): { sourceKey: string; sharedEgressKey?: string } {
  const address = clientIpKey(req);
  if (!clientId || !sharedEgress?.contains(clientAddress(req))) return { sourceKey: address };
  return { sourceKey: `${address}|${clientIdTag(clientId)}`, sharedEgressKey: address };
}

/** The first MCP protocol revision without JSON-RPC batching (it was in 2025-03-26 only). */
export const BATCHLESS_PROTOCOL_VERSION = "2025-06-18";

/** Request headers a browser MCP client sends that the preflight must allow. */
const CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
/** Response headers a browser MCP client needs to read (auth discovery, limiter state). */
const CORS_EXPOSE_HEADERS = "WWW-Authenticate, Mcp-Session-Id, RateLimit, RateLimit-Policy";

/** How much of an internal error message MCP_HTTP_DEBUG may print (nit 21). */
const DEBUG_MESSAGE_MAX = 200;

/**
 * The per-request SDK transport, stateless (no session id, no event store:
 * nothing resumable), with the SAME body cap as express.json in front of
 * it (security review F-14). The SDK reads the body itself whenever it is
 * handed no parsed one, and its own default is 4 MB; unreachable through
 * the route as wired today, the cap keeps it that way if the parser in
 * front ever changes.
 */
export function createMcpTransport(maxBodyBytes: number): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({ maxRequestBodySize: maxBodyBytes });
}

/**
 * The one stderr line for an error that escaped the MCP handler. Without
 * `debug` it names the error class and HTTP status only. `MCP_HTTP_DEBUG=1`
 * adds the message — a LOCAL diagnosis aid (DEPLOY.md: never set it on a
 * shared deployment) — flattened to one line, scrubbed of the configured
 * Loomio credentials and clipped to 200 characters, so even a local run
 * cannot dump a whole upstream body into the log (security review nit 21).
 */
export function mcpErrorLine(err: unknown, debug: boolean): string {
  const name = err instanceof Error ? err.name : typeof err;
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  const summary = status !== undefined && Number.isFinite(status) ? `${name} ${status}` : name;
  if (!debug) return `[loomiomcp] /mcp error: ${summary}`;
  const raw = err instanceof Error ? err.message : String(err);
  const message = scrubSecrets(raw.replace(/[\r\n]+/g, " ")).slice(0, DEBUG_MESSAGE_MAX);
  return `[loomiomcp] /mcp error: ${summary} — ${message}`;
}

export function mountTransport(app: express.Express, opts: TransportOptions): void {
  const { oauthProvider, mcpResourceUrl, jsonLimit, allowedOrigins, sharedEgress } = opts;
  const mcpResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);

  /** The allow-listed origin `req` carries, or undefined (absent, malformed or not listed). */
  const allowedOriginOf = (req: express.Request): string | undefined => {
    const origin = req.get("Origin");
    if (!origin || !URL.canParse(origin)) return undefined;
    const normalized = new URL(origin).origin;
    return allowedOrigins.includes(normalized) ? normalized : undefined;
  };

  // Step 0 (module comment): grant, never refuse.
  const corsGrant: express.RequestHandler = (req, res, next) => {
    res.vary("Origin");
    const origin = allowedOriginOf(req);
    if (origin) {
      // Exactly the caller's origin — never `*`, never credentials.
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
    }
    next();
  };

  const guardOrigin: express.RequestHandler = (req, res, next) => {
    const origin = req.get("Origin");
    if (!origin) {
      next();
      return;
    }
    if (!URL.canParse(origin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      });
      return;
    }
    if (allowedOriginOf(req) === undefined) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin is not allowed" },
        id: null,
      });
      return;
    }
    next();
  };

  // Keyed on the source IP, never the OAuth client_id — see
  // ./rate-limit.ts for why. The /mcp surface answers in JSON-RPC shape.
  const mcpRateLimit = createIpRateLimit({
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too Many Requests" },
        id: null,
      });
    },
  });

  const bearer = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: mcpResourceMetadataUrl,
  });

  const guardProtocolVersion: express.RequestHandler = (req, res, next) => {
    const protocolVersion = req.get("MCP-Protocol-Version");
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      // The supported list, not the caller's value: nothing it sent is echoed (nit 6).
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
        },
        id: null,
      });
      return;
    }
    next();
  };

  const guardBatch: express.RequestHandler = (req, res, next) => {
    if (!Array.isArray(req.body)) {
      next();
      return;
    }
    // Absent header = 2025-03-26 per the spec's backwards-compatibility
    // rule, which still had batching. The value was validated above.
    const version = req.get("MCP-Protocol-Version");
    if (version && version >= BATCHLESS_PROTOCOL_VERSION) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message:
            `Invalid Request: JSON-RPC batches are not part of MCP ${BATCHLESS_PROTOCOL_VERSION} and ` +
            "later; send one message per request.",
        },
        id: null,
      });
      return;
    }
    next();
  };

  // Body parser with a JSON-RPC-shaped 413. WHY (compat review, round 2):
  // a schema-valid write (a 100 000-character body in CJK text is ~300 KB
  // of UTF-8, ~600 KB when \u-escaped) can exceed the 256 KB default, and
  // body-parser's bare 413 reached the app's terminal handler as
  // `{"error":"payload_too_large"}` — not JSON-RPC, so the client showed
  // a transport failure the model could not act on. Same status, same
  // "log nothing" rule as F-06; only the shape and a fixed reason change.
  // Every other parser error (malformed JSON, charset) still goes to the
  // terminal handler's fixed codes.
  const parseJson = express.json({ limit: jsonLimit });
  const parseBody: express.RequestHandler = (req, res, next) => {
    parseJson(req, res, (err?: unknown) => {
      if (err && (err as { type?: unknown }).type === "entity.too.large") {
        res.status(413).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message:
              `Request body over MCP_HTTP_JSON_LIMIT (${jsonLimit} bytes): shorten the text ` +
              "or split it across calls.",
          },
          id: null,
        });
        return;
      }
      next(err);
    });
  };

  app.post(
    "/mcp",
    corsGrant,
    mcpRateLimit,
    guardOrigin,
    bearer,
    guardProtocolVersion,
    parseBody,
    guardBatch,
    async (req, res) => {
      try {
        const clientId = (req as { auth?: { clientId?: string } }).auth?.clientId;
        const server = createLoomioMcpServer();
        const transport = createMcpTransport(jsonLimit);

        // Fires when the response is done OR the client went away. In the
        // second case the work must stop: aborting `disconnect` cancels
        // every in-flight Loomio request of this HTTP request and makes
        // later ones fail before they are sent (src/loomio/upstream.ts);
        // closing the transport aborts each tool call's `extra.signal`.
        // After a normal finish nothing is left to abort, so it is harmless.
        const disconnect = new AbortController();
        res.on("close", () => {
          disconnect.abort();
          void transport.close();
          void server.close();
        });

        const batchSize = Array.isArray(req.body) ? req.body.length : undefined;
        const keys = sourceKeysFor(req, clientId, sharedEgress);
        await withRequestContext(
          {
            clientId,
            upstreamBudget: resolveUpstreamBudget(),
            signal: disconnect.signal,
            ...keys,
            ...(isOpenDcr() ? { quotaKey: keys.sourceKey } : {}),
            ...(batchSize !== undefined ? { batchSize } : {}),
          },
          async () => {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
          },
        );
      } catch (err) {
        console.error(mcpErrorLine(err, process.env["MCP_HTTP_DEBUG"] === "1"));
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error" });
        }
      }
    },
  );

  // CORS preflight (nit 6). Never bearer-gated — browsers send no
  // credentials on a preflight — but rate-limited like every /mcp request.
  // An allowed Origin gets the grant (corsGrant) plus what the POST needs;
  // a disallowed or malformed one gets guardOrigin's 403 and no CORS
  // header; no Origin at all (not a browser) gets a plain Allow.
  app.options("/mcp", corsGrant, mcpRateLimit, guardOrigin, (req, res) => {
    if (req.get("Origin")) {
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
      res.set("Access-Control-Max-Age", "600");
    }
    res.set("Allow", "POST, OPTIONS").status(204).end();
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
    res.set("Allow", "POST").status(405).json({
      error: "method_not_allowed",
      message: "Use POST for MCP requests; this server runs in stateless mode.",
    });
  };

  const guarded = [corsGrant, mcpRateLimit, guardOrigin, bearer, guardProtocolVersion];
  app.get("/mcp", ...guarded, methodNotAllowed);
  app.delete("/mcp", ...guarded, methodNotAllowed);
  // Every other method: JSON 405 instead of Express's HTML 404 (nit 6).
  app.all("/mcp", corsGrant, mcpRateLimit, guardOrigin, methodNotAllowed);
}
