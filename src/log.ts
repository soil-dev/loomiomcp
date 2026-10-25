/**
 * Structured-event logging for runtime observability.
 *
 * Emits single-line JSON to stderr when `LOOMIO_MCP_LOG_VERBOSE=1`.
 * Cloud Run's logging agent auto-parses single-line JSON written to
 * stderr into structured `jsonPayload` fields, so events become
 * queryable via gcloud logging — e.g.:
 *
 *   gcloud logging read \
 *     'jsonPayload.event="tool.call"' \
 *     --project=<your-gcp-project> --freshness=7d \
 *     --format='value(jsonPayload.tool)' \
 *     | sort | uniq -c | sort -rn | head -20
 *
 *   gcloud logging read \
 *     'jsonPayload.event="loomio.request" AND jsonPayload.status>=400' \
 *     --project=<your-gcp-project> --freshness=24h
 *
 * Why opt-in:
 *
 * The request and tool paths are hot — emitting a log line on every
 * tool call would multiply log volume for every operator, most of
 * whom don't need it. Flipping `LOOMIO_MCP_LOG_VERBOSE=1` on a Cloud
 * Run revision for a few hours, gathering data, then flipping it
 * back is the intended pattern. See OPTIMIZATIONS.md for the
 * canonical recipes that consume these events.
 *
 * Format:
 *
 *   { "event": "tool.call", "tool": "get_discussion", ...fields,
 *     "timestamp": "2026-05-27T09:15:42.123Z" }
 *
 * The `event` field is dotted: "<area>.<verb>". Current areas:
 *
 *   tool.*    — call, chain (per /mcp-request aggregate)
 *   loomio.*  — request (one per outbound Loomio API call);
 *               auth (FORCED: key_status changed — valid / rejected /
 *               unreachable — from the key-health probe, src/loomio/health.ts);
 *               version_drift (FORCED, once: the instance's Loomio
 *               major.minor differs from the version this connector was
 *               tested against); groups_changed (FORCED: the probe saw
 *               the API user's group set, an own admin flag or a group's
 *               privacy change since the previous probe); admin_scope
 *               (FORCED: the API user holds a group-admin membership —
 *               its rosters then carry e-mail addresses upstream)
 *   upstream.* — transport_error (FORCED, at most one per 10 s: a fetch
 *               failed below HTTP — DNS, TLS, reset. Carries the error
 *               `name` and its `code` only, never the message, which
 *               may quote the configured host or a credential)
 *
 * Adding new areas follows the same shape: pick a verb, populate the
 * relevant fields, call logEvent. **Privacy invariants** (load-bearing
 * — also documented in OPTIMIZATIONS.md):
 *
 *   - Tool arguments are logged by field NAME only
 *     (`argFields: ["group_id", "status"]`), never by value. Poll
 *     options, discussion bodies, comment text, member emails stay
 *     out of operator logs.
 *   - Loomio API paths go through `redactPath()` to swap numeric IDs
 *     for `:id` placeholders, and the query string is dropped. The API
 *     key travels in an `Authorization` header, and headers are never
 *     logged.
 *   - Client ids are logged as `clientIdTag()` digests, never verbatim:
 *     in open-DCR mode a client_id carries registrant-chosen text.
 *   - No request / response bodies, ever. This includes the FORCED
 *     events: `loomio.auth` carries a closed-vocabulary `reason` code
 *     (src/loomio/health-cache.ts `HealthReason`), never the probe's
 *     free-text `detail`, which may quote an upstream body fragment or
 *     error message and is reserved for the startup stderr warning.
 *     Nothing logged is ever built from a configured URL either.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readBool } from "./env.js";

/** True when verbose event logging is opted in via env. */
export function logVerbose(): boolean {
  return readBool("LOOMIO_MCP_LOG_VERBOSE");
}

const chainHandlers: Record<
  string,
  (ctx: RequestContext, fields: Record<string, unknown>) => void
> = {
  "tool.call": (ctx, f) => {
    if (typeof f["tool"] === "string") ctx.tools.push(f["tool"] as string);
  },
  "loomio.request": (ctx) => {
    ctx.loomioCalls += 1;
  },
};

