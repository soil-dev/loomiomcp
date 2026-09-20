import { fetch, type Response } from "undici";
import { readBool } from "../env.js";
import { logEvent, redactPath } from "../log.js";
import { VERSION } from "../version.js";
import { getFreshKeyStatus, type LoomioHealth } from "./health-cache.js";

const DEFAULT_BASE_URL = "https://www.loomio.com/api";

/**
 * The Loomio API base URL. Defaults to the production endpoint;
 * override with `LOOMIO_API_BASE_URL` for testing or self-hosted
 * instances. Read at call time so tests can stub it.
 *
 * Validation: the override MUST be either https:// or http:// pointed
 * at a loopback host, and MUST NOT carry userinfo. Every request
 * carries the API key in an `Authorization: Bearer` header; sending
 * that to an arbitrary http:// host would hand the key to anyone on the
 * path. Userinfo is refused here rather than left to undici, whose
 * "cannot be constructed from a URL that includes credentials" error
 * quotes the whole URL — password included — and that message would
 * otherwise travel into the health probe's `detail` and the startup
 * warning. For the same reason none of these messages echo the raw
 * value: an operator pasting a URL with a secret in it gets told what
 * is wrong, not shown the secret back in a log line.
 */
function baseUrl(): string {
  const override = process.env["LOOMIO_API_BASE_URL"];
  if (!override) return DEFAULT_BASE_URL;
  if (!URL.canParse(override)) {
    throw new LoomioAuthError("LOOMIO_API_BASE_URL is not a valid URL.");
  }
  const u = new URL(override);
  if (u.username || u.password) {
    throw new LoomioAuthError(
      "LOOMIO_API_BASE_URL must not contain credentials (user:password@host). Loomio authenticates " +
        "with the Authorization header only; remove the userinfo from the URL.",
    );
  }
  const isLocal =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
    throw new LoomioAuthError(
      `LOOMIO_API_BASE_URL must be https:// (or http:// on localhost); got ${u.protocol}//${u.host}. Sending the Loomio API key to that URL would expose it.`,
    );
  }
  return override;
}

/**
 * Bound an upstream string before it lands in an error message. Loomio's
 * own error strings are short, but the error path also echoes what a
 * CDN or reverse proxy answers — an HTML 502 page runs to several KB —
 * and every message here ends up in an MCP tool result (agent context)
 * and, via `get_user_activity`'s "Last error", inside another message.
 * 200 characters is enough to recognise any catalogued body; the
 * suffix says how much was cut so nobody mistakes the clip for the
 * whole. Matches the cap the health probe applies to its `detail`.
 */
const ERROR_ECHO_MAX = 200;

