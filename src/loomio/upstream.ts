/**
 * Upstream cost controls: what bounds the Loomio requests one MCP caller
 * can cause (security review F-01, the P0).
 *
 * The finding. v0.0.16 bounded abuse per HTTP request (the per-IP
 * limiter charges one token per POST /mcp) and per tool call (page caps,
 * `REPORT_CONCURRENCY`), but nothing multiplied correctly: the SDK
 * executes a JSON-RPC batch of up to 100 messages from ONE POST, and
 * `get_user_activity` fans out to 51 calls, so one limiter token became
 * 5,100 upstream requests with 500 in flight — and a client that hung up
 * after one second cancelled none of them. Loomio's per-IP throttle
 * (900 per 5 min) then answers every caller 429 and /health pages.
 *
 * Four independent bounds, all applied in `src/loomio/client.ts`'s one
 * fetch path (`fetchWithTimeout`):
 *
 *   1. PER HTTP REQUEST — `upstreamBudget` on the request context
 *      (src/log.ts): the number of Loomio requests one POST /mcp may
 *      START, whatever tool calls it contains. A batch shares one budget.
 *      Past it, every further call fails fast with `UpstreamBudgetError`
 *      and no request is sent. `MCP_HTTP_UPSTREAM_BUDGET`, default 120
 *      (every single tool call fits: the largest, get_user_activity over
 *      50 groups, needs 51; a whole-thread scan needs at most 12).
 *   2. CANCELLATION — the request context's `signal` (aborted when the
 *      HTTP response closes early) and the SDK handler's `extra.signal`
 *      (threaded through `registerTool` into `withToolCallSignal`) are
 *      combined with the per-request deadline via `AbortSignal.any`. A
 *      disconnected caller's in-flight fetches abort, and every later
 *      call in the same handler fails at once with
 *      `UpstreamCancelledError` instead of being sent. Over stateless
 *      HTTP only the DISCONNECT reaches a running call: a
 *      `notifications/cancelled` arrives in a later POST, served by a new
 *      server instance that does not know the call (SECURITY.md).
 *   3. PER PROCESS, CONCURRENCY — a semaphore of
 *      `MCP_HTTP_UPSTREAM_CONCURRENCY` (default 16) concurrent Loomio
 *      requests with a bounded wait queue (32 waiters per slot). A full
 *      queue fails fast with `UpstreamBusyError` rather than buffering
 *      unbounded work; a waiter whose caller disconnects leaves the queue.
 *      FAIR across sources (review round 1): the queue is served
 *      round-robin over source addresses (the request context's
 *      `sourceKey`), one source may hold at most 3/4 of the slots and at
 *      most 8 queued calls per slot, so a handful of POSTs from one
 *      address can no longer fill the shared FIFO and make every other
 *      caller wait out the 60 s deadline or fail busy.
 *   4. PER PROCESS, RATE — at most `MCP_HTTP_UPSTREAM_PER_5MIN` (default
 *      900, Loomio's own per-address throttle: rack_attack.rb
 *      `req/ip` 900 per 5 minutes) Loomio calls in any 5-minute window,
 *      and one source at most half of them. A concurrency cap bounds work
 *      in flight, not rate: 16 slots at 300 ms latency are ~50 calls a
 *      second, so without this one caller inside every other limit could
 *      make Loomio answer EVERY caller 429 for up to 5 minutes and turn
 *      /health red (review round 1). A request is counted when it is
 *      SENT (after its slot), so calls refused busy or cancelled in the
 *      queue spend nothing; past the window a call fails fast with
 *      `UpstreamRateError`. The probe is never refused, but counted.
 *      Several instances behind ONE egress address share Loomio's budget:
 *      set this to 900 / max instances there (DEPLOY.md).
 *
 * Only HTTP-mode tool traffic (a request context) is charged against 1
 * and 4 and keyed for 3; stdio serves one local user and is not a shared
 * service.
 *
 * The health probe bypasses 1–3 (`detached`): it must never be starved,
 * cancelled or charged by somebody else's request — a probe failing for
 * those reasons would cache `unreachable` and turn /health red for
 * everyone. It is bounded on its own: one request pair per minute per
 * process from /health and the tools, at most one per 10 s when
 * check_connection asks for a fresh one (src/loomio/health.ts), and
 * never more than one in flight.
 *
 * Every bound here is PER CONNECTOR PROCESS (security review F-23): N
 * instances allow up to N times the concurrency and the rate, and a cold
 * start resets the rate window.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readNonNegativeInt, readPositiveInt } from "../env.js";
import { SHARED_EGRESS_CLIENT_SHARE_DIVISOR } from "../http/shared-egress.js";
import { getRequestContext } from "../log.js";

export const DEFAULT_UPSTREAM_BUDGET = 120;
export const DEFAULT_UPSTREAM_CONCURRENCY = 16;
/** Waiters allowed per concurrency slot before new calls are refused. */
export const UPSTREAM_QUEUE_PER_SLOT = 32;
/** Waiters ONE source may queue per concurrency slot (a quarter of the whole queue). */
export const UPSTREAM_SOURCE_QUEUE_PER_SLOT = 8;
/** Loomio's own throttle (rack_attack.rb `req/ip`): 900 requests per 5 minutes per address. */
export const DEFAULT_UPSTREAM_PER_5MIN = 900;
export const UPSTREAM_RATE_WINDOW_MS = 5 * 60_000;
/** Sources whose 5-minute share is tracked at once; the oldest is forgotten past it. */
const MAX_RATE_SOURCES = 10_000;

