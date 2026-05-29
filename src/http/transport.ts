/**
 * /mcp endpoint wiring: origin guard, bearer auth, rate limit,
 * protocol-version guard, and the StreamableHTTPServerTransport
 * handler that bridges incoming HTTP requests into the MCP server.
 */

import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthProvider } from "../auth/provider.js";
import { readPositiveInt } from "../env.js";
import { createLoomioMcpServer } from "../server.js";
import { withRequestContext } from "../log.js";

const DEFAULT_MCP_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MCP_RATE_LIMIT_MAX = 600;
const MAX_MEMORY_STORE_WINDOW_MS = 2 ** 31 - 1;

export function resolveMcpRateLimitConfig(): {
  windowMs: number;
  limit: number;
  disabled: boolean;
} {
  const windowMs = Math.min(
    readPositiveInt("MCP_HTTP_RATE_LIMIT_WINDOW_MS", DEFAULT_MCP_RATE_LIMIT_WINDOW_MS),
    MAX_MEMORY_STORE_WINDOW_MS,
  );
  return {
    windowMs,
    limit: readPositiveInt("MCP_HTTP_RATE_LIMIT_MAX", DEFAULT_MCP_RATE_LIMIT_MAX),
    disabled: process.env["MCP_HTTP_RATE_LIMIT_DISABLED"] === "1",
  };
}

export interface TransportOptions {
  oauthProvider: OAuthProvider;
  mcpResourceUrl: URL;
  jsonLimit: string;
  allowedOrigins: string[];
}

export function mountTransport(app: express.Express, opts: TransportOptions): void {
  const { oauthProvider, mcpResourceUrl, jsonLimit, allowedOrigins } = opts;
  const mcpResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);

  const guardOrigin: express.RequestHandler = (req, res, next) => {
    const origin = req.get("Origin");
    if (!origin) {
      next();
      return;
    }
    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      });
      return;
    }
    if (!allowedOrigins.includes(normalizedOrigin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin is not allowed" },
        id: null,
      });
      return;
    }
    next();
  };

  const {
    windowMs: rateLimitWindowMs,
    limit: rateLimitMax,
    disabled: rateLimitDisabled,
  } = resolveMcpRateLimitConfig();
  const mcpRateLimit = rateLimit({
    windowMs: rateLimitWindowMs,
    limit: rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Key the limiter on the SOURCE IP, never the OAuth client_id.
    // Under open DCR (the public deployment) any caller can POST
    // /register for unlimited fresh client_ids, so keying on client_id
    // would let one source mint a brand-new 300/min bucket at will —
    // silently defeating the limit. trust proxy=1 (Cloud Run's single
    // front-end hop) makes req.ip the real client address (not
    // X-Forwarded-For-spoofable past that hop), and ipKeyGenerator
    // normalises IPv6 to a /56 so a /128 walk can't sidestep it. In
    // static-client mode this is also strictly better than the old
    // behaviour, which bucketed every caller under the one shared
    // client_id.
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    skip: () => rateLimitDisabled,
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too Many Requests" },
        id: null,
      });
    },
  });

  const guardProtocolVersion: express.RequestHandler = (req, res, next) => {
    const protocolVersion = req.get("MCP-Protocol-Version");
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version: ${protocolVersion}`,
        },
        id: null,
      });
      return;
    }
    next();
  };

  app.post(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    express.json({ limit: jsonLimit }),
    async (req, res) => {
      try {
        const clientId = (req as { auth?: { clientId?: string } }).auth?.clientId;
        const server = createLoomioMcpServer();
        const transport = new StreamableHTTPServerTransport({});

        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await withRequestContext({ clientId }, async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : typeof err;
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: number }).status)
            : undefined;
        const summary = status !== undefined ? `${name} ${status}` : name;
        if (process.env["MCP_HTTP_DEBUG"] === "1") {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[loomiomcp] /mcp error: ${summary} — ${message}`);
        } else {
          console.error(`[loomiomcp] /mcp error: ${summary}`);
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error" });
        }
      }
    },
  );

  const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
    res.set("Allow", "POST").status(405).json({
      error: "method_not_allowed",
      message: "Use POST for MCP requests; this server runs in stateless mode.",
    });
  };

  app.get(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    methodNotAllowed,
  );
  app.delete(
    "/mcp",
    guardOrigin,
    requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: mcpResourceMetadataUrl,
    }),
    mcpRateLimit,
    guardProtocolVersion,
    methodNotAllowed,
  );
}
