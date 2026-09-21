/**
 * Key-health probe: is the connector's Loomio API key still accepted,
 * and which Loomio is on the other end?
 *
 * Why this exists. A Loomio API key is not a long-lived credential in
 * the way operators tend to assume: Loomio regenerates a user's key
 * whenever that user's password changes, when the account is redacted
 * or merged, and Loomio 3.3.1 rotated EVERY user's key once as a
 * migration. When that happens every b2 call answers 403 with the same
 * generic body — and a connector that only sees traffic a few times a
 * week can stay silently broken for a long time, because no
 * error-rate alert ever has enough samples to fire. The fix is an
 * active probe the connector runs itself and exposes (`/health`, the
 * forced `loomio.auth` log event) so an external uptime check notices
 * in minutes.
 *
 * What it does. Two GETs, in parallel:
 *
 *   GET /b2/groups (authenticated)  — Loomio's `GroupsController#index`
 *     returns `current_user.groups` for any active key holder, even one
 *     with zero groups, so 200 means "key valid" with no false
 *     negatives. 403 with Loomio's unauthenticated body means "no
 *     active user owns this key" → rejected. A 403 that did NOT come
 *     from Loomio (CDN/WAF), any other status, a timeout or a config
 *     error → unreachable: we do not know, and say so. The 200 body —
 *     the user's groups, parent groups, own membership rows and the
 *     users those reference — is parsed and kept beside the verdict
 *     (`getCachedGroupsIndex`), because `check_connection` wants
 *     exactly that list and has just paid for it. The request sends
 *     `exclude_types=tag translation` (the groups read profile) so the
 *     once-a-minute probe does not haul tag and translation side-loads
 *     it never reads.
 *   GET /v1/boot/version (public, no credential) — `{ "version": "3.8.1" }`.
 *     Failure here never affects `key_status`; it only leaves
 *     `loomio_version` null.
 *
 * The result is cached for 60 s (`HEALTH_CACHE_TTL_MS`) and concurrent
 * callers share one in-flight probe, so an unauthenticated `/health`
 * being hammered costs Loomio at most one request pair per minute.
 * `force: true` bypasses the cache (startup, tests).
 *
 * Events. Every CHANGE of `key_status` — including the first result —
 * emits a forced `loomio.auth` event (bypasses the verbose gate; see
 * src/log.ts) so operators see "valid → rejected" without turning
 * verbose logging on. The event carries `key_status`, `loomio_version`
 * and a closed-vocabulary `reason` (`HealthReason`) — NOT the free-text
 * `detail`, which is built from upstream error messages and body
 * fragments and would break the "no request / response bodies, ever"
 * logging invariant on the one event operators cannot switch off.
 * `detail` stays on the result for the startup stderr warning. A
 * one-time forced `loomio.version_drift` fires when the instance's
 * major.minor differs from `TESTED_LOOMIO_VERSION`: Loomio publishes no
 * API compatibility policy, so a new minor is a prompt to re-verify the
 * connector, not necessarily a breakage.
 *
 * Never logs or returns the key.
 */

import { logEvent } from "../log.js";
import { TESTED_LOOMIO_VERSION } from "../version.js";
import {
  classifyForbidden,
  LoomioApiError,
  LoomioAuthError,
  loomioGetPublic,
  loomioGetRaw,
  readParams,
} from "./client.js";
import {
  cachedHealthAgeMs,
  getCachedGroupsIndex,
  getCachedHealth,
  getFreshGroupsIndex,
  HEALTH_CACHE_TTL_MS,
  type HealthReason,
  type LoomioHealth,
  resetCachedHealth,
  setCachedHealth,
} from "./health-cache.js";
import type { GroupsIndexResponse } from "./types.js";

export type { HealthReason, LoomioHealth };
export { getCachedGroupsIndex, getCachedHealth, getFreshGroupsIndex, HEALTH_CACHE_TTL_MS };

/** The authenticated probe target. See the module comment for why this endpoint. */
export const HEALTH_PROBE_PATH = "/b2/groups";
/** Public endpoint reporting the instance's Loomio version. */
export const VERSION_PROBE_PATH = "/v1/boot/version";

