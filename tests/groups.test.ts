import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("listGroups", () => {
  it("collects groups from 200 responses, skips 404s, dedupes by id", async () => {
    // Probe ids 1..5 with concurrency=5 → one batch of 5 calls.
    // b2/polls returns the queried group AND its parent in `groups`.
    mockFetch(200, { groups: [{ id: 1, key: "a", handle: "alpha", name: "Alpha" }] });
    mockFetch(404, { error: 404 });
    mockFetch(200, {
      groups: [
        {
          id: 3,
          key: "c",
          handle: "gamma",
          name: "Gamma",
          parent_id: 1,
          discussion_privacy_options: "public_only",
          is_visible_to_public: true,
          memberships_count: 7,
        },
        // Parent (already seen at id=1) shows up again — dedup must
        // suppress the duplicate.
        { id: 1, key: "a", handle: "alpha", name: "Alpha" },
      ],
    });
    mockFetch(404, { error: 404 });
    mockFetch(200, { groups: [{ id: 5, key: "e", handle: "epsilon", name: "Epsilon" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = (await listGroups({ start_id: 1, end_id: 5 })) as {
      groups: { id: number; name: string }[];
      scanned: { from: number; to: number; stopped_early: boolean; total_found: number };
    };

    // 1 once (deduped), 3, 5 → 3 unique groups
    expect(result.groups.map((g) => g.id)).toEqual([1, 3, 5]);
    expect(result.scanned).toEqual({
      from: 1,
      to: 5,
      stopped_early: false,
      total_found: 3,
    });
    expect(result.groups[1]).toMatchObject({
      id: 3,
      name: "Gamma",
      discussion_privacy_options: "public_only",
      memberships_count: 7,
    });
  });

  it("probes b2/polls (not b2/memberships) so non-admin members can enumerate, including empty groups", async () => {
    // b2/polls is preferred over b2/discussions for the probe because
    // it returns the group object even when the queried group has zero
    // polls — Loomio's polls serializer includes historical poll-event
    // metadata which carries the group through. b2/discussions omits
    // the groups array entirely on empty groups.
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(404, {});

    const { listGroups } = await import("../src/tools/groups.js");
    await listGroups({ start_id: 1, end_id: 2 });

    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(url).toContain("/b2/polls?");
      expect(url).toContain("limit=1");
      expect(url).toContain("status=all");
      expect(url).toContain("api_key=test-key");
      expect(url).not.toContain("/b2/memberships");
      expect(url).not.toContain("/b2/discussions");
    }
  });

  it("stops early after N consecutive 404s", async () => {
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
    expect(result.scanned.to).toBe(5);
    expect(vi.mocked(fetch).mock.calls.length).toBe(5);
  });

  it("treats 403 as a soft miss (non-member groups, no is_admin bypass)", async () => {
    // For a non-admin bot, 403 = "you're not a member of this group".
    // We treat it the same as 404 for enumeration.
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(403, { error: 403 });
    mockFetch(200, { groups: [{ id: 3, name: "g3" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = (await listGroups({ start_id: 1, end_id: 3 })) as {
      groups: { id: number }[];
    };
    expect(result.groups.map((g) => g.id)).toEqual([1, 3]);
  });

  it("schema caps each probe span to 500 ids", async () => {
    const { listGroupsSchema } = await import("../src/tools/groups.js");
    expect(listGroupsSchema.safeParse({ start_id: 1, end_id: 500 }).success).toBe(true);
    expect(listGroupsSchema.safeParse({ start_id: 1, end_id: 501 }).success).toBe(false);
    expect(listGroupsSchema.safeParse({ start_id: 9501, end_id: 10000 }).success).toBe(true);
    expect(listGroupsSchema.safeParse({ start_id: 9500, end_id: 10000 }).success).toBe(false);
  });

  it("rejects an inverted probe range", async () => {
    const { listGroupsSchema } = await import("../src/tools/groups.js");
    expect(listGroupsSchema.safeParse({ start_id: 10, end_id: 9 }).success).toBe(false);
  });

  it("rejects end_id above the absolute ceiling", async () => {
    const { listGroupsSchema } = await import("../src/tools/groups.js");
    expect(listGroupsSchema.safeParse({ start_id: 10000, end_id: 10001 }).success).toBe(false);
  });

  it("propagates 401 auth failures instead of returning an empty list", async () => {
    mockFetch(401, { error: "bad api key" });

    const { listGroups } = await import("../src/tools/groups.js");
    await expect(listGroups({ start_id: 1, end_id: 1 })).rejects.toThrow(/401/);
  });
});
