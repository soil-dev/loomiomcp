/**
 * Per-source, per-UTC-day quotas on tool calls and result bytes — open-DCR
 * mode only (security review F-16).
 *
 * WHY. The per-IP limiter bounds request RATE (MCP_HTTP_RATE_LIMIT_MAX per
 * window), not VOLUME: at 300 requests a minute one anonymous source could
 * mirror the whole visible corpus, every bot-group roster and the activity
 * rankings — ~1.5 GB of roster JSON a minute in the review's measurement —
 * at a scale Loomio does not offer logged-out visitors. A day's quota caps
 * what one source takes home regardless of how it paces itself:
 *
 *   MCP_DAILY_TOOL_CALLS    default 5 000 tool calls per source per UTC day
 *   MCP_DAILY_RESULT_BYTES  default 500 000 000 bytes of tool results
 *
 * 0 disables either. A call is refused BEFORE it runs once either quota is
 * spent, so the byte quota can be overshot by at most the one result that
 * crossed it (itself bounded by the tools' reply budgets).
 *
 * Scope and limits, stated plainly because the numbers invite more trust
 * than they deserve:
 *   - Open-DCR mode only: the HTTP transport sets the request context's
 *     `quotaKey` only there (static-client callers are one known client).
 *     stdio has no request context, hence no quota.
 *   - The key is the limiter's (`clientIpKey`: source IP, IPv6 /56) —
 *     except for an address in MCP_SHARED_EGRESS_CIDRS, where it is
 *     `${address}|${clientIdTag}` and the address as a whole is held to
 *     SHARED_EGRESS_DAILY_FACTOR times the quotas (src/http/shared-egress.ts:
 *     hosted-Claude users no longer share one day-long bucket).
 *   - PER PROCESS (security review F-23): N instances allow up to N times
 *     the quota, and a cold start resets it. A shared store would make it
 *     global; this is a bound on casual bulk mirroring, not a hard cap.
 *   - Memory-bounded: at most `MAX_QUOTA_KEYS` sources are tracked; past
 *     that the oldest-seen source is forgotten (its count restarts). The
 *     whole table is dropped when the UTC day changes.
 */

import { readNonNegativeInt } from "./env.js";
import { SHARED_EGRESS_DAILY_FACTOR } from "./http/shared-egress.js";
import { getRequestContext } from "./log.js";

export const DEFAULT_DAILY_TOOL_CALLS = 5_000;
export const DEFAULT_DAILY_RESULT_BYTES = 500_000_000;
/** Sources tracked at once; ~100 B each, so the table stays around 10 MB at worst. */
export const MAX_QUOTA_KEYS = 100_000;

interface Usage {
  calls: number;
  bytes: number;
}

let currentDay = "";
const usage = new Map<string, Usage>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function usageFor(key: string, now: number): Usage {
  const today = utcDay(now);
  if (today !== currentDay) {
    usage.clear();
    currentDay = today;
  }
  let u = usage.get(key);
  if (!u) {
    if (usage.size >= MAX_QUOTA_KEYS) {
      const oldest = usage.keys().next().value;
      if (oldest !== undefined) usage.delete(oldest);
    }
    u = { calls: 0, bytes: 0 };
    usage.set(key, u);
  }
  return u;
}

/** Who spent the quota: an address, one client behind a shared egress address, or that whole address. */
export type QuotaScope = "source" | "client" | "shared-address";

const SCOPE_TEXT: Record<QuotaScope, string> = {
  source: "This source address has",
  client: "This client (behind a shared egress address) has",
  "shared-address": "This shared egress address, all its clients together, has",
};

/** A refused call: the source spent today's quota. Surfaces to the caller as a tool error. */
export class DailyQuotaError extends Error {
  constructor(
    what: "tool calls" | "result bytes",
    limit: number,
    knob: string,
    scope: QuotaScope = "source",
  ) {
    super(
      `${SCOPE_TEXT[scope]} used today's quota of ${limit} ${what} on this connector ` +
        `(${knob}); it resets at 00:00 UTC.`,
    );
    this.name = "DailyQuotaError";
  }
}

function limits(): { calls: number; bytes: number } {
  return {
    calls: readNonNegativeInt("MCP_DAILY_TOOL_CALLS", DEFAULT_DAILY_TOOL_CALLS),
    bytes: readNonNegativeInt("MCP_DAILY_RESULT_BYTES", DEFAULT_DAILY_RESULT_BYTES),
  };
}

/**
 * Charge one tool call to the active request's source, or throw
 * `DailyQuotaError` when either quota is already spent. A no-op outside
 * an open-DCR HTTP request (no `quotaKey`).
 */
export function chargeDailyToolCall(now: number = Date.now()): void {
  const ctx = getRequestContext();
  const key = ctx?.quotaKey;
  if (!key) return;
  const max = limits();
  if (max.calls === 0 && max.bytes === 0) return;
  const shared = ctx.sharedEgressKey;
  const checks: Array<[Usage, number, QuotaScope]> = [
    [usageFor(key, now), 1, shared ? "client" : "source"],
  ];
  // Aggregate key prefixed so it can never collide with a per-client key.
  if (shared)
    checks.push([usageFor(`*${shared}`, now), SHARED_EGRESS_DAILY_FACTOR, "shared-address"]);
  for (const [u, factor, scope] of checks) {
    if (max.calls > 0 && u.calls >= max.calls * factor) {
      throw new DailyQuotaError("tool calls", max.calls * factor, "MCP_DAILY_TOOL_CALLS", scope);
    }
    if (max.bytes > 0 && u.bytes >= max.bytes * factor) {
      throw new DailyQuotaError(
        "result bytes",
        max.bytes * factor,
        "MCP_DAILY_RESULT_BYTES",
        scope,
      );
    }
  }
  for (const [u] of checks) u.calls += 1;
}

/** Add a delivered result's size to the active request's source (and its shared address). */
export function recordDailyResultBytes(bytes: number, now: number = Date.now()): void {
  const ctx = getRequestContext();
  const key = ctx?.quotaKey;
  if (!key || bytes <= 0) return;
  usageFor(key, now).bytes += bytes;
  if (ctx.sharedEgressKey) usageFor(`*${ctx.sharedEgressKey}`, now).bytes += bytes;
}

/** Test hook: forget every source's usage. */
export function resetDailyQuotasForTests(): void {
  usage.clear();
  currentDay = "";
}

/** Test hook / observability: sources currently tracked. */
export function dailyQuotaKeyCount(): number {
  return usage.size;
}
