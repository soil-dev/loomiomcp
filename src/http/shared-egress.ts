/**
 * Shared egress ranges: source addresses that many unrelated users reach
 * the connector from (round-2 security finding on F-16 / F-01).
 *
 * WHY. The open-DCR daily quotas (src/daily-quota.ts) and the per-source
 * upstream share (src/loomio/upstream.ts) key on the caller's ADDRESS.
 * Every claude.ai, Claude Desktop and mobile user — and every Messages-API
 * MCP-connector call, whose tool calls the API caller controls completely
 * — arrives from Anthropic's published egress ranges, so they all shared
 * one bucket per address and instance. Measured on the reference shape
 * (MCP_HTTP_UPSTREAM_PER_5MIN=300, a 10-group allow-list): ~14 tool calls
 * spent the address's 5-minute share, and 5 000 calls (~17 min at the
 * HTTP rate limit) locked the address out until 00:00 UTC — the
 * deployment's main population, by one of its members, cheaply.
 *
 * The fix: an address inside `MCP_SHARED_EGRESS_CIDRS` is keyed per
 * CLIENT as well — `${address}|${clientIdTag}` — with a per-client cap
 * well below an aggregate cap that still holds for the address:
 *
 *   upstream 5-min share  per client: ¼ of a source's share (½ of the
 *                         window); the address as a whole: one source's
 *                         share, as before — so the rest of the world
 *                         keeps its half of Loomio's budget.
 *   daily quotas          per client: MCP_DAILY_TOOL_CALLS /
 *                         MCP_DAILY_RESULT_BYTES, as any source; the
 *                         address as a whole: 20 times that.
 *   concurrency fairness  round-robin per client, so one client's queued
 *                         calls no longer delay the other users of the
 *                         address.
 *
 * Locking the address out now needs several client_ids — each minted by
 * a /register from the attacker's OWN address (20 per hour) — and, for a
 * day-long lockout, 20 of them spending a full quota each (~100 000 tool
 * calls). The /mcp request-rate limiter (MCP_HTTP_RATE_LIMIT_MAX) runs
 * BEFORE the bearer check (nit 5) and so stays per address: a minute-long
 * shared bucket, documented in SECURITY.md.
 *
 * A client_id is free to mint, so this is a cost increase, not identity:
 * outside these ranges the key stays the address alone (keying on
 * client_id there would let one source mint fresh buckets at will).
 */

import { BlockList, isIP } from "node:net";

/** A client behind a shared egress address may use this fraction (1/N) of the address's upstream share. */
export const SHARED_EGRESS_CLIENT_SHARE_DIVISOR = 4;
/** A shared egress address as a whole may use this many times the per-source daily quotas. */
export const SHARED_EGRESS_DAILY_FACTOR = 20;
/** CIDR entries accepted (a published egress list is a handful). */
const MAX_CIDRS = 64;

export interface SharedEgress {
  /** The normalised CIDRs, for the startup line. */
  cidrs: string[];
  /** True when `address` (as Express / the socket reports it) lies in a listed range. */
  contains(address: string): boolean;
}

/** `::ffff:1.2.3.4` (an IPv4 peer on a dual-stack socket) is checked as `1.2.3.4`. */
function unmapped(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? (m[1] as string) : address;
}

/**
 * Parse `MCP_SHARED_EGRESS_CIDRS` (comma-separated `addr/prefix`, IPv4
 * or IPv6). Unset or blank → `{ ok: undefined }` (the feature is off).
 * Any malformed entry → an error for a FATAL startup line, quoting at
 * most 64 characters of it.
 */
export function parseSharedEgressCidrs(
  raw: string | undefined,
): { ok: SharedEgress | undefined } | { error: string } {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: undefined };
  if (entries.length > MAX_CIDRS) {
    return { error: `MCP_SHARED_EGRESS_CIDRS lists more than ${MAX_CIDRS} ranges.` };
  }
  const list = new BlockList();
  const cidrs: string[] = [];
  for (const entry of entries) {
    const m = /^([^/\s]+)\/(\d{1,3})$/.exec(entry);
    const family = m ? isIP(m[1] as string) : 0;
    const prefix = m ? Number(m[2]) : -1;
    if (!m || family === 0 || prefix > (family === 4 ? 32 : 128)) {
      return {
        error:
          "MCP_SHARED_EGRESS_CIDRS must be comma-separated CIDR ranges such as 192.0.2.0/24 or " +
          `2001:db8::/32 (got ${JSON.stringify(entry.slice(0, 64))}).`,
      };
    }
    list.addSubnet(m[1] as string, prefix, family === 4 ? "ipv4" : "ipv6");
    cidrs.push(`${m[1]}/${prefix}`);
  }
  return {
    ok: {
      cidrs,
      contains(address: string): boolean {
        const a = unmapped(address);
        const family = isIP(a);
        if (family === 0) return false;
        return list.check(a, family === 4 ? "ipv4" : "ipv6");
      },
    },
  };
}