export function clip(s: string, max: number = ERROR_ECHO_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated, ${s.length} chars]` : s;
}

/**
 * Returns true if the server is configured to refuse all writes.
 * Set LOOMIO_MCP_READONLY to a truthy value (`1` / `true` / `yes`
 * / `on`, case-insensitive) to enable.
 */
export function isReadOnly(): boolean {
  return readBool("LOOMIO_MCP_READONLY");
}

export class LoomioReadOnlyError extends Error {
  constructor(method: string) {
    super(
      `loomiomcp is running in read-only mode (LOOMIO_MCP_READONLY is set). ` +
        `${method} requests are refused. Unset LOOMIO_MCP_READONLY to enable writes.`,
    );
    this.name = "LoomioReadOnlyError";
  }
}

/**
 * Why Loomio (or something in front of it) answered 403. Attached to
 * `LoomioAuthError.kind` so tools can react to the CAUSE rather than
 * pattern-match the message. See `classifyForbidden` for the catalogue.
 */
export type ForbiddenKind =
  | "waf" // a CDN/WAF/reverse proxy answered; the request never reached Loomio
  | "unauthenticated" // Loomio's generic body: no active user owns this key (on the b2 discussions/polls lists: or the group is not visible)
  | "not_authorized" // CanCan authorize!: "Not authorized to <action> <Model>."
  | "not_admin" // memberships#create: "User is not an admin"
  | "plan_limit" // subscription cap: bare {"error":403} or the thread-limit body
  | "unknown"; // a JSON 403 body we have not catalogued

export class LoomioAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly kind?: ForbiddenKind,
  ) {
    super(message);
    this.name = "LoomioAuthError";
  }
}

export class LoomioApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LoomioApiError";
  }
}

function getApiKey(): string {
  const key = process.env["LOOMIO_API_KEY"];
  if (!key) {
    throw new LoomioAuthError(
      "LOOMIO_API_KEY environment variable is not set. " +
        "Generate one in Loomio under your profile → API keys.",
    );
  }
  return key;
}

function getB3ApiKey(): string {
  const key = process.env["LOOMIO_B3_API_KEY"];
  if (!key) {
    throw new LoomioAuthError(
      "LOOMIO_B3_API_KEY environment variable is not set. " +
        "The b3 admin endpoints require a server-instance secret (ENV['B3_API_KEY'] " +
        "on the Loomio server, >16 chars). Only Loomio instance operators have this.",
    );
  }
  return key;
}

export function hasB3ApiKey(): boolean {
  return Boolean(process.env["LOOMIO_B3_API_KEY"]);
}

/**
 * The connector identifies itself on every outbound request. Two
 * reasons: a CDN/WAF in front of a Loomio instance (Cloudflare is
 * common) blocks generic library User-Agents outright — undici's
 * default is one of them — with a 403 that never reaches Loomio; and an
 * explicit UA lets instance operators pick the connector out of
 * Loomio's request logs when they audit API traffic.
 */
export const USER_AGENT = `loomiomcp/${VERSION}`;

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

interface LoomioErrorBody {
  message?: string;
  errors?: Record<string, string[] | string>;
  error?: string | number;
  flash?: { error?: string };
  action?: string;
  type?: string;
  title?: string;
}

/**
 * Read the error body as text, once. Loomio's API errors are JSON, but
 * the two intermediaries that matter — Rack::Attack's 429 and a
 * CDN/WAF's 403 — are text/plain or HTML, so the error path reads raw
 * text and lets each classifier decide how to parse it. Returns "" when
 * the body is unreadable (already consumed, aborted, …).
 */
async function readErrorText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch (err) {
    if (isAbortError(err)) timeoutError();
    return "";
  }
}

function tryParseJson(text: string): LoomioErrorBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LoomioErrorBody)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loomio returns errors in a few shapes:
 *   { "error": "..." }
 *   { "message": "..." }
 *   { "errors": { "field": ["message", ...] } }   (validation errors)
 * Format into a single human-readable string; fall back to the raw
 * text (or the status text when there is none). Every echo of upstream
 * text goes through `clip`: a non-JSON body here is a proxy's or CDN's
 * error page, not Loomio, and can be arbitrarily large.
 */
function formatErrorBody(text: string, statusText: string): string {
  const body = tryParseJson(text);
  if (!body) return text ? clip(text) : statusText;

  if (body.errors && typeof body.errors === "object") {
    const parts: string[] = [];
    for (const [field, msgs] of Object.entries(body.errors)) {
      const msg = Array.isArray(msgs) ? msgs.join(", ") : String(msgs);
      parts.push(`${field}: ${msg}`);
    }
    if (parts.length > 0) return clip(parts.join("; "));
  }

  if (body.message) return clip(body.message);
  if (body.error !== undefined && body.error !== null) return clip(String(body.error));

  return text ? clip(text) : statusText;
}

const REQUEST_TIMEOUT_MS = 60_000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

function timeoutError(): never {
  throw new LoomioApiError(
    504,
    `Loomio API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The Loomio API may be slow or hung; retry after a short wait.`,
  );
}

interface FetchResult {
  res: Response;
  cleanup: () => void;
}

/**
 * Run `fetch` with a hard timeout. Any AbortError surfaced from
 * either the request itself or the subsequent body read maps to a
 * single 504 `LoomioApiError`. Caller owns calling `cleanup()` after
 * the response is consumed so a long-running body read can keep
 * holding the timer; if the timer fires, the body read also aborts.
 */
async function fetchWithTimeout(
  url: string,
  options: Parameters<typeof fetch>[1],
): Promise<FetchResult> {
  const hasCallerSignal = !!options && (options as { signal?: AbortSignal }).signal !== undefined;
  const controller = hasCallerSignal ? undefined : new AbortController();
  const timer = controller && setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer?.unref();
  const cleanup = () => {
    if (timer) clearTimeout(timer);
  };
  const opts = controller ? { ...(options ?? {}), signal: controller.signal } : (options ?? {});
  try {
    const res = await fetch(url, opts);
    return { res, cleanup };
  } catch (err) {
    cleanup();
    if (isAbortError(err)) timeoutError();
    throw err;
  }
}

// ── 403 classification ──────────────────────────────────────────────────────
//
// Loomio's b2 API answers 403 in a small, distinguishable set of body
// shapes (all JSON — every Loomio 403 comes out of `render json:` in
// Api::V1::SnorlaxBase), plus whatever a CDN/WAF in front of the
// instance says when it refuses the request before Loomio sees it:
//
//   {"error":"You are not authorized to access this page."}
//       CanCan's default message for a bare `raise CanCan::AccessDenied`
//       (Loomio's server.en.yml defines no `unauthorized.default`). Three
//       raisers in b2, and WHICH ones can fire depends on the path:
//         - `authenticate_api_key!` (prepend_before_action on every b2
//           controller) — no ACTIVE user owns the bearer key. Possible on
//           every b2 path; the only cause on most of them.
//         - `records_visible_in_group` — called ONLY from
//           DiscussionsController#index and PollsController#index
//           (GET /b2/discussions?group_id=, GET /b2/polls?group_id=)
//           when the group is not visible to the key's user. NOT from
//           MembershipsController#index, which scopes by
//           `MembershipQuery.visible_to` and answers a non-member 200
//           with an empty list; NOT from any show/:id action, which uses
//           `load_and_authorize` and produces the message-bearing body.
//         - CommentsController#create when the comment has no parent
//           (neither parent_id nor discussion_id) — the connector always
//           sends discussion_id, so it does not arise from here.
//         - PollService.invite, reached from PollsController#create AFTER
//           the poll was saved, for an anonymous poll that is not active
//           (`anonymous: true` forces voting_system anonymous_ballot; no
//           future closing_at means not active). The one bare raiser a
//           valid key can hit on a write from this connector.
//         - Api::B3::UsersController#authenticate_api_key! on every /b3/
//           path — the bearer did not `secure_compare` to the Loomio
//           server's ENV['B3_API_KEY'], or that variable is unset / 16
//           characters or shorter. A DIFFERENT secret from the per-user
//           key (LOOMIO_B3_API_KEY: no per-user page to copy it from, no
//           relation to the /health verdict), and b3 never calls
//           `authorize!`, so on a b3 path this is the only 403 there is.
//       So the body means "unauthenticated" everywhere, and additionally
//       "group not visible" on the two visibility-gated lists only —
//       their GET index; #create on the same paths goes through the
//       service's `authorize!`, whose refusal carries a message.
//       `classifyForbidden` is path- AND method-aware for exactly this
//       reason: on /b2/memberships (or a show path, or a POST) it must
//       not send the operator off to check group visibility when the key
//       is the problem, and on /b3/ it must name the b3 secret.
//   {"error":"Not authorized to <action> <Model>."}
//       CanCan `authorize!` with a message (unauthorized.manage.all): the
//       key is fine, the user lacks permission for that action/record.
//   {"error":"User is not an admin"}
//       memberships#create's own check: the user is not an admin
//       (coordinator) of THAT group. Parent-group admin and instance
//       is_admin do not count.
//   {"error":403}
//       `respond_with_standard_error` for Subscription::MaxMembersExceeded
//       — the instance's plan caps members.
//   {"error":"…thread limit…","action":"upgrade"}
//       respond_with_thread_limit_reached — the plan caps threads.
//   non-JSON, or a JSON problem body whose "type" URL mentions cloudflare
//       Not Loomio. Cloudflare's "Error 1010: Access denied" is the one
//       seen in practice (it blocks default library User-Agents); an
//       HTML page from any reverse proxy lands here too.
//
// The catalogue is exact as of Loomio 3.8.1 (snorlax_base.rb,
// authenticates_api_key.rb, b2/base_controller.rb, b2/memberships_controller.rb).

export interface ForbiddenContext {
  /** Redacted path of the failing request, for the message and to decide which raisers apply. */
  path?: string;
  /**
   * HTTP method of the failing request. Decides whether a path that is
   * a visibility-gated list on GET (`/b2/discussions`, `/b2/polls`) was
   * hit as such or as a write: `create_discussion` / `create_poll` POST
   * to the very same paths, and #create never consults group
   * visibility. Missing means GET.
   */
  method?: string;
  /**
   * The key-health probe's verdict ONLY when it is fresh (younger than
   * `HEALTH_CACHE_TTL_MS`); `undefined` otherwise. Callers must not pass
   * a stale verdict: a `valid` from hours ago says nothing about a key
   * rotated since, and the message would then blame group visibility
   * for what is a dead key (see `getFreshKeyStatus`).
   */
  keyStatus?: LoomioHealth["key_status"];
}

export interface ForbiddenClassification {
  kind: ForbiddenKind;
  message: string;
}

const GENERIC_UNAUTHENTICATED = /^you are not authorized to access this page\.?$/i;

/**
 * The two b2 collection routes whose index goes through
 * `records_visible_in_group` and can therefore answer the generic body
 * for a valid key when the group is not visible. Matched on the
 * redacted path's tail so both `/api/b2/polls` (from the HTTP layer)
 * and `/b2/polls` (from tests) qualify, and a show path such as
 * `/b2/polls/:id` does not. GET only: a POST to the same path is
 * #create, whose refusals come from the service's `authorize!` with a
 * message, so the generic body on a write is the key and nothing else.
 */
const VISIBILITY_GATED_LIST = /\/b2\/(discussions|polls)$/;

function isVisibilityGatedList(path: string | undefined, method: string | undefined): boolean {
  return (
    path !== undefined &&
    (method ?? "GET").toUpperCase() === "GET" &&
    VISIBILITY_GATED_LIST.test(path)
  );
}

/** `POST /b2/polls` — the one write where a bare `CanCan::AccessDenied` is reachable with a valid key. */
function isPollCreate(path: string | undefined, method: string | undefined): boolean {
  return (
    path !== undefined && (method ?? "GET").toUpperCase() === "POST" && /\/b2\/polls$/.test(path)
  );
}

/**
 * Loomio's b3 Server API. Authenticates with the server-instance secret
 * (`LOOMIO_B3_API_KEY` ↔ `ENV['B3_API_KEY']`), never with the per-user
 * key, so nothing the health probe learned about the b2 key applies.
 */
function isB3Path(path: string | undefined): boolean {
  return path !== undefined && /\/b3\//.test(path);
}

/** Loomio's v1 (browser) API resolves its user from the session cookie only; the key is not evaluated. */
function isV1Path(path: string | undefined): boolean {
  return path !== undefined && /\/v1\//.test(path);
}

const KEY_REMEDIATION =
  "A rejected key is almost always a ROTATED key: Loomio regenerates a user's API key whenever " +
  "that user's password changes (and Loomio 3.3.1 rotated every key once, on upgrade). " +
  "To check: GET /health on this connector (HTTP transport), or GET /api/b2/groups on the Loomio " +
  "instance with the key as `Authorization: Bearer` — 200 means the key is valid. To fix: sign in " +
  "to Loomio as the connector's user, copy the current key from the API access page " +
  "(/profile/api_access), and update LOOMIO_API_KEY / the deployment secret. No API can read " +
  "another user's key.";

/**
 * Turn a 403 response body into an explanation of WHY the request was
 * refused. Pure (no I/O) so each body shape is unit-testable; the HTTP
 * path passes the redacted request path and the health cache's verdict
 * so the message can be as definite as the evidence allows.
 */
export function classifyForbidden(
  body: string,
  opts: ForbiddenContext = {},
): ForbiddenClassification {
  const where = opts.path ?? "the requested resource";
  const text = body.trim();
  const json = tryParseJson(text);

  // (1) Not a Loomio response: Loomio's 403s are always JSON. A JSON
  // problem body pointing at cloudflare is Cloudflare's WAF; anything
  // non-JSON (HTML error page, plain text) is some other intermediary.
  const cfType = typeof json?.type === "string" && /cloudflare/i.test(json.type);
  if (!json || cfType) {
    const title = cfType && typeof json?.title === "string" ? clip(json.title) : undefined;
    const label = title ? `Cloudflare: ${title}` : text ? "non-JSON body" : "empty body";
    return {
      kind: "waf",
      message:
        `HTTP 403 for ${where} was answered by a CDN/WAF in front of Loomio (${label}), not by ` +
        "Loomio itself — this is not a Loomio permissions error and says nothing about the API key. " +
        `The connector sends \`User-Agent: ${USER_AGENT}\`; check the WAF's rules (bot-fight / ` +
        "User-Agent / IP / ASN rules) and allow this connector's traffic through.",
    };
  }

  const error = json.error;
  const errorText = typeof error === "string" ? error.trim() : "";

  // (2a) Generic CanCan message on a b3 path. `Api::B3::UsersController#
  // authenticate_api_key!` `secure_compare`s the bearer against the
  // Loomio server's ENV['B3_API_KEY'] and raises a bare AccessDenied —
  // the same body as b2's unauthenticated response — when they differ OR
  // when that variable is unset / 16 characters or shorter. The
  // controller never calls `authorize!`, so on b3 the generic body has
  // exactly one meaning, and it is about LOOMIO_B3_API_KEY. The health
  // probe tests LOOMIO_API_KEY against GET /b2/groups, a different
  // credential, so `keyStatus` must not colour this message either way:
  // a fresh `valid` would claim a rotation that did not happen, a fresh
  // `rejected` would blame the wrong secret.
  if (isB3Path(opts.path) && GENERIC_UNAUTHENTICATED.test(errorText)) {
    return {
      kind: "unauthenticated",
      message:
        `Loomio returned 403 for ${where}: "${errorText}". Loomio's b3 Server API rejected the bearer ` +
        "secret: LOOMIO_B3_API_KEY does not match ENV['B3_API_KEY'] on the Loomio server, or that " +
        "variable is unset or 16 characters or shorter there (Loomio then refuses every b3 call). " +
        "This is independent of the per-user LOOMIO_API_KEY, of password rotation and of the /health " +
        "verdict — those concern the b2 API only — and there is no per-user page for the b3 secret. " +
        "Compare LOOMIO_B3_API_KEY with the value the Loomio instance operator configured and fix the " +
        "deployment secret.",
    };
  }

  // (2) Generic CanCan message. Unauthenticated on every b2 path; on the
  // two visibility-gated lists (GET b2/discussions, GET b2/polls) ALSO
  // "group not visible". Everywhere else — b2/memberships, every show/:id
  // path, writes (including POSTs to those two list paths) — Loomio
  // produces this body from `authenticate_api_key!` and nothing else
  // (one named exception on POST /b2/polls), so there the message must
  // not hedge towards visibility.
  if (GENERIC_UNAUTHENTICATED.test(errorText)) {
    const quoted = `Loomio returned 403 for ${where}: "${errorText}".`;
    if (opts.keyStatus === "rejected") {
      return {
        kind: "unauthenticated",
        message:
          `Loomio rejected the connector's API key (HTTP 403 for ${where}, and the connector's own ` +
          `key-health probe against GET /api/b2/groups is failing the same way). ${KEY_REMEDIATION}`,
      };
    }
    if (isVisibilityGatedList(opts.path, opts.method)) {
      const visibilityNote =
        "On this ?group_id= list endpoint the same body is also returned when the target group is " +
        "not visible to the connector's user (a private group it is not a member of), even with a " +
        "perfectly valid key.";
      if (opts.keyStatus === "valid") {
        return {
          kind: "unauthenticated",
          message:
            `${quoted} The connector's key passed a key-health probe within the last minute, so this ` +
            `is most likely a visibility problem, not a key problem. ${visibilityNote} Check the group ` +
            "id and whether the connector's user is a member. If /health now reports key_status " +
            `"rejected", the key was rotated in between. ${KEY_REMEDIATION}`,
        };
      }
      return {
        kind: "unauthenticated",
        message:
          `${quoted} This is Loomio's UNAUTHENTICATED response — no active user owns the bearer key ` +
          `the connector sent. Most often the key was rotated. ${visibilityNote} ${KEY_REMEDIATION}`,
      };
    }
    // Not a visibility-gated list: the key is the only thing Loomio
    // checks before producing this body on this path — except on
    // POST /b2/polls, where PollService.invite raises the same bare
    // AccessDenied for an anonymous poll that is not active, after
    // PollService.create has already saved the poll. Named so the
    // caller checks for a half-created poll instead of rotating a key.
    const pollCreateCaveat = isPollCreate(opts.path, opts.method)
      ? " One exception on this endpoint: an anonymous poll (`anonymous: true`) with no future " +
        "`closing_at` also produces this body, from PollService.invite, AFTER the poll itself was " +
        "saved — check whether the poll now exists before retrying, and give anonymous polls a closing_at."
      : "";
    const onlyCause =
      "On this endpoint Loomio produces this body only when no active user owns the bearer key " +
      "(b2/memberships answers a non-member 200 with an empty list, and record reads answer " +
      '"Not authorized to <action> <Model>." instead), so this is not a visibility or role problem.' +
      pollCreateCaveat;
    if (opts.keyStatus === "valid") {
      return {
        kind: "unauthenticated",
        message:
          `${quoted} ${onlyCause} The connector's key passed a key-health probe within the last ` +
          "minute, so it was most likely rotated in between — re-check /health (or GET /api/b2/groups " +
          `with the key). ${KEY_REMEDIATION}`,
      };
    }
    return {
      kind: "unauthenticated",
      message:
        `${quoted} This is Loomio's UNAUTHENTICATED response — the API key was rejected. ${onlyCause} ` +
        `Most often the key was rotated. ${KEY_REMEDIATION}`,
    };
  }

  // (3) CanCan authorize! with a message — the key is valid, the user
  // lacks permission for this action or record. On a v1 (browser API)
  // path the key was never evaluated, so the message must not vouch
  // for it there: v1 authorizes a session-less caller as logged out.
  if (/^not authorized to /i.test(errorText)) {
    const explanation = isV1Path(opts.path)
      ? "Loomio's v1 (browser) API does not evaluate the API key, so this says nothing about it: " +
        "the record is not visible to a caller without a browser session. Check whether the record " +
        "is public."
      : "The API key is valid; the connector's user lacks permission for this action or record " +
        "(Loomio's per-record authorization). Check the record id and the connector user's role or " +
        "membership on its group.";
    return {
      kind: "not_authorized",
      message: `Loomio returned 403 for ${where}: "${clip(errorText)}". ${explanation}`,
    };
  }

  // (4) memberships#create's admin check.
  if (/^user is not an admin$/i.test(errorText)) {
    return {
      kind: "not_admin",
      message:
        `Loomio returned 403 for ${where}: "${errorText}". Managing a group's memberships requires ` +
        "the group admin (coordinator) role ON THAT GROUP for the connector's user — being an admin " +
        "of the parent group, or an instance admin, does not count. A coordinator of the group can " +
        "grant it (the group → Members → the connector's user → Make coordinator).",
    };
  }

  // (5) Subscription / plan caps: a bare numeric body, or the
  // thread-limit body carrying `action: "upgrade"`.
  if (typeof error === "number" || json.action === "upgrade") {
    const detail = errorText ? `: "${clip(errorText)}"` : "";
    return {
      kind: "plan_limit",
      message:
        `Loomio returned 403 for ${where}${detail}. This is a Loomio subscription/plan limit ` +
        "(member or thread cap on the instance's plan), not an authentication or role problem. " +
        "The instance operator or group owner must upgrade the plan or free up capacity.",
    };
  }

  // (6) Something we have not catalogued — surface the body (clipped).
  return {
    kind: "unknown",
    message:
      `Loomio returned 403 for ${where}: ${clip(text)}. This body is not one the connector recognises; ` +
      "treat it as a Loomio permission refusal and check the connector user's access to the record.",
  };
}