/**
 * Emit a structured event to stderr.
 *
 * Default behaviour is gated on `LOOMIO_MCP_LOG_VERBOSE`. The hot
 * paths (`tool.call`, `loomio.request`) only log when explicitly
 * opted in.
 *
 * `opts.force: true` bypasses the gate. Reserved for low-cardinality,
 * uniformly-useful events that operators shouldn't have to flip
 * verbose on to see. Used by the key-health probe (`loomio.auth` on
 * every key_status change, `loomio.version_drift` once): a rotated
 * Loomio key is exactly the failure an operator needs to see without
 * having anticipated it.
 *
 * stderr (not stdout) so the MCP-protocol JSON on stdout for the
 * stdio transport never collides with these. The HTTP transport
 * doesn't use stdout, so the same code path works for both.
 *
 * Side effect: when a `RequestContext` is active (HTTP transport,
 * inside `withRequestContext`), select events feed counters on it via
 * the `chainHandlers` table above. Those counters become the
 * `tool.chain` aggregate emitted on request exit. The counter update
 * runs even when verbose is off — partial chain stats are still
 * accurate when a forced event (e.g. `batch.complete`) fires.
 */
export function logEvent(
  event: string,
  fields: Record<string, unknown>,
  opts: { force?: boolean } = {},
): void {
  const ctx = requestContext.getStore();
  if (ctx) chainHandlers[event]?.(ctx, fields);

  if (!opts.force && !logVerbose()) return;
  process.stderr.write(
    `${JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() })}\n`,
  );
}

/**
 * Replace numeric-ID segments in a Loomio API path with `:id`
 * placeholders, and drop the query string entirely. Used by every
 * event that includes a path (`loomio.request`) so we don't smear
 * specific discussion / poll / user IDs across log aggregators.
 * The query string is dropped wholesale: it no longer carries the API
 * key (that moved to a bearer header in 2026-07), but dropping it keeps
 * incidental parameters out of logs and is cheap insurance.
 *
 * Patterns redacted:
 *   /b2/discussions/254022621        -> /b2/discussions/:id
 *   /b2/polls/abcDEF                 -> /b2/polls/:id  (string short-keys too)
 *   /b2/groups/my-handle             -> /b2/groups/:id (keys and handles too)
 *   /b2/threads/abcDEF/items         -> /b2/threads/:id/items
 *   /b3/users/42/deactivate          -> /b3/users/:id/deactivate
 *   /b3/users/identity/saml/jane@example.org/deactivate
 *                                    -> /b3/users/identity/:type/:uid/deactivate
 *   /b2/discussions/12?api_key=x     -> /b2/discussions/:id
 *   /b2/search?query=budget          -> /b2/search        (the query text never logs)
 *   /b2/reports?group_ids=1,2        -> /b2/reports
 *   /b3/users/deactivate?id=42&b3_api_key=…   -> /b3/users/deactivate
 *
 * Both numeric ids AND alphanumeric short-keys are collapsed. The
 * collection-scoped second pass targets the resources Loomio's
 * ModelLocator addresses by a string in the PATH — `discussions` and
 * `polls` (friendly keys), `groups` (key or handle) and `threads`
 * (topic ids). `users` is deliberately NOT in that list: Loomio's b3
 * user routes take numeric ids only (covered by the first pass, so the
 * member route `/b3/users/42/deactivate` becomes `/b3/users/:id/deactivate`),
 * and including it would also erase the `deactivate` / `reactivate` verb
 * of the legacy collection routes. The b3 IDENTITY routes
 * (`users/identity/:identity_type/:uid`) get their own pass, first: the
 * `uid` is whatever the identity provider issued — frequently an email
 * address — and must never reach a log aggregator.
 */
export function redactPath(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  return (
    noQuery
      // b3 identity routes: the provider uid is personal data.
      .replace(/\/users\/identity\/[^/]+\/[^/]+/g, "/users/identity/:type/:uid")
      // Numeric ids (including comma-separated lists).
      .replace(/\/\d+(?:,\d+)*/g, "/:id")
      // Alphanumeric short-keys / handles after the key-addressable
      // collections. (Runs after the numeric pass, so a numeric id is
      // already `:id` and is left alone.)
      .replace(/\/(discussions|polls|groups|threads)\/[^/]+/g, "/$1/:id")
  );
}

/**
 * The value logged for a client: a 16-character base64url tag of
 * SHA-256(client_id), never the client_id itself.
 *
 * WHY (security review F-13). In open-DCR mode the client_id IS the
 * registrant's signed metadata blob — `client_name` and `redirect_uris`
 * chosen by whoever called /register, up to ~11 KB in v0.0.16 — so
 * logging it verbatim let any caller put free text of its choosing on
 * every `tool.call` / `tool.chain` line and multiply log volume ~20×.
 * The only consumers (usage-report.sh, the OPTIMIZATIONS.md recipes)
 * count DISTINCT values, which a stable digest preserves; 96 bits keep
 * collisions irrelevant at any realistic client count. The field keeps
 * its name so existing queries still group by it.
 */
