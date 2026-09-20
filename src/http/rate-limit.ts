/**
 * Per-source-IP rate limiting shared by every public HTTP surface
 * (`/mcp` in transport.ts, `/health` in health.ts).
 *
 * One config, one keying rule, separate buckets: each `createIpRateLimit`
 * call gets its own in-memory store, so a monitoring probe hitting
 * `/health` never eats into a caller's `/mcp` budget and vice versa,
 * while both honour the same env knobs and the same kill switch.
 */

import type express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { readPositiveInt } from "../env.js";

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

export interface IpRateLimitOptions {
  /** What to send when the limit is hit; the surface decides the body shape (JSON-RPC vs plain JSON). */
  handler: express.RequestHandler;
}

/**
 * Build a limiter keyed on the SOURCE IP, never on anything the caller
 * controls. Under open DCR (the public deployment) any caller can POST
 * /register for unlimited fresh client_ids, so keying on client_id
 * would let one source mint a brand-new bucket at will — silently
 * defeating the limit. trust proxy=1 (Cloud Run's single front-end
 * hop) makes req.ip the real client address (not X-Forwarded-For-
 * spoofable past that hop), and ipKeyGenerator normalises IPv6 to a
 * /56 so a /128 walk can't sidestep it. In static-client mode this is
 * also strictly better than bucketing every caller under the one
 * shared client_id.
 */
export function createIpRateLimit(opts: IpRateLimitOptions): express.RequestHandler {
  const { windowMs, limit, disabled } = resolveMcpRateLimitConfig();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    skip: () => disabled,
    handler: opts.handler,
  });
}