/** The per-request budget in force: `MCP_HTTP_UPSTREAM_BUDGET`, 0 = unlimited. */
export function resolveUpstreamBudget(): number {
  return readNonNegativeInt("MCP_HTTP_UPSTREAM_BUDGET", DEFAULT_UPSTREAM_BUDGET);
}

/** Process-wide concurrent Loomio requests: `MCP_HTTP_UPSTREAM_CONCURRENCY` (≥ 1). */
export function resolveUpstreamConcurrency(): number {
  return readPositiveInt("MCP_HTTP_UPSTREAM_CONCURRENCY", DEFAULT_UPSTREAM_CONCURRENCY);
}

/** Loomio calls per process per 5 minutes: `MCP_HTTP_UPSTREAM_PER_5MIN`, 0 = no rate bound. */
export function resolveUpstreamPer5Min(): number {
  return readNonNegativeInt("MCP_HTTP_UPSTREAM_PER_5MIN", DEFAULT_UPSTREAM_PER_5MIN);
}

/** Slots one source may hold: all but a quarter (kept for everyone else), at least one. */
export function sourceSlotCap(limit: number): number {
  return Math.max(1, limit - Math.floor(limit / 4));
}

/**
 * Base class of the three refusals. Deliberately NOT a LoomioApiError:
 * Loomio never answered, and tool code that treats a LoomioApiError 404
 * as "not found" or folds per-group failures must not swallow these —
 * they mean "stop", and every catch that folds errors rethrows them
 * (`isUpstreamStop`).
 */
export class UpstreamLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamLimitError";
  }
}

export class UpstreamBudgetError extends UpstreamLimitError {
  constructor(budget: number) {
    super(
      `This request reached the connector's upstream budget of ${budget} Loomio calls per HTTP ` +
        "request (MCP_HTTP_UPSTREAM_BUDGET), so no further call was made. Send fewer tool calls per " +
        "request (a JSON-RPC batch shares one budget) or narrow the call (fewer group_ids, a smaller " +
        "window).",
    );
    this.name = "UpstreamBudgetError";
  }
}

export class UpstreamBusyError extends UpstreamLimitError {
  constructor() {
    super(
      "The connector is at its limit of concurrent Loomio requests and its wait queue (or this " +
        "source's share of it) is full (MCP_HTTP_UPSTREAM_CONCURRENCY), so this call was not sent. " +
        "Retry shortly.",
    );
    this.name = "UpstreamBusyError";
  }
}

export class UpstreamRateError extends UpstreamLimitError {
  constructor(limit: number, retrySeconds: number, share?: number, perClient = false) {
    super(
      share !== undefined
        ? `${perClient ? "This client (behind a shared egress address)" : "This source address"} ` +
            `has used its share (${share}) of the connector's ${limit} Loomio ` +
            "calls per 5 minutes (MCP_HTTP_UPSTREAM_PER_5MIN), so this call was not sent. Retry in " +
            `about ${retrySeconds} s.`
        : `The connector made its limit of ${limit} Loomio calls in the last 5 minutes ` +
            "(MCP_HTTP_UPSTREAM_PER_5MIN, which keeps it under Loomio's own per-address throttle), " +
            `so this call was not sent. Retry in about ${retrySeconds} s.`,
    );
    this.name = "UpstreamRateError";
  }
}

export class UpstreamCancelledError extends UpstreamLimitError {
  constructor() {
    super("The request was cancelled (the MCP client disconnected or cancelled the call).");
    this.name = "UpstreamCancelledError";
  }
}

/** True for an error that must stop a fan-out rather than be folded into a partial result. */
export function isUpstreamStop(err: unknown): boolean {
  return err instanceof UpstreamLimitError;
}