/**
 * Loomio answers 429 in two shapes. Rack::Attack's global throttle
 * (`config/initializers/rack_attack.rb`: one bucket per client IP over a
 * 5-minute window, 900 × RACK_ATTACK_RATE_MULTIPLIER requests) returns
 * text/plain "Retry later" and, only if the instance enabled it, a
 * Retry-After header. The invitation throttle (ThrottleService) returns
 * JSON `{"flash":{"error":"Daily invitation limit reached…"}}`.
 */
function rateLimitedMessage(text: string, res: Response, where: string): string {
  const json = tryParseJson(text);
  const flash = json?.flash?.error;
  if (typeof flash === "string" && flash) {
    return `Loomio refused the request (HTTP 429 for ${where}): ${flash}`;
  }
  const retryAfter = res.headers.get("retry-after");
  const wait = retryAfter
    ? `Retry after ${retryAfter}${/^\d+$/.test(retryAfter) ? " seconds" : ""} (Retry-After header).`
    : "No Retry-After header was sent; wait a few minutes before retrying.";
  return (
    `Loomio rate limit hit (HTTP 429 for ${where}). Loomio's Rack::Attack throttle caps requests ` +
    "per client IP over a 5-minute window (900 by default; instances may raise it). " +
    `${wait} Fan-out tools — list_groups' id probe and get_user_activity — are the usual cause: ` +
    "narrow the id range or group set, or space calls out." +
    (text && !json ? ` Loomio said: ${clip(text)}` : "")
  );
}

