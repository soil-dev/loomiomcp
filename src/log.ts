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
 *   loomio.*  — request (one per outbound Loomio API call)
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
 *     for `:id` placeholders. The full query string (which carries
 *     the api_key) is dropped.
 *   - No request / response bodies, ever.
 */

import { AsyncLocalStorage } from "node:async_hooks";
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
 * verbose on to see. No callers use it today.
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
 * The query string is dropped because it carries the api_key, which
 * MUST NOT land in logs.
 *
 * Patterns redacted:
 *   /b2/discussions/254022621        -> /b2/discussions/:id
 *   /b2/polls/abcDEF                 -> /b2/polls/:id  (string short-keys too)
 *   /b2/discussions/12?api_key=x     -> /b2/discussions/:id
 *   /b3/users/deactivate?id=42&b3_api_key=…   -> /b3/users/deactivate
 *
 * Both numeric ids AND alphanumeric short-keys are collapsed. The
 * collection-scoped second pass only targets `discussions` / `polls`
 * (the sole endpoints that take a string key in the PATH); it
 * deliberately leaves the `/b3/users/deactivate` action verb intact.
 */
export function redactPath(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  return (
    noQuery
      // Numeric ids (including comma-separated lists).
      .replace(/\/\d+(?:,\d+)*/g, "/:id")
      // Alphanumeric short-keys after the key-addressable collections.
      // (Runs after the numeric pass, so a numeric id is already `:id`.)
      .replace(/\/(discussions|polls)\/[^/]+/g, "/$1/:id")
  );
}

/**
 * Per-`/mcp`-request context for the `tool.chain` aggregate event.
 *
 * Lives in an `AsyncLocalStorage` so the chain accumulator is
 * implicit — every `tool.call` and `loomio.request` event lands in
 * the right bucket without threading context objects through every
 * call site. Set up by `withRequestContext` at the top of the
 * `/mcp` handler in `src/http/transport.ts`; read at the end to emit
 * the aggregate event.
 *
 * Not active under the stdio transport — stdio is a long-lived
 * connection, not a series of discrete requests, so there's no
 * natural "chain end" to emit on. `tool.call` and `loomio.request`
 * still fire on stdio; `tool.chain` does not.
 */
export interface RequestContext {
  clientId?: string;
  tools: string[];
  loomioCalls: number;
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
  initial: Omit<RequestContext, "tools" | "loomioCalls" | "startedAt">,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: RequestContext = {
    ...initial,
    tools: [],
    loomioCalls: 0,
    startedAt: Date.now(),
  };
  return requestContext.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      logEvent("tool.chain", {
        ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
        tools: ctx.tools,
        toolCount: ctx.tools.length,
        loomioCalls: ctx.loomioCalls,
        durationMs: Date.now() - ctx.startedAt,
      });
    }
  });
}

/** Read the active request context, if any. */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
