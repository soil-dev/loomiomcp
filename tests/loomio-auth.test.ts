/**
 * Loomio API authentication scheme.
 *
 * Loomio changed this in July 2026: b2 and b3 authenticate via
 * `Authorization: Bearer <key>`, and a key passed in the query string
 * is rejected outright — the request is treated as unauthenticated and
 * comes back 403, exactly as if no credential had been sent. These
 * tests pin the scheme so a regression surfaces here rather than as a
 * blanket 403 against the live instance.
 */

import { describe, it, expect, vi } from "vitest";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("b2 auth", () => {
  it("sends the API key as a bearer token, never in the URL", async () => {
    mockFetch(200, {});
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7, limit: 10 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expectBearerAuth(0, "test-key");
    // Ordinary params still travel in the query string.
    expect(String(url)).toContain("group_id=7");
    expect(String(url)).not.toContain("api_key");
  });

  it("keeps the key out of the URL on writes too", async () => {
    mockFetch(200, {});
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 1, body: "hello" });

    expectBearerAuth(0, "test-key");
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).not.toContain("api_key");
  });

  it("raises a clear error when LOOMIO_API_KEY is unset", async () => {
    delete process.env["LOOMIO_API_KEY"];
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 1 })).rejects.toThrow(/LOOMIO_API_KEY/);
    // The failure must happen before any network call.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
