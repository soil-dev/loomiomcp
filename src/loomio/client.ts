import { fetch, type Response } from "undici";
import { readBool } from "../env.js";
import { logEvent, redactPath } from "../log.js";

const DEFAULT_BASE_URL = "https://www.loomio.com/api";

/**
 * The Loomio API base URL. Defaults to the production endpoint;
 * override with `LOOMIO_API_BASE_URL` for testing or self-hosted
 * instances. Read at call time so tests can stub it.
 *
 * Validation: the override MUST be either https:// or http:// pointed
 * at a loopback host. Loomio's auth is an API key passed as a query
 * parameter; sending it to an arbitrary http:// host would exfiltrate
 * it in the URL itself (worse than a header — URLs land in access
 * logs). The validation here is defence-in-depth on top of operator
 * hygiene.
 */
function baseUrl(): string {
  const override = process.env["LOOMIO_API_BASE_URL"];
  if (!override) return DEFAULT_BASE_URL;
  if (!URL.canParse(override)) {
    throw new LoomioAuthError(
      `LOOMIO_API_BASE_URL is not a valid URL: ${JSON.stringify(override)}`,
    );
  }
  const u = new URL(override);
  const isLocal =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
    throw new LoomioAuthError(
      `LOOMIO_API_BASE_URL must be https:// (or http:// on localhost); got ${u.protocol}//${u.hostname}. Sending the Loomio API key to that URL would expose it.`,
    );
  }
  return override;
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

export class LoomioAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
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

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
  };
}

interface LoomioErrorBody {
  message?: string;
  errors?: Record<string, string[] | string>;
  error?: string;
}

/**
 * Loomio returns errors in a few shapes:
 *   { "error": "..." }
 *   { "message": "..." }
 *   { "errors": { "field": ["message", ...] } }   (validation errors)
 * Format into a single human-readable string.
 */
async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as LoomioErrorBody;

    if (body.errors && typeof body.errors === "object") {
      const parts: string[] = [];
      for (const [field, msgs] of Object.entries(body.errors)) {
        const msg = Array.isArray(msgs) ? msgs.join(", ") : String(msgs);
        parts.push(`${field}: ${msg}`);
      }
      if (parts.length > 0) return parts.join("; ");
    }

    if (body.message) return body.message;
    if (body.error) return body.error;

    return res.statusText;
  } catch {
    return res.statusText;
  }
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

async function throwForStatus(res: Response): Promise<void> {
  if (res.status === 401 || res.status === 403) {
    const detail = await parseErrorBody(res);
    const detailStr = String(detail ?? "").trim();
    let pathHint = "the requested resource";
    try {
      pathHint = redactPath(new URL(res.url).pathname);
    } catch {
      // res.url unavailable / unparseable — keep the generic hint.
    }
    // Loomio returns a bare `{"error":403}` (no descriptive body) for
    // BOTH an invalid key and a valid key whose user lacks the role a
    // resource needs. So don't pin the blame on the key alone — name
    // both causes. Tools that know a resource is role-gated (e.g.
    // list_memberships) catch this and refine it via an access probe;
    // see src/loomio/access.ts.
    const detailSuffix = detailStr && detailStr !== String(res.status) ? `: ${detailStr}` : "";
    throw new LoomioAuthError(
      `Loomio API returned ${res.status} for ${pathHint}${detailSuffix}. ` +
        "Loomio sends the same 403 whether the connector's key is invalid/expired OR the key's user " +
        "simply lacks the role this resource requires (some endpoints — e.g. listing a group's members " +
        "— require the group-admin/coordinator role). Verify the key, and that the bot user has the " +
        "needed role on the target group.",
      res.status,
    );
  }
  if (!res.ok) {
    const msg = await parseErrorBody(res);
    throw new LoomioApiError(res.status, `Loomio API error ${res.status}: ${msg}`);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  await throwForStatus(res);
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbortError(err)) timeoutError();
    throw err;
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

interface Auth {
  /** Query-string field name carrying the secret (`api_key` for b2, `b3_api_key` for b3). */
  field: string;
  /** Reads the value at call time so tests / env reloads pick up changes. */
  getValue: () => string;
}

const B2_AUTH: Auth = { field: "api_key", getValue: getApiKey };
const B3_AUTH: Auth = { field: "b3_api_key", getValue: getB3ApiKey };

/**
 * Build a Loomio URL with the auth secret appended as a query
 * parameter. Loomio's public APIs (b2, b3) authenticate via query
 * string (not a Bearer header). The single injection site means
 * every outbound URL goes through one gate and the redaction in
 * `src/log.ts` covers both schemes.
 */
function buildUrl(auth: Auth, path: string, params?: QueryParams): string {
  const url = new URL(`${baseUrl()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  url.searchParams.set(auth.field, auth.getValue());
  return url.toString();
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
 * query string (including api_key) is dropped — the api_key MUST NOT
 * land in logs.
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
  const url = buildUrl(B2_AUTH, path, params);
  const start = await doFetch(url, { headers: baseHeaders() });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}

/**
 * Issue a GET and return ONLY the HTTP status — never throws for an
 * HTTP error status (unlike `loomioGet`, which raises on 4xx/5xx).
 * Network errors and timeouts still throw.
 *
 * This exists for the access classifier (src/loomio/access.ts): when
 * an admin-gated endpoint returns 403, a follow-up probe of a
 * member-gated endpoint with the SAME key tells us whether the key is
 * valid at all (probe 200 → valid, the 403 was about role) or being
 * rejected outright (probe 403 → bad key / not a member). The body is
 * drained so the socket frees and the standard `loomio.request`
 * observability event still fires.
 */
export async function loomioGetStatus(path: string, params?: QueryParams): Promise<number> {
  const url = buildUrl(B2_AUTH, path, params);
  const start = await doFetch(url, { headers: baseHeaders() });
  try {
    return await consumeBody(start, async () => {
      try {
        await start.res.text();
      } catch {
        // Body already consumed / unreadable — we only need the status.
      }
      return start.res.status;
    });
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
  const url = buildUrl(B2_AUTH, path, opts.params);
  const encoding = opts.encoding ?? "json";
  const start = await doFetch(url, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type":
        encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: encoding === "form" ? encodeForm(body) : JSON.stringify(body),
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}

/**
 * POST to a `/b3/...` admin endpoint. b3 uses a different auth secret
 * (`?b3_api_key=…`, validated against `ENV['B3_API_KEY']` on the
 * Loomio server) and is NOT the per-user API key. Caller must have
 * already gated on `hasB3ApiKey()`.
 */
export async function loomioPostB3<T>(path: string, params?: QueryParams): Promise<T> {
  if (isReadOnly()) throw new LoomioReadOnlyError("POST");
  const url = buildUrl(B3_AUTH, path, params);
  const start = await doFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    body: "{}",
  });
  try {
    return await consumeBody(start, () => handleResponse<T>(start.res));
  } finally {
    start.cleanup();
  }
}
