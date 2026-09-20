import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  expectBearerAuth,
  fetchCallsTo,
  mockFetch,
  mockFetchRoutes,
  setupLoomioTest,
} from "./test-helpers.js";
import { fetch } from "undici";
import { setCachedHealth } from "../src/loomio/health-cache.js";
import { resetHealthForTests } from "../src/loomio/health.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const GENERIC_403 = { status: 403, body: { error: "You are not authorized to access this page." } };
const VERSION_OK = { status: 200, body: { version: "3.8.1" } };

// A zero-group scan consults the key-health probe, which emits a FORCED
// `loomio.auth` event on its first result. Capture stderr so those tests
// stay quiet, and reset the probe's module state between tests so one
// test's verdict cannot leak into the next (the cache lives 60 s).
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  resetHealthForTests();
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
});
afterEach(() => {
  stderrSpy?.mockRestore();
});

describe("listGroups", () => {
  it("collects groups from 200 responses, skips 404s, dedupes by id", async () => {
    // Probe ids 1..5 with concurrency=5 → one batch of 5 calls.
    // Loomio puts exactly the queried group in `groups`; a subgroup's
    // parent is side-loaded under `parent_groups` (see the next test).
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
      ],
      parent_groups: [{ id: 1, key: "a", handle: "alpha", name: "Alpha" }],
    });
    // Defensive dedupe: Loomio's real shape never repeats a group across
    // probes, but a response naming an already-seen group must not
    // produce a duplicate row.
    mockFetch(200, { groups: [{ id: 1, key: "a", handle: "alpha", name: "Alpha" }] });
    mockFetch(200, { groups: [{ id: 5, key: "e", handle: "epsilon", name: "Epsilon" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 5 });

    // 1 once (deduped), 3, 5 → 3 unique groups
    expect(result.groups.map((g) => g.id)).toEqual([1, 3, 5]);
    // A non-empty scan carries no note and consulted no health probe.
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
    expect(vi.mocked(fetch).mock.calls.length).toBe(5);
  });

  it("does NOT harvest `parent_groups` — a subgroup's parent is side-loaded there without a visibility check", async () => {
    // GroupSerializer `has_one :parent, root: :parent_groups`: the parent
    // never appears in `groups`, and the side-load is not gated on
    // can?(:show, parent). Listing it would claim a visibility the probe
    // never established, so a parent is found only when its own id is
    // probed. `parent_id` stays on the subgroup for navigating up.
    mockFetch(404, { error: 404 });
    mockFetch(200, {
      groups: [{ id: 2, key: "b", handle: "beta", name: "Beta", parent_id: 1 }],
      parent_groups: [{ id: 1, key: "a", handle: "alpha", name: "Alpha (umbrella)" }],
    });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 2 });
    expect(result.groups.map((g) => g.id)).toEqual([2]);
    expect(result.groups[0]).toMatchObject({ id: 2, parent_id: 1 });
    expect(result.scanned.total_found).toBe(1);
    expect(result.scanned.note).toBeUndefined();
  });

  it("probes b2/polls (not b2/memberships or b2/discussions) so any member can enumerate", async () => {
    // b2/memberships answers 200 [] to a non-member and so cannot tell
    // membership apart; b2/discussions and b2/polls both 403 for a
    // non-visible group and side-load the group otherwise. Polls is the
    // cheaper of the two.
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(404, {});

    const { listGroups } = await import("../src/tools/groups.js");
    await listGroups({ start_id: 1, end_id: 2 });

    for (const [i, [url]] of vi.mocked(fetch).mock.calls.entries()) {
      expect(url).toContain("/b2/polls?");
      expect(url).toContain("limit=1");
      expect(url).toContain("status=all");
      expectBearerAuth(i, "test-key");
      expect(url).not.toContain("/b2/memberships");
      expect(url).not.toContain("/b2/discussions");
    }
  });

  it("stops early after N consecutive 404s (and, finding nothing, consults the key-health probe)", async () => {
    mockFetchRoutes({
      "/b2/polls": { status: 404, body: {} },
      "/b2/groups": { status: 200, body: { groups: [] } },
      "/v1/boot/version": VERSION_OK,
    });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({
      start_id: 1,
      end_id: 10,
      stop_after_consecutive_misses: 3,
    });

    expect(result.groups).toHaveLength(0);
    expect(result.scanned.stopped_early).toBe(true);
    expect(result.scanned.to).toBe(5);
    // One batch of 5 probes, then the early exit — no second batch.
    expect(fetchCallsTo("/b2/polls").length).toBe(5);
    // The key is valid, so the note explains the benign readings.
    expect(fetchCallsTo("/b2/groups").length).toBe(1);
    expect(result.scanned.note).toMatch(/passed its last health check/);
    expect(result.scanned.note).toMatch(/no polls/);
  });

  it("treats 403 as a soft miss (non-visible groups; instance is_admin grants no bypass)", async () => {
    // A 403 on one id while others succeed means "this group is not
    // visible to the connector's user" — enumerate past it.
    mockFetch(200, { groups: [{ id: 1, name: "g1" }] });
    mockFetch(403, GENERIC_403.body);
    mockFetch(200, { groups: [{ id: 3, name: "g3" }] });

    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 3 });
    expect(result.groups.map((g) => g.id)).toEqual([1, 3]);
    expect(result.scanned.note).toBeUndefined();
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

  it("propagates a 401 from an intermediary instead of returning an empty list", async () => {
    // Loomio's b2 API never answers 401 (its auth failures are 403); a
    // proxy in front might. Either way it is not a per-id soft miss.
    mockFetch(401, { error: "proxy auth required" });

    const { listGroups } = await import("../src/tools/groups.js");
    await expect(listGroups({ start_id: 1, end_id: 1 })).rejects.toThrow(/401/);
  });
});

