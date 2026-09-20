/**
 * GET /health — the connector's liveness-plus-upstream-credential check.
 *
 * Unauthenticated on purpose: it exists so an external uptime checker
 * (Cloud Monitoring, a cron with curl, …) can tell within minutes that
 * the Loomio API key was rotated, and those checkers cannot do OAuth.
 * What it exposes is therefore kept to exactly the fields an operator
 * needs and nothing an attacker could use: the connector's version,
 * the probe verdict, Loomio's version, and when the probe ran. No key
 * material, no `detail` text (which may quote the configured base URL
 * or an error message), no Loomio hostname.
 *
 * Semantics:
 *   200 `{ status: "ok", key_status: "valid", … }`      — key accepted
 *   503 `{ status: "degraded", key_status: "rejected" | "unreachable", … }`
 *
 * 503 for BOTH non-valid states so a checker configured for "HTTP 200
 * and body contains `"key_status":"valid"`" is the whole alert rule.
 * `Cache-Control: no-store` because a cached 200 would defeat the point.
 * The probe itself is cached 60 s (src/loomio/health.ts), so a checker
 * polling every 5 minutes costs Loomio one request pair per poll and a
 * flood of unauthenticated hits costs it at most one pair per minute;
 * the per-IP limiter shared with /mcp bounds the CPU spend on top.
 *
 * Path. `/health` by default — deliberately NOT `/healthz`: Cloud Run's
 * frontend reserves `/healthz` and answers it with its own 404 before
 * the container sees the request, which would make an uptime check on
 * this page fail closed forever and hide the one thing it exists to
 * detect. `LOOMIO_MCP_HEALTH_PATH` moves the page for platforms that
 * claim `/health` as well. The override lets the operator move
 * the page without a connector release; the deployment's checker must
 * point at the same path (DEPLOY.md).
 */

import type express from "express";
import { checkLoomioHealth, type LoomioHealth } from "../loomio/health.js";
import { VERSION } from "../version.js";
import { createIpRateLimit } from "./rate-limit.js";

export const DEFAULT_HEALTH_PATH = "/health";

/**
 * The route the health page is mounted on. Read at mount time (not
 * module load) so tests can set the env per case. An override must be
 * an absolute path with no query string; anything else is refused
 * loudly at startup rather than silently mounting an unreachable page.
 */
export function resolveHealthPath(): string {
  const override = process.env["LOOMIO_MCP_HEALTH_PATH"];
  if (override === undefined || override === "") return DEFAULT_HEALTH_PATH;
  // One or more non-empty segments: rejects a relative path, a query
  // string, whitespace, a trailing slash and a protocol-relative `//host`.
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(override) || override.length > 128) {
    throw new Error(
      "LOOMIO_MCP_HEALTH_PATH must be an absolute path such as /health or /-/health " +
        "(segments of letters, digits, . _ ~ -; no query string, no empty segments).",
    );
  }
  return override;
}

export interface HealthzBody {
  status: "ok" | "degraded";
  connector_version: string;
  key_status: LoomioHealth["key_status"];
  loomio_version: string | null;
  checked_at: string;
}

/** Project a probe result onto the public response body — the ONLY fields /health ever returns. */
export function healthzBody(health: LoomioHealth): HealthzBody {
  return {
    status: health.key_status === "valid" ? "ok" : "degraded",
    connector_version: VERSION,
    key_status: health.key_status,
    loomio_version: health.loomio_version,
    checked_at: health.checked_at,
  };
}

export function healthzStatusCode(health: LoomioHealth): 200 | 503 {
  return health.key_status === "valid" ? 200 : 503;
}

export const healthzHandler: express.RequestHandler = async (_req, res) => {
  let health: LoomioHealth;
  try {
    health = await checkLoomioHealth();
  } catch (err) {
    // checkLoomioHealth folds every failure into `unreachable` and should
    // never reject; if it somehow does, still answer honestly rather than
    // let Express turn it into a 500 with a stack trace.
    health = {
      key_status: "unreachable",
      loomio_version: null,
      checked_at: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  res.status(healthzStatusCode(health)).set("Cache-Control", "no-store").json(healthzBody(health));
};

export function mountHealth(app: express.Express): void {
  const limiter = createIpRateLimit({
    handler: (_req, res) => {
      res.status(429).set("Cache-Control", "no-store").json({ error: "too_many_requests" });
    },
  });
  app.get(resolveHealthPath(), limiter, healthzHandler);
}
