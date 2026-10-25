/**
 * Per-source-IP rate limiting shared by every public HTTP surface
 * (`/mcp` in transport.ts, `/health` in health.ts, and `/register`,
 * `/authorize`, `/token` in oauth-routes.ts).
 *
 * One config, one keying rule, separate buckets: each `createIpRateLimit`
 * call gets its own in-memory store, so a monitoring probe hitting
 * `/health` never eats into a caller's `/mcp` budget and vice versa,
 * while both honour the same env knobs and the same kill switch
 * (`MCP_HTTP_RATE_LIMIT_DISABLED=1`, which stops the /mcp and /health
 * limiters only — the OAuth routes' fixed limits stay, as in v0.0.16).
 */

import { isIP } from "node:net";
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
  /**
   * Fixed window / cap for a surface whose budget must NOT follow the
   * MCP_HTTP_RATE_LIMIT_* knobs (e.g. `/token`, oauth-routes.ts: 50 per
   * 15 min, the SDK's own figure). Keying and the kill switch stay shared.
   */
  windowMs?: number;
  limit?: number;
  /**
   * Ignore `MCP_HTTP_RATE_LIMIT_DISABLED`. The OAuth routes set it: in
   * v0.0.16 their limits were the SDK's own, which that kill switch never
   * touched, so letting it reach them in v0.0.17 would silently drop the
   * /register, /authorize and /token throttles of a deployment that set
   * the switch to rate-limit /mcp at a front proxy (review round 1).
   */
  ignoreKillSwitch?: boolean;
}

/**
 * The per-source key every limiter and the daily quotas (src/daily-quota.ts)
 * use: `req.ip` when it IS an IP address, else the socket's peer address,
 * IPv6 folded to its /56 by `ipKeyGenerator`.
 *
 * WHY the fallback (security review F-12). With `trust proxy` > 0 Express
 * takes req.ip from X-Forwarded-For verbatim, so `X-Forwarded-For:
 * <15 KB of junk>` became its own bucket: every limiter a no-op, and
 * 3,000 unique junk values cost the MemoryStore ~90 MB. A value that is
 * not an address now falls back to the TCP peer, which the caller does
 * not choose.
 */
export function clientIpKey(req: express.Request): string {
  return ipKeyGenerator(clientAddress(req));
}

/**
 * The caller's address before IPv6 folding: `req.ip` when it IS an IP
 * address, else the TCP peer (the F-12 rule above). What the shared
 * egress ranges are matched against (src/http/shared-egress.ts).
 */
export function clientAddress(req: express.Request): string {
  const ip = req.ip;
  return ip && isIP(ip) !== 0 ? ip : (req.socket?.remoteAddress ?? "");
}

/**
 * Build a limiter keyed on the SOURCE IP, never on anything the caller
 * controls. Under open DCR (the public deployment) any caller can POST
 * /register for unlimited fresh client_ids, so keying on client_id
 * would let one source mint a brand-new bucket at will — silently
 * defeating the limit. `MCP_HTTP_TRUST_PROXY` (default 0; 1 on Cloud
 * Run's single front-end hop) decides whether req.ip comes from the
 * socket or the proxy's X-Forwarded-For, `clientIpKey` refuses a
 * non-address value, and ipKeyGenerator normalises IPv6 to a /56 so a
 * /128 walk can't sidestep it. In static-client mode this is also
 * strictly better than bucketing every caller under the one shared
 * client_id.
 *
 * Every limiter here keeps its counts in this process's memory
 * (express-rate-limit's MemoryStore): with N instances the effective
 * per-source ceiling is up to N times the configured value, and it
 * resets on every cold start (security review F-23).
 */
export function createIpRateLimit(opts: IpRateLimitOptions): express.RequestHandler {
  const { windowMs, limit, disabled } = resolveMcpRateLimitConfig();
  return rateLimit({
    windowMs: opts.windowMs ?? windowMs,
    limit: opts.limit ?? limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => clientIpKey(req),
    skip: () => disabled && !opts.ignoreKillSwitch,
    handler: opts.handler,
  });
}