export function clientIdTag(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("base64url").slice(0, 16);
}

/**
 * Per-`/mcp`-request context: the `tool.chain` aggregate, the upstream
 * budget and the disconnect signal.
 *
 * Lives in an `AsyncLocalStorage` so the chain accumulator is
 * implicit — every `tool.call` and `loomio.request` event lands in
 * the right bucket without threading context objects through every
 * call site. Set up by `withRequestContext` at the top of the
 * `/mcp` handler in `src/http/transport.ts`; read at the end to emit
 * the aggregate event.
 *
 * The same store carries the per-request controls of the security
 * review's F-01 (src/loomio/upstream.ts reads them on every outbound
 * call): `upstreamBudget` caps how many Loomio requests ONE HTTP
 * request may start — a JSON-RPC batch shares one budget, so 100 ×
 * get_user_activity can no longer turn one limiter token into 5,100
 * upstream calls — and `signal` aborts when the HTTP client goes away,
 * so a disconnected request stops fanning out instead of running to
 * completion. `quotaKey` (open-DCR only) is the source-IP bucket of the
 * per-day quotas (F-16).
 *
 * Not active under the stdio transport — stdio is a long-lived
 * connection, not a series of discrete requests, so there's no
 * natural "chain end" to emit on, no per-request budget and no
 * disconnect to observe. `tool.call` and `loomio.request` still fire on
 * stdio; `tool.chain` does not.
 */
export interface RequestContext {
  /** The authenticated client_id (raw; only `clientIdTag` of it is ever logged). */
  clientId?: string;
  tools: string[];
  /** Upstream requests that completed (one per `loomio.request` event). */
  loomioCalls: number;
  /** Upstream requests STARTED — what the budget counts (a request is charged before it is sent). */
  upstreamStarted: number;
  /** Max upstream requests this HTTP request may start; undefined or 0 = no cap. */
  upstreamBudget?: number;
  /** Aborted when the HTTP response closes before the work finished (client disconnect). */
  signal?: AbortSignal;
  /** Source key for the per-day quotas; set only in open-DCR mode. */
  quotaKey?: string;
  /**
   * Source key of every HTTP request (any mode): the upstream
   * semaphore's fairness and the rate window's per-source share key on it
   * (src/loomio/upstream.ts). The address key — or, for an address in
   * MCP_SHARED_EGRESS_CIDRS, `${address}|${clientIdTag}`.
   */
  sourceKey?: string;
  /**
   * Set only when the source is a shared egress address
   * (src/http/shared-egress.ts): the ADDRESS key, on which the aggregate
   * caps (the address's upstream share, 20× the daily quotas) are kept
   * while `sourceKey` / `quotaKey` carry the per-client key.
   */
  sharedEgressKey?: string;
  /** Number of JSON-RPC messages when the POST body was a batch array. */
  batchSize?: number;
  startedAt: number;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with an active RequestContext. Anything within (and any
 * async work it spawns) sees the same context via
 * `getRequestContext()`. The accumulator is populated implicitly by
 * `logEvent` based on event type.
 *
 * On scope exit (resolved or rejected), emits the `tool.chain`
 * aggregate event with the collected stats. Owning the emission here
 * — rather than at the caller — keeps the chain lifecycle in one
 * place and means a caller can never forget to emit. The event fires
 * even if `fn` throws, because partial chains are still useful for
 * diagnosing tool errors.
 */
export function withRequestContext<T>(
  initial: Omit<RequestContext, "tools" | "loomioCalls" | "upstreamStarted" | "startedAt">,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: RequestContext = {
    ...initial,
    tools: [],
    loomioCalls: 0,
    upstreamStarted: 0,
    startedAt: Date.now(),
  };
  return requestContext.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      logEvent("tool.chain", {
        ...(ctx.clientId ? { clientId: clientIdTag(ctx.clientId) } : {}),
        tools: ctx.tools,
        toolCount: ctx.tools.length,
        loomioCalls: ctx.loomioCalls,
        // F-01 (e): how often clients actually send JSON-RPC arrays, so
        // the batch policy can be revisited on data.
        ...(ctx.batchSize !== undefined ? { batchSize: ctx.batchSize } : {}),
        durationMs: Date.now() - ctx.startedAt,
      });
    }
  });
}

/** Read the active request context, if any. */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
