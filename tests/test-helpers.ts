/**
 * Shared test-fixture builders. Mirrors the pattern from capsulemcp:
 * the caller's file declares the `vi.mock("undici", ...)` at top
 * level (vitest hoists it) and uses `mockFetch` to queue per-test
 * responses. Call `setupLoomioTest()` from the file's top scope to
 * install the standard mock + per-test env wiring.
 */

import { afterEach, beforeEach, expect, vi } from "vitest";
import { fetch } from "undici";

/**
 * Install the per-test boilerplate that every tool test needs:
 *   - sets LOOMIO_API_KEY before each test
 *   - clears all mocks + unsets env vars after each test
 *
 * The `vi.mock("undici", () => ({ fetch: vi.fn() }))` line still has
 * to live at the top of each file because vitest hoists it; that's
 * one line per file we can't share.
 */
export function setupLoomioTest(env: Record<string, string> = {}): void {
  beforeEach(() => {
    process.env["LOOMIO_API_KEY"] = "test-key";
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
  });
  afterEach(() => {
    // `clearAllMocks` clears call history but NOT queued
    // `mockResolvedValueOnce` values; `mockReset` does both. Without
    // a reset, a test that queues more responses than it consumes
    // (e.g. an early-exit test) leaks mocks into the next test.
    vi.mocked(fetch).mockReset();
    vi.clearAllMocks();
    delete process.env["LOOMIO_API_KEY"];
    for (const k of Object.keys(env)) delete process.env[k];
  });
}

/**
 * Assert that outbound call `index` authenticated the way Loomio
 * requires since its 2026-07 change: `Authorization: Bearer <key>`,
 * with the key absent from the URL. Both halves matter — Loomio now
 * rejects keys passed in the query string, and a key in a URL leaks
 * into access logs, proxies, and browser history.
 */
export function expectBearerAuth(index: number, key: string): void {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  const headers = (opts as { headers?: Record<string, string> } | undefined)?.headers;
  expect(headers?.["Authorization"]).toBe(`Bearer ${key}`);
  expect(String(url)).not.toContain(key);
}

export function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    // The error path (`readErrorText`) and the raw probes behind the
    // key-health check (`loomioGetRaw` / `loomioGetPublic`) read the body
    // via text(); provide it so those resolve cleanly in tests.
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

export type MockRoute = { status: number; body: unknown; headers?: Record<string, string> } | Error;

/**
 * Route mock responses by URL-path suffix instead of call order. Use
 * this when a tool issues requests whose ORDER is not what the test is
 * about — e.g. the key-health probe's two parallel GETs, or a scan that
 * consults the health probe after its own probes. `mockFetch`'s FIFO
 * queue stays the right tool for strictly sequential call chains.
 * Throws for a path no route matches, so an unexpected request fails
 * the test loudly instead of returning `undefined`.
 */
export function mockFetchRoutes(routes: Record<string, MockRoute>): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
    if (!hit) throw new Error(`unmocked route: ${path}`);
    if (hit instanceof Error) throw hit;
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      headers: new Headers(hit.headers ?? {}),
      json: async () => hit.body,
      text: async () => (typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body)),
      statusText: String(hit.status),
    } as Awaited<ReturnType<typeof fetch>>;
  });
}

/** The fetch calls whose URL path ends with `suffix`, in call order. */
export function fetchCallsTo(suffix: string) {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(suffix));
}
