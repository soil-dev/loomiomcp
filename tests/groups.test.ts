import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("listGroups", () => {
  it("collects groups from 200 responses, skips 404s, returns slim objects", async () => {
    // Probe ids 1..5 with concurrency=5 → one batch of 5 calls.
    mockFetch(200, { groups: [{ id: 1, key: "a", handle: "alpha", name: "Alpha" }] });
    mockFetch(404, { error: 404 });
    mockFetch(200, {
      groups: [
        {
          id: 3,
          key: "c",
          handle: "gamma",
          name: "Gamma",
          parent_id: null,
          discussion_privacy_options: "public_only",
          is_visible_to_public: true,
          memberships_count: 7,
        },
      ],
    });
    mockFetch(404, { error: 404 });
    mockFetch(200, { groups: [{ id: 5, key: "e", handle: "epsilon", name: "Epsilon" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = (await listGroups({ start_id: 1, end_id: 5 })) as {
      groups: { id: number; name: string }[];
      scanned: { from: number; to: number; stopped_early: boolean; total_found: number };
    };

    expect(result.groups.map((g) => g.id)).toEqual([1, 3, 5]);
    expect(result.scanned).toEqual({
      from: 1,
      to: 5,
      stopped_early: false,
      total_found: 3,
    });
    // confirm the slim shape — note `parent_id` is included even when null
    expect(result.groups[1]).toMatchObject({
      id: 3,
      name: "Gamma",
      discussion_privacy_options: "public_only",
      memberships_count: 7,
    });
  });

  it("hits the b2/memberships endpoint with limit=1 per probe", async () => {
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(404, {});

    const { listGroups } = await import("../src/tools/groups.js");
    await listGroups({ start_id: 1, end_id: 2 });

    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(url).toContain("/b2/memberships?");
      expect(url).toContain("limit=1");
      expect(url).toContain("api_key=test-key");
    }
  });

  it("stops early after N consecutive 404s", async () => {
    // mock 7 misses then a hit; with stop_after=3, we stop after id 3.
    for (let i = 0; i < 7; i++) mockFetch(404, {});
    mockFetch(200, { groups: [{ id: 8, name: "g8" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = (await listGroups({
      start_id: 1,
      end_id: 10,
      stop_after_consecutive_misses: 3,
    })) as { groups: unknown[]; scanned: { stopped_early: boolean; to: number } };

    expect(result.groups).toHaveLength(0);
    expect(result.scanned.stopped_early).toBe(true);
    // We probe in batches of 5; the first batch (ids 1..5) all 404 → 5
    // consecutive misses → early exit after batch 1 (at id 5). We never
    // dispatch the second batch.
    expect(result.scanned.to).toBe(5);
    expect(vi.mocked(fetch).mock.calls.length).toBe(5);
  });

  it("treats 403 as a soft miss (consistent with is_admin bypass not applying)", async () => {
    // Loomio returns 403 (LoomioAuthError in our client) for groups the
    // bot can't see. We treat it the same as 404 for enumeration.
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(403, { error: 403 });
    mockFetch(200, { groups: [{ id: 3, name: "g3" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = (await listGroups({ start_id: 1, end_id: 3 })) as {
      groups: { id: number }[];
    };
    expect(result.groups.map((g) => g.id)).toEqual([1, 3]);
  });

  it("schema clamps end_id to 10000", async () => {
    const { listGroupsSchema } = await import("../src/tools/groups.js");
    expect(listGroupsSchema.safeParse({ end_id: 10001 }).success).toBe(false);
    expect(listGroupsSchema.safeParse({ end_id: 10000 }).success).toBe(true);
  });
});
