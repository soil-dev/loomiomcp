/**
 * Which generation of Loomio's API paths to talk to.
 *
 * Loomio 3.14.0 (81fbad246) versioned its two integration APIs: the
 * per-user API moved from `/api/b2` to `/api/user0` and the server API
 * from `/api/b3` to `/api/server0` ("the number increases when a
 * release breaks one of these APIs", deploy/UPGRADING.md). The old
 * paths still answer — routes.rb mounts the same controllers under
 * both — but Loomio's release notes say they "will be removed in a
 * later release", and `/api/b2` is not merely an alias: a before/after
 * filter (`Api::User0::LegacyB2Fields`) rewrites poll field names on
 * that path back to the pre-3.14 vocabulary. So the path chosen decides
 * the wire dialect of every poll read and write (src/loomio/poll-fields.ts).
 *
 * The decision is made from the Loomio version the key-health probe
 * reported (`GET /v1/boot/version`, cached in health-cache.ts):
 *
 *   ≥ 3.14.0  → "versioned": `/user0`, `/server0`, current field names
 *   < 3.14.0  → "legacy":    `/b2`, `/b3`, pre-3.14 field names
 *   unknown   → "legacy"
 *
 * "Unknown" means no probe has ever answered with a version (the
 * process just started and Loomio was unreachable, or the public version
 * route is blocked). A version once reported is STICKY (health-cache.ts
 * `getKnownLoomioVersion`): a later probe whose version call fails does
 * not downgrade the dialect, only a probe reporting another version
 * changes it. The legacy paths work on every Loomio release this
 * connector supports — 3.8 through 3.15 — so a request made before the
 * version is known still succeeds; the responses it gets carry the old
 * poll field names, which `modernizePollsIn` folds into the current
 * ones, so a caller never sees the difference. The one thing the legacy
 * path cannot carry is the renamed thread setting (`polls_one_at_a_time`,
 * `attachments_admin_only`: "the compatibility adapter does not
 * translate this thread setting", release notes 3.14.0), which is why
 * the write that sends it calls `resolveApiDialect` (health.ts) — a
 * bounded probe when the version is unknown or older than the health
 * cache's TTL — and refuses, rather than guesses, when it stays unknown.
 *
 * Nothing here talks to the network, so the client, the tools and the
 * probe can all import it.
 */

import { getKnownLoomioVersion } from "./health-cache.js";

export type ApiDialect = "versioned" | "legacy";

/** The first Loomio release with `/api/user0` and `/api/server0`. */
export const VERSIONED_API_SINCE = "3.14.0";

export const USER_API_PREFIX = { versioned: "/user0", legacy: "/b2" } as const;
export const SERVER_API_PREFIX = { versioned: "/server0", legacy: "/b3" } as const;

/**
 * Matches a path on either generation of the user API (`/user0/…`,
 * `/b2/…`) or the server API (`/server0/…`, `/b3/…`), redacted or not
 * (`/api/user0/polls`, `/b2/polls/:id`). For the 403 catalogue and the
 * log redactor, which must recognise both.
 */
export const USER_API_PATH = /\/(?:user0|b2)\//;
export const SERVER_API_PATH = /\/(?:server0|b3)\//;

export function isUserApiPath(path: string | undefined): boolean {
  return path !== undefined && USER_API_PATH.test(path);
}

export function isServerApiPath(path: string | undefined): boolean {
  return path !== undefined && SERVER_API_PATH.test(path);
}

export type SemVer = readonly [number, number, number];

/** `"3.15.0"` → `[3, 15, 0]`; a leading `v` and a suffix (`-rc1`) are tolerated; anything else is `undefined`. */
export function parseVersion(version: string): SemVer | undefined {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function compareVersions(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const VERSIONED_SINCE = parseVersion(VERSIONED_API_SINCE) as SemVer;

/** The dialect a Loomio of this version speaks; "legacy" when the version is unknown or unparseable. */
export function dialectForVersion(version: string | null | undefined): ApiDialect {
  const parsed = version ? parseVersion(version) : undefined;
  return parsed && compareVersions(parsed, VERSIONED_SINCE) >= 0 ? "versioned" : "legacy";
}

/** The dialect for the last Loomio version a key-health probe reported (sticky; see the module note). */
export function apiDialect(): ApiDialect {
  return dialectForVersion(getKnownLoomioVersion());
}

/** True once a probe has reported a Loomio version, i.e. `apiDialect()` is a decision rather than the default. */
export function apiDialectKnown(): boolean {
  return getKnownLoomioVersion() !== undefined;
}

function join(prefix: string, rest: string): string {
  return rest.startsWith("/") ? `${prefix}${rest}` : `${prefix}/${rest}`;
}

/**
 * A user-API path for the current (or given) dialect:
 * `userApiPath("/polls/12")` → `/user0/polls/12` on Loomio ≥ 3.14,
 * `/b2/polls/12` before. `rest` is the part after the namespace.
 */
export function userApiPath(rest: string, dialect: ApiDialect = apiDialect()): string {
  return join(USER_API_PREFIX[dialect], rest);
}

/** A server-API path (`/server0/…` on Loomio ≥ 3.14, `/b3/…` before). */
export function serverApiPath(rest: string, dialect: ApiDialect = apiDialect()): string {
  return join(SERVER_API_PREFIX[dialect], rest);
}
