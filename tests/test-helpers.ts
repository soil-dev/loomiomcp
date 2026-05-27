/**
 * Shared test-fixture builders. Mirrors the pattern from capsulemcp:
 * the caller's file declares the `vi.mock("undici", ...)` at top
 * level (vitest hoists it) and uses `mockFetch` to queue per-test
 * responses. Call `setupLoomioTest()` from the file's top scope to
 * install the standard mock + per-test env wiring.
 */

import { afterEach, beforeEach, vi } from "vitest";
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
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}