// ── Tool-call signal ────────────────────────────────────────────────────────

const toolCallSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * Run `fn` with the SDK handler's `extra.signal` in scope, so every
 * Loomio request the tool makes is cancelled with the call. Used by
 * `registerTool`; a missing signal (direct calls in tests) is fine.
 */
export function withToolCallSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>) {
  return toolCallSignal.run(signal, fn);
}

/** The caller-side signals in scope: the HTTP request's and the tool call's. */
export function callerSignals(): AbortSignal[] {
  const out: AbortSignal[] = [];
  const req = getRequestContext()?.signal;
  if (req) out.push(req);
  const call = toolCallSignal.getStore();
  if (call) out.push(call);
  return out;
}

/** Throw `UpstreamCancelledError` when any caller-side signal has already fired. */
export function throwIfCancelled(): void {
  if (callerSignals().some((s) => s.aborted)) throw new UpstreamCancelledError();
}

/**
 * Charge one upstream request to the active HTTP request's budget, or
 * throw `UpstreamBudgetError` when it is spent. Outside a request
 * context (stdio, tests) there is no budget.
 */
export function chargeUpstreamBudget(): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  const budget = ctx.upstreamBudget ?? 0;
  if (budget > 0 && ctx.upstreamStarted >= budget) throw new UpstreamBudgetError(budget);
  ctx.upstreamStarted += 1;
}

// ── Process-wide rate window ────────────────────────────────────────────────

// Start times of the calls counted in the current 5-minute window,
// ascending; `rateHead` is the first one still inside it. A sliding log
// (not a token bucket) so "at most N in ANY 5 minutes" holds exactly — a
// bucket with a one-minute burst lets through burst + 5 × refill.
const rateStamps: number[] = [];
let rateHead = 0;
// One fixed 5-minute window per source for the half share: a counter, not
// a log, so a walk over many addresses costs ~50 B per source, bounded.
const sourceWindows = new Map<string, { start: number; count: number }>();

function pruneRate(now: number): void {
  while (
    rateHead < rateStamps.length &&
    (rateStamps[rateHead] as number) <= now - UPSTREAM_RATE_WINDOW_MS
  ) {
    rateHead += 1;
  }
  if (rateHead > 1024 && rateHead * 2 > rateStamps.length) {
    rateStamps.splice(0, rateHead);
    rateHead = 0;
  }
}

/**
 * Charge one upstream request to the process's 5-minute window (and the
 * source's half of it), or throw `UpstreamRateError`. Outside a request
 * context (stdio, tests) nothing is charged.
 */
export function chargeUpstreamRate(now: number = Date.now()): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  const limit = resolveUpstreamPer5Min();
  if (limit === 0) return;
  pruneRate(now);
  if (rateStamps.length - rateHead >= limit) {
    const oldest = rateStamps[rateHead] as number;
    throw new UpstreamRateError(limit, retrySeconds(oldest, now));
  }
  const share = Math.max(1, Math.ceil(limit / 2));
  // One source: its address's half. Behind a shared egress address
  // (src/http/shared-egress.ts): a quarter of that per client, and the
  // address as a whole still the half — every window checked first, so a
  // refused call charges none of them.
  const windows: Array<[{ start: number; count: number }, number, boolean]> = [];
  if (ctx.sourceKey) {
    const perClient = ctx.sharedEgressKey !== undefined;
    const cap = perClient
      ? Math.max(1, Math.ceil(share / SHARED_EGRESS_CLIENT_SHARE_DIVISOR))
      : share;
    windows.push([sourceWindow(ctx.sourceKey, now), cap, perClient]);
  }
  if (ctx.sharedEgressKey)
    windows.push([sourceWindow(`*${ctx.sharedEgressKey}`, now), share, false]);
  for (const [w, cap, perClient] of windows) {
    if (w.count >= cap) {
      throw new UpstreamRateError(limit, retrySeconds(w.start, now), cap, perClient);
    }
  }
  for (const [w] of windows) w.count += 1;
  rateStamps.push(now);
}

/** The current fixed 5-minute window of `key`, opened (and the table bounded) as needed. */
function sourceWindow(key: string, now: number): { start: number; count: number } {
  let w = sourceWindows.get(key);
  if (!w || now - w.start >= UPSTREAM_RATE_WINDOW_MS) {
    sourceWindows.delete(key);
    if (sourceWindows.size >= MAX_RATE_SOURCES) {
      const oldestKey = sourceWindows.keys().next().value;
      if (oldestKey !== undefined) sourceWindows.delete(oldestKey);
    }
    w = { start: now, count: 0 };
    sourceWindows.set(key, w);
  }
  return w;
}