/**
 * 401 never comes from the namespaces the connector authenticates
 * against: Loomio's b2 and b3 controllers raise `CanCan::AccessDenied`
 * for every authentication failure, which `Api::V1::SnorlaxBase`
 * renders as 403 with a JSON body (see `classifyForbidden`). A 401 on a
 * b2/b3 path therefore came from something between us and Loomio that
 * wants credentials of its own. Loomio's v1 (browser) API is different:
 * `Api::V1::RestfulController#require_current_user` renders
 * `{"error":"you gotta be signed in"}` with 401, and v1 resolves its
 * user from the session cookie only — the API key is not a v1
 * credential. The connector's v1 calls today (groups#show,
 * boot#version) carry no such guard, but the message must not claim
 * "never Loomio" for a namespace that does say 401.
 */
function unauthorizedMessage(text: string, where: string, url: string): string {
  const upstream = text ? ` Upstream said: ${clip(text)}` : "";
  let isV1 = false;
  try {
    isV1 = /\/v1\//.test(new URL(url).pathname);
  } catch {
    // Unparseable URL: fall through to the b2/b3 wording.
  }
  if (isV1) {
    return (
      `HTTP 401 for ${where}. This is a Loomio v1 (browser API) path; Loomio itself answers 401 ` +
      "there when the endpoint requires a signed-in browser session, which the connector's API key " +
      "cannot provide (v1 does not read the key). If the response did not come from Loomio, a " +
      "reverse proxy, CDN or basic-auth gate in front of it wants its own credentials — check " +
      `LOOMIO_API_BASE_URL and the deployment's proxy configuration.${upstream}`
    );
  }
  return (
    `HTTP 401 for ${where}. Loomio's b2/b3 API answers its own authentication failures with 403 ` +
    "and a JSON body, never 401, so this response came from something in front of Loomio — a " +
    "reverse proxy, CDN or basic-auth gate that wants its own credentials. Check " +
    "LOOMIO_API_BASE_URL and the deployment's proxy configuration; the Loomio API key was never " +
    `evaluated.${upstream}`
  );
}

