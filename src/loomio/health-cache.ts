/**
 * Module state for the key-health probe, split out of `health.ts` so
 * the HTTP client can READ the cached verdict without importing the
 * probe itself.
 *
 * `health.ts` runs the probe through `client.ts`; `client.ts` wants to
 * know, when it is about to throw for a 403, whether a RECENT probe
 * already found the key rejected (so it can say so definitively rather
 * than listing possible causes). Putting the cache in a third module
 * gives both a dependency on this file and none on each other — no
 * import cycle to reason about at module-evaluation time.
 *
 * Nothing here talks to the network. `health.ts` re-exports the type,
 * the TTL and `getCachedHealth` so callers only ever import from there.
 */

import type { GroupsIndexResponse } from "./types.js";

/**
 * How long a probe result is trusted. Two consumers share the number:
 * `checkLoomioHealth` serves the cached verdict without a network call
 * inside this window, and `client.ts` lets the cached verdict colour a
 * 403 message ONLY inside this window (`getFreshKeyStatus`). The
 * second use is why the constant lives here and not in `health.ts`: a
 * stale `valid` — the startup probe, days ago, under stdio where
 * nothing re-probes — must never make a post-rotation 403 read as
 * "not a key problem".
 */
export const HEALTH_CACHE_TTL_MS = 60_000;

/**
 * Why a probe did not come back `valid`, as a closed vocabulary. This
 * is what the forced `loomio.auth` log event carries instead of the
 * free-text `detail`: the event cannot be switched off, and `detail`
 * is built from upstream bodies and error messages, which the logging
 * invariant ("no request / response bodies, ever", src/log.ts) keeps
 * out of operator logs.
 *
 *   unauthenticated_body — rejected: Loomio's generic 403 body
 *   waf                  — unreachable: a CDN/WAF answered 403, Loomio never saw it
 *   unrecognised_403     — unreachable: 403 with a body not in the catalogue
 *   http_<status>        — unreachable: any other non-200 status
 *   timeout              — unreachable: the request hit the client's deadline
 *   network_error        — unreachable: DNS / connect / TLS / reset
 *   config_error         — unreachable: LOOMIO_API_KEY unset or LOOMIO_API_BASE_URL invalid
 */
export type HealthReason =
  | "unauthenticated_body"
  | "waf"
  | "unrecognised_403"
  | `http_${number}`
  | "timeout"
  | "network_error"
  | "config_error";

export interface LoomioHealth {
  /**
   * `valid`       — an authenticated GET /b2/groups answered 200.
   * `rejected`    — Loomio answered 403 with its unauthenticated body:
   *                 the key is not attached to any active user (rotated,
   *                 or the user was deactivated / redacted).
   * `unreachable` — anything else: network error, timeout, a 5xx, a
   *                 non-Loomio 403 from a CDN/WAF in front, or a
   *                 configuration error such as an invalid base URL.
   *                 Says nothing about the key either way.
   */
  key_status: "valid" | "rejected" | "unreachable";
  /** From the public GET /v1/boot/version; null when that call failed. */
  loomio_version: string | null;
  /** ISO-8601 timestamp of the probe that produced this result. */
  checked_at: string;
  /** Closed-vocabulary cause for a non-`valid` status. This — never `detail` — goes into log events. */
  reason?: HealthReason;
  /**
   * Human, operator-facing explanation for a non-`valid` status, for
   * the startup stderr warning and nothing else: it may quote an
   * upstream error message or body fragment. Never contains the key.
   * Not returned by `/health`, not copied into tool results, not logged.
   */
  detail?: string;
}

let cached: LoomioHealth | undefined;
let cachedAtMs = 0;
let cachedGroups: GroupsIndexResponse | undefined;

/** Last probe result, if any — regardless of age. `undefined` before the first probe. */
export function getCachedHealth(): LoomioHealth | undefined {
  return cached;
}

/**
 * The parsed body of the probe's GET /b2/groups, from the SAME probe
 * that produced `getCachedHealth()`, or `undefined` when that probe did
 * not answer 200 (or its body was not JSON). Kept because the probe
 * already paid for the request: `check_connection` forces a probe and
 * then reads this, so "does the connector work, and what can it see"
 * costs one request pair rather than three. Stored beside the verdict
 * — never ON it — so `/health` (which serialises `LoomioHealth`) cannot
 * grow a list of the user's groups.
 */
export function getCachedGroupsIndex(): GroupsIndexResponse | undefined {
  return cachedGroups;
}

/**
 * The cached groups body only while the verdict it came with is fresh
 * (`HEALTH_CACHE_TTL_MS`). A tool that can tolerate a minute-old view of
 * the user's groups uses this to avoid a network call; anything that
 * needs the current state calls `checkLoomioHealth({ force: true })`
 * first and then reads `getCachedGroupsIndex()`.
 */
export function getFreshGroupsIndex(now: number = Date.now()): GroupsIndexResponse | undefined {
  return cachedGroups && cachedHealthAgeMs(now) < HEALTH_CACHE_TTL_MS ? cachedGroups : undefined;
}

/** Milliseconds since the cached result was stored; `Infinity` when there is none. */
export function cachedHealthAgeMs(now: number = Date.now()): number {
  return cached ? now - cachedAtMs : Number.POSITIVE_INFINITY;
}

/**
 * The cached `key_status` when the probe ran within `HEALTH_CACHE_TTL_MS`,
 * otherwise `undefined`. The HTTP client uses this — not
 * `getCachedHealth` — to colour a 403 message, so an old verdict can
 * neither make a rotated key look like a visibility problem nor make a
 * long-since-replaced key look rejected.
 */
export function getFreshKeyStatus(
  now: number = Date.now(),
): LoomioHealth["key_status"] | undefined {
  return cached && cachedHealthAgeMs(now) < HEALTH_CACHE_TTL_MS ? cached.key_status : undefined;
}

/**
 * Store a probe's verdict and, when it had one, the parsed groups body
 * it came with. Both share one timestamp: a caller can never see a
 * `valid` verdict from one probe next to the groups of another.
 */
export function setCachedHealth(
  health: LoomioHealth,
  now: number = Date.now(),
  groups?: GroupsIndexResponse,
): void {
  cached = health;
  cachedAtMs = now;
  cachedGroups = groups;
}

/** Test hook: forget the cached result so the next probe hits the network. */
export function resetCachedHealth(): void {
  cached = undefined;
  cachedAtMs = 0;
  cachedGroups = undefined;
}