let inflight: Promise<LoomioHealth> | undefined;
let driftWarned = false;

/** Test hook: clear the cache, any in-flight probe, and the one-time drift flag. */
export function resetHealthForTests(): void {
  resetCachedHealth();
  inflight = undefined;
  driftWarned = false;
}

/**
 * Return the cached health if it is fresh, otherwise probe Loomio.
 * Never rejects: every failure mode is folded into `key_status:
 * "unreachable"` with a `detail`, because callers (startup hooks,
 * `/health`, tools deciding whether an empty result is real) need an
 * answer, not an exception.
 */
export async function checkLoomioHealth(opts: { force?: boolean } = {}): Promise<LoomioHealth> {
  const cached = getCachedHealth();
  if (!opts.force && cached && cachedHealthAgeMs() < HEALTH_CACHE_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = runProbe().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function runProbe(): Promise<LoomioHealth> {
  const previous = getCachedHealth();
  const [key, loomioVersion] = await Promise.all([probeKey(), probeVersion()]);
  const health: LoomioHealth = {
    key_status: key.key_status,
    loomio_version: loomioVersion,
    checked_at: new Date().toISOString(),
    ...(key.reason ? { reason: key.reason } : {}),
    ...(key.detail ? { detail: key.detail } : {}),
  };
  setCachedHealth(health, Date.now(), key.groups);

  if (!previous || previous.key_status !== health.key_status) {
    // `reason`, never `detail`: this event is forced (cannot be turned
    // off) and `detail` may quote an upstream body or error message.
    logEvent(
      "loomio.auth",
      {
        key_status: health.key_status,
        loomio_version: health.loomio_version,
        ...(health.reason ? { reason: health.reason } : {}),
      },
      { force: true },
    );
  }
  warnOnVersionDrift(loomioVersion);
  return health;
}

type KeyVerdict = Pick<LoomioHealth, "key_status" | "reason" | "detail"> & {
  /** The parsed 200 body of the groups probe; only ever set with `key_status: "valid"`. */
  groups?: GroupsIndexResponse;
};

/**
 * Parse the groups probe's 200 body. A body that is not a JSON object
 * is not an error for the PROBE — the status already proved the key —
 * so it yields `undefined` and `check_connection` falls back to its own
 * request. Never throws.
 */
function parseGroupsIndex(text: string): GroupsIndexResponse | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as GroupsIndexResponse)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sort a thrown error from `loomioGetRaw` into the closed vocabulary.
 * Configuration errors are `LoomioAuthError`s WITHOUT an HTTP status
 * (missing LOOMIO_API_KEY, invalid LOOMIO_API_BASE_URL); the client's
 * deadline surfaces as `LoomioApiError(504)`; everything else is the
 * transport (DNS, connect, TLS, reset).
 */
function reasonForThrow(err: unknown): HealthReason {
  if (err instanceof LoomioAuthError && err.status === undefined) return "config_error";
  if (err instanceof LoomioApiError && err.status === 504) return "timeout";
  return "network_error";
}

async function probeKey(): Promise<KeyVerdict> {
  let status: number;
  let text: string;
  try {
    ({ status, text } = await loomioGetRaw(HEALTH_PROBE_PATH, readParams("groups")));
  } catch (err) {
    // Network error, timeout, missing LOOMIO_API_KEY, invalid base URL —
    // none of these say anything about the key itself.
    return {
      key_status: "unreachable",
      reason: reasonForThrow(err),
      detail: `GET ${HEALTH_PROBE_PATH} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (status === 200) return { key_status: "valid", groups: parseGroupsIndex(text) };
  if (status === 403) {
    // Only Loomio's own unauthenticated body proves the key is rejected.
    // A WAF's 403 never reached Loomio; any other JSON 403 on this
    // endpoint is uncatalogued, so refuse to guess.
    const { kind } = classifyForbidden(text, { path: HEALTH_PROBE_PATH });
    if (kind === "unauthenticated") {
      return {
        key_status: "rejected",
        reason: "unauthenticated_body",
        detail:
          `Loomio answered GET ${HEALTH_PROBE_PATH} with 403 and its unauthenticated body: no active ` +
          "user owns this API key (rotated on password change / Loomio 3.3.1 upgrade, or the user was " +
          "deactivated). Obtain the current key from the user's API access page (/profile/api_access).",
      };
    }
    if (kind === "waf") {
      return {
        key_status: "unreachable",
        reason: "waf",
        detail:
          `GET ${HEALTH_PROBE_PATH} was answered 403 by a CDN/WAF in front of Loomio, not by Loomio; ` +
          "check the WAF's rules (User-Agent / bot rules) — the key was never evaluated.",
      };
    }
    return {
      key_status: "unreachable",
      reason: "unrecognised_403",
      detail: `GET ${HEALTH_PROBE_PATH} answered 403 with an unrecognised body: ${text.slice(0, 200)}`,
    };
  }
  return {
    key_status: "unreachable",
    reason: `http_${status}`,
    detail: `GET ${HEALTH_PROBE_PATH} answered HTTP ${status}`,
  };
}

async function probeVersion(): Promise<string | null> {
  try {
    const { status, text } = await loomioGetPublic(VERSION_PROBE_PATH);
    if (status !== 200) return null;
    const parsed: unknown = JSON.parse(text);
    const version =
      parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function majorMinor(version: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : undefined;
}

function warnOnVersionDrift(loomioVersion: string | null): void {
  if (driftWarned || !loomioVersion) return;
  const seen = majorMinor(loomioVersion);
  if (!seen || seen === majorMinor(TESTED_LOOMIO_VERSION)) return;
  driftWarned = true;
  logEvent(
    "loomio.version_drift",
    {
      level: "warning",
      loomio_version: loomioVersion,
      tested_loomio_version: TESTED_LOOMIO_VERSION,
      message:
        "The Loomio instance runs a different major.minor than this connector was verified against. " +
        "Loomio publishes no API compatibility policy; re-verify the connector against this release.",
    },
    { force: true },
  );
}

/**
 * The connector user's own Loomio id, from the LAST groups probe body of
 * any age — or `undefined` before the first successful probe. The
 * groups index side-loads only the API user's own membership rows, so
 * any row's `user_id` names it.
 *
 * Why any age is fine here where `getFreshKeyStatus` insists on a fresh
 * verdict: a key belongs to one user for its whole life (rotation
 * invalidates the key, it never re-points it), so the identity a probe
 * learned yesterday is the identity behind today's calls unless the
 * operator swapped LOOMIO_API_KEY for a different user's key without
 * restarting — and the startup probe runs on every start. Consumers use
 * this to recognise the user's OWN stance among a thread's stances
 * (`ownStanceFor`), where a missing id merely errs towards hiding poll
 * results the user could see, never towards showing what it could not.
 */
export function cachedOwnUserId(): number | undefined {
  const rows = getCachedGroupsIndex()?.memberships;
  if (!Array.isArray(rows)) return undefined;
  return rows.find((m) => typeof m.user_id === "number")?.user_id;
}

/**
 * One-paragraph operator warning for a rejected key, shared by the
 * stdio and HTTP entries so both say the same thing in the same words.
 */
export function keyRejectedWarning(): string {
  return (
    "Loomio rejected the connector's API key (GET /api/b2/groups answered 403 with Loomio's " +
    "unauthenticated body). The key has almost certainly been ROTATED: Loomio regenerates a " +
    "user's API key whenever that user's password changes, and Loomio 3.3.1 rotated every key " +
    "once on upgrade. Every tool call will fail with a clear 403 until the key is replaced. " +
    "To fix: sign in to Loomio as the connector's user, copy the current key from the API access " +
    "page (/profile/api_access), update LOOMIO_API_KEY (or the deployment secret) and restart. " +
    "The server keeps running so the failure is visible on /health and in tool errors rather " +
    "than as a dead process."
  );
}