// With a rotated key every probe answers 403 with Loomio's generic body —
// indistinguishable, per probe, from "not visible". Returning `groups: []`
// then is a lie an agent relays as "you have no groups". The zero-found
// path asks the key-health probe and refuses when the key is rejected.
describe("listGroups — empty scan and the key-health probe", () => {
  it("THROWS (key rejected) instead of returning [] when every probe 403s and the health probe says rejected", async () => {
    mockFetchRoutes({
      "/b2/polls": GENERIC_403,
      "/b2/groups": GENERIC_403,
      "/v1/boot/version": VERSION_OK,
    });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listGroups } = await import("../src/tools/groups.js");

    const err = await listGroups({ start_id: 1, end_id: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/REJECTED/);
    expect(err.message).toMatch(/not the connector user's groups/);
    expect(err.message).toContain("/profile/api_access");
    expect(err.message).not.toContain("test-key");
    expect(fetchCallsTo("/b2/polls").length).toBe(3);
    expect(fetchCallsTo("/b2/groups").length).toBe(1);
  });

  it("returns [] with an explanatory note when the key is valid and nothing is visible", async () => {
    mockFetchRoutes({
      "/b2/polls": GENERIC_403,
      "/b2/groups": { status: 200, body: { groups: [] } },
      "/v1/boot/version": VERSION_OK,
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 3 });
    expect(result.groups).toEqual([]);
    expect(result.scanned.total_found).toBe(0);
    expect(result.scanned.note).toMatch(/group ids 1-3/);
    expect(result.scanned.note).toMatch(/passed its last health check/);
    expect(result.scanned.note).toMatch(/no polls/);
    expect(result.scanned.note).toMatch(/b2\/groups/);
  });

  it("returns [] with an 'unverified' note when the health probe cannot reach Loomio — fixed wording, no detail", async () => {
    mockFetchRoutes({
      "/b2/polls": { status: 404, body: {} },
      "/b2/groups": new Error("ECONNRESET to loomio.internal"),
      "/v1/boot/version": new Error("ECONNRESET to loomio.internal"),
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 2 });
    expect(result.groups).toEqual([]);
    expect(result.scanned.note).toMatch(/could not reach Loomio to verify the API key/);
    expect(result.scanned.note).toMatch(/unreachable/);
    expect(result.scanned.note).toMatch(/may not reflect/);
    // The probe's operator-facing `detail` (error text, possibly a host)
    // stays out of the tool result, as it stays out of /health.
    expect(result.scanned.note).not.toContain("ECONNRESET");
    expect(result.scanned.note).not.toContain("loomio.internal");
  });

  it("FORCES a fresh probe when every miss was a 403, even with a ≤60 s-old cached `valid`", async () => {
    // The rotation window: the startup probe (or a /health hit) said
    // valid 10 s ago, then the key was rotated. Every b2/polls probe now
    // 403s — including ids that do not exist, which with a valid key
    // would 404 — and the scan must not let the stale cache turn that
    // into `groups: []`.
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 10_000,
    );
    mockFetchRoutes({
      "/b2/polls": GENERIC_403,
      "/b2/groups": GENERIC_403,
      "/v1/boot/version": VERSION_OK,
    });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listGroups } = await import("../src/tools/groups.js");

    const err = await listGroups({ start_id: 1, end_id: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/REJECTED/);
    expect(fetchCallsTo("/b2/polls").length).toBe(3);
    expect(fetchCallsTo("/b2/groups").length).toBe(1);
  });

  it("serves the cached `valid` when every miss was a 404 (the key was demonstrably accepted)", async () => {
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 10_000,
    );
    mockFetchRoutes({ "/b2/polls": { status: 404, body: {} } });
    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 3 });
    expect(result.groups).toEqual([]);
    expect(result.scanned.note).toMatch(/passed its last health check/);
    expect(fetchCallsTo("/b2/groups").length).toBe(0);
  });

  it("a mixed scan (some 404, some 403) with nothing found also forces the probe", async () => {
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 10_000,
    );
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const respond = (status: number, body: unknown) =>
        ({
          status,
          ok: status < 300,
          headers: new Headers(),
          json: async () => body,
          text: async () => JSON.stringify(body),
          statusText: String(status),
        }) as Awaited<ReturnType<typeof fetch>>;
      if (url.pathname.endsWith("/b2/polls")) {
        return url.searchParams.get("group_id") === "2"
          ? respond(403, GENERIC_403.body)
          : respond(404, {});
      }
      if (url.pathname.endsWith("/b2/groups")) return respond(200, { groups: [] });
      return respond(200, VERSION_OK.body);
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 3 });
    expect(result.groups).toEqual([]);
    // Re-probed (forced) and the key is still fine → the benign note.
    expect(fetchCallsTo("/b2/groups").length).toBe(1);
    expect(result.scanned.note).toMatch(/passed its last health check/);
  });

  it("does not consult the health probe at all when at least one group was found", async () => {
    mockFetchRoutes({
      "/b2/polls": { status: 200, body: { groups: [{ id: 1, name: "g1" }] } },
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const result = await listGroups({ start_id: 1, end_id: 2 });
    expect(result.groups.map((g) => g.id)).toEqual([1]);
    expect(fetchCallsTo("/b2/groups").length).toBe(0);
    expect(fetchCallsTo("/v1/boot/version").length).toBe(0);
  });
});