/**
 * Count a request that must not be refused — the health probe — so the
 * window reflects what Loomio sees from this process.
 */
export function recordUpstreamRate(now: number = Date.now()): void {
  if (resolveUpstreamPer5Min() === 0) return;
  pruneRate(now);
  rateStamps.push(now);
}

function retrySeconds(windowStart: number, now: number): number {
  return Math.max(1, Math.ceil((windowStart + UPSTREAM_RATE_WINDOW_MS - now) / 1000));
}

/** Test hook / observability: calls counted in the current window. */
export function upstreamRateStats(now: number = Date.now()): { inWindow: number; sources: number } {
  pruneRate(now);
  return { inWindow: rateStamps.length - rateHead, sources: sourceWindows.size };
}

/** Test hook: forget the rate window. */
export function resetUpstreamRateForTests(): void {
  rateStamps.length = 0;
  rateHead = 0;
  sourceWindows.clear();
}

// ── Process-wide semaphore, fair across sources ─────────────────────────────

interface Waiter {
  key: string;
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

// The un-keyed source "" (stdio, tests, the probe never queues) has no
// per-source caps: there is only one caller to be fair to.
const UNKEYED = "";

let active = 0;
const activeBy = new Map<string, number>();
// One FIFO per source; the Map's insertion order is the round-robin order
// (a source served moves to the back).
const queues = new Map<string, Waiter[]>();
let waiting = 0;

function mayRun(key: string, limit: number): boolean {
  return key === UNKEYED || (activeBy.get(key) ?? 0) < sourceSlotCap(limit);
}

function makeRelease(key: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    const n = (activeBy.get(key) ?? 1) - 1;
    if (n > 0) activeBy.set(key, n);
    else activeBy.delete(key);
    pump();
  };
}

function grant(key: string): () => void {
  active += 1;
  activeBy.set(key, (activeBy.get(key) ?? 0) + 1);
  return makeRelease(key);
}

function pump(): void {
  const limit = resolveUpstreamConcurrency();
  let served = true;
  while (served && active < limit && waiting > 0) {
    served = false;
    for (const [key, queue] of queues) {
      if (!mayRun(key, limit)) continue;
      const next = queue.shift() as Waiter;
      waiting -= 1;
      queues.delete(key);
      if (queue.length > 0) queues.set(key, queue);
      next.cleanup();
      next.resolve(grant(key));
      served = true;
      break;
    }
  }
}

/**
 * Take one of the process's upstream slots for source `key` (the request
 * context's `sourceKey`; omitted = un-keyed), waiting when all are busy.
 * Waiters are served round-robin across sources and FIFO within one; a
 * source holds at most `sourceSlotCap` slots. Resolves to the release
 * function (call it exactly once, after the response body was consumed).
 * Rejects with `UpstreamBusyError` when the whole queue, or this source's
 * share of it, is full, and with `UpstreamCancelledError` when `signal`
 * fires while waiting.
 */
export function acquireUpstreamSlot(
  signal?: AbortSignal,
  key: string = UNKEYED,
): Promise<() => void> {
  const limit = resolveUpstreamConcurrency();
  if (active < limit && waiting === 0 && mayRun(key, limit)) {
    return Promise.resolve(grant(key));
  }
  const own = queues.get(key);
  if (
    waiting >= limit * UPSTREAM_QUEUE_PER_SLOT ||
    (key !== UNKEYED && (own?.length ?? 0) >= limit * UPSTREAM_SOURCE_QUEUE_PER_SLOT)
  ) {
    return Promise.reject(new UpstreamBusyError());
  }
  if (signal?.aborted) return Promise.reject(new UpstreamCancelledError());
  const promise = new Promise<() => void>((resolve, reject) => {
    const onAbort = () => {
      const queue = queues.get(key);
      const i = queue ? queue.indexOf(waiter) : -1;
      if (queue && i >= 0) {
        queue.splice(i, 1);
        waiting -= 1;
        if (queue.length === 0) queues.delete(key);
      }
      reject(new UpstreamCancelledError());
    };
    const waiter: Waiter = {
      key,
      resolve,
      reject,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const queue = queues.get(key);
    if (queue) queue.push(waiter);
    else queues.set(key, [waiter]);
    waiting += 1;
  });
  // A free slot another source's cap left idle goes to this caller now.
  pump();
  return promise;
}

/** Test hook / observability: slots in use and callers waiting. */
export function upstreamSlotStats(): { active: number; waiting: number } {
  return { active, waiting };
}