/**
 * Redacted path for error messages, from the URL we REQUESTED (not
 * `res.url`, which undici fills but a test double may not). Ids become
 * `:id` and the query string is dropped, so the message never carries a
 * specific record id or parameter into a client transcript or log.
 */
function pathHintFor(url: string): string {
  try {
    return redactPath(new URL(url).pathname);
  } catch {
    return "the requested resource";
  }
}

async function throwForStatus(res: Response, url: string, method?: string): Promise<void> {
  if (res.ok) return;
  const text = await readErrorText(res);
  const where = pathHintFor(url);

  if (res.status === 403) {
    // Only a FRESH health verdict may colour the message. A stale
    // `valid` (startup probe, days ago, nothing re-probing under stdio)
    // would otherwise turn every post-rotation 403 into "not a key
    // problem" — the opposite of what this classification is for. The
    // method travels too, so a POST to a list path is not read as the
    // visibility-gated GET index (and b3 paths ignore the verdict).
    const { kind, message } = classifyForbidden(text, {
      path: where,
      method,
      keyStatus: getFreshKeyStatus(),
    });
    throw new LoomioAuthError(message, 403, kind);
  }
  if (res.status === 401) {
    // An authentication failure (so callers treat it like one:
    // propagate, never "soft-miss" it), but not one of Loomio's 403
    // catalogue — hence no `ForbiddenKind`. See `unauthorizedMessage`.
    throw new LoomioAuthError(unauthorizedMessage(text, where, url), 401);
  }
  if (res.status === 429) {
    throw new LoomioApiError(429, rateLimitedMessage(text, res, where));
  }
  throw new LoomioApiError(
    res.status,
    `Loomio API error ${res.status}: ${formatErrorBody(text, res.statusText)}`,
  );
}

async function handleResponse<T>(res: Response, url: string, method?: string): Promise<T> {
  await throwForStatus(res, url, method);
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbortError(err)) timeoutError();
    throw err;
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

/** Reads a credential at call time so tests / env reloads pick it up. */
type Auth = () => string;

const B2_AUTH: Auth = getApiKey;
const B3_AUTH: Auth = getB3ApiKey;

/**
 * Build a Loomio URL. Carries no secret: as of Loomio's 2026-07
 * change, both b2 and b3 authenticate via `Authorization: Bearer` and
 * API keys in the query string are REJECTED (the request is treated as
 * unauthenticated and 403s). See `authHeaders`.
 */
function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(`${baseUrl()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * Base headers plus the bearer credential for one API namespace. This
 * is the single auth-injection site: b2 sends the per-user API key,
 * b3 the server-instance secret, both as `Authorization: Bearer …`.
 *
 * The value is read here (not at module load) so a missing env var
 * raises `LoomioAuthError` on the call that needs it, and so tests can
 * swap keys between cases.
 */
function authHeaders(auth: Auth): Record<string, string> {
  return {
    ...baseHeaders(),
    Authorization: `Bearer ${auth()}`,
  };
}

interface RequestStart {
  res: Response;
  cleanup: () => void;
  startedAt: number;
  method: string;
  url: string;
}

async function doFetch(url: string, options: Parameters<typeof fetch>[1]): Promise<RequestStart> {
  const startedAt = Date.now();
  const method = (options?.method as string | undefined) ?? "GET";
  const first = await fetchWithTimeout(url, options);
  return { ...first, startedAt, method, url };
}

async function consumeBody<T>(start: RequestStart, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    emitLoomioRequest(start.method, start.url, start.res, Date.now() - start.startedAt);
  }
}

/**
 * Emit a `loomio.request` event for one outbound Loomio API call.
 * Path goes through `redactPath` so numeric IDs become `:id` and the
 * query string is dropped. The API key travels in the `Authorization`
 * header (never in a URL since 0.0.9) and headers are never logged;
 * dropping the query keeps incidental parameters such as `group_id`
 * out of logs as well.
 */
function emitLoomioRequest(method: string, url: string, res: Response, durationMs: number): void {
  let path = "";
  try {
    path = redactPath(new URL(url).pathname);
  } catch {
    path = "?";
  }
  const lenHeader = res.headers.get("content-length");
  const responseBytes = lenHeader ? Number.parseInt(lenHeader, 10) : 0;
  logEvent("loomio.request", {
    method,
    path,
    status: res.status,
    durationMs,
    responseBytes: Number.isFinite(responseBytes) ? responseBytes : 0,
  });
}

export async function loomioGet<T>(path: string, params?: QueryParams): Promise<T> {
  const url = buildUrl(path, params);
  const start = await doFetch(url, { headers: authHeaders(B2_AUTH) });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res, start.url, start.method));
  } finally {
    start.cleanup();
  }
}

export interface RawResponse {
  status: number;
  /** Body as text, "" when unreadable. */
  text: string;
}

async function drainText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    // Body already consumed / unreadable — callers only need what they can get.
    return "";
  }
}

/**
 * Issue an authenticated (b2) GET and return the raw status + body
 * text — never throws for an HTTP error status (unlike `loomioGet`,
 * which raises on 4xx/5xx). Network errors, timeouts and configuration
 * errors (missing key, bad base URL) still throw.
 *
 * This is the primitive under the key-health probe (src/loomio/health.ts):
 * it needs the status to decide valid/rejected AND the body to tell a
 * Loomio 403 from a CDN/WAF 403 that never reached Loomio. The body is
 * always drained so the socket frees and the standard `loomio.request`
 * observability event still fires.
 */
export async function loomioGetRaw(path: string, params?: QueryParams): Promise<RawResponse> {
  const url = buildUrl(path, params);
  const start = await doFetch(url, { headers: authHeaders(B2_AUTH) });
  try {
    return await consumeBody(start, async () => ({
      status: start.res.status,
      text: await drainText(start.res),
    }));
  } finally {
    start.cleanup();
  }
}

/**
 * Issue an authenticated GET and return ONLY the HTTP status — never
 * throws for an HTTP error status. Thin wrapper over `loomioGetRaw`
 * for callers that want a yes/no probe without looking at the body.
 */
export async function loomioGetStatus(path: string, params?: QueryParams): Promise<number> {
  return (await loomioGetRaw(path, params)).status;
}

/**
 * Issue an UNAUTHENTICATED GET — no `Authorization` header at all — and
 * return the raw status + body. For Loomio's public endpoints only
 * (today: GET /v1/boot/version, which the health probe reads for the
 * instance's version). Deliberately not sending the key means a probe
 * of a public endpoint can never leak the credential to an endpoint
 * that does not need it, and the result says nothing about the key.
 * Same timeout, User-Agent and `loomio.request` event as every other call.
 */
export async function loomioGetPublic(path: string, params?: QueryParams): Promise<RawResponse> {
  const url = buildUrl(path, params);
  const start = await doFetch(url, { headers: baseHeaders() });
  try {
    return await consumeBody(start, async () => ({
      status: start.res.status,
      text: await drainText(start.res),
    }));
  } finally {
    start.cleanup();
  }
}

function encodeForm(body: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) u.append(`${k}[]`, String(item));
    } else {
      u.append(k, String(v));
    }
  }
  return u.toString();
}

export interface PostOptions {
  params?: QueryParams;
  /**
   * Body wire format. Defaults to "json". Use "form" when Loomio's
   * b2 controllers reject JSON bodies due to Rails' wrap_parameters
   * doubly-wrapping the payload (observed on `/b2/comments` — see
   * NOTES-ON-LOOMIO-API.md).
   */
  encoding?: "json" | "form";
}

export async function loomioPost<T>(
  path: string,
  body: Record<string, unknown>,
  opts: PostOptions = {},
): Promise<T> {
  if (isReadOnly()) throw new LoomioReadOnlyError("POST");
  const url = buildUrl(path, opts.params);
  const encoding = opts.encoding ?? "json";
  const start = await doFetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(B2_AUTH),
      "Content-Type":
        encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: encoding === "form" ? encodeForm(body) : JSON.stringify(body),
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res, start.url, start.method));
  } finally {
    start.cleanup();
  }
}

/**
 * POST to a `/b3/...` admin endpoint. b3 uses the same bearer scheme
 * as b2 but a different secret — validated against `ENV['B3_API_KEY']`
 * on the Loomio server, NOT the per-user API key. Caller must have
 * already gated on `hasB3ApiKey()`.
 */
export async function loomioPostB3<T>(path: string, params?: QueryParams): Promise<T> {
  if (isReadOnly()) throw new LoomioReadOnlyError("POST");
  const url = buildUrl(path, params);
  const start = await doFetch(url, {
    method: "POST",
    headers: { ...authHeaders(B3_AUTH), "Content-Type": "application/json" },
    body: "{}",
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res, start.url, start.method));
  } finally {
    start.cleanup();
  }
}
