/**
 * Group tools on Loomio 3.8's native GET /b2/groups (src/tools/groups.ts):
 * list_groups (one call per 500 groups — Loomio ≥ 3.11.1 pages the index
 * — member groups ∪ their parents), get_group (id / key / handle,
 * hidden → 403 explained, unknown → 404 explained) and check_connection
 * (health probe + the groups body it already fetched, completed past
 * the first page). Fixture shapes follow live 3.8.1 captures
 * (tests/fixtures.ts) and the 3.13.1 paged-index shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TESTED_LOOMIO_VERSION, VERSION } from "../src/version.js";
import { fetch } from "undici";
import { setCachedHealth } from "../src/loomio/health-cache.js";
import { resetHealthForTests } from "../src/loomio/health.js";
import {
  ADA,
  EXAMPLE_ORG,
  EXAMPLE_ORG_NON_MEMBER,
  FINANCE,
  groupRow,
  groupShowBody,
  groupsIndexBody,
  manyGroups,
  manyGroupsSideLoads,
  membershipRow,
  OWN_MEMBERSHIPS,
  VOLUNTEERS,
} from "./fixtures.js";
import {
  expectBearerAuth,
  fetchCallsTo,
  mockFetch,
  mockFetchPaged,
  mockFetchRoutes,
  setupLoomioTest,
} from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const GENERIC_403 = { error: "You are not authorized to access this page." };
const VERSION_OK = { status: 200, body: { version: "3.13.1" } };

// check_connection forces the key-health probe, which emits a FORCED
// `loomio.auth` event on its first result. Keep stderr quiet and reset
// the probe's module state so one test's verdict cannot leak (60 s TTL).
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  resetHealthForTests();
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
});
afterEach(() => {
  stderrSpy?.mockRestore();
  delete process.env["LOOMIO_MCP_READONLY"];
  delete process.env["LOOMIO_B3_API_KEY"];
  delete process.env["LOOMIO_API_BASE_URL"];
});

function requestUrl(index = 0): URL {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  return new URL(String(call![0]));
}

// Every input description is paid by every session in tools/list; the
// 120-character cap is the v0.0.12 writing rule (long form: HOWTO.md).
describe("input descriptions stay within the catalogue budget", () => {
  it("every .describe() in the group schemas is at most 120 characters", async () => {
    const { listGroupsSchema, getGroupSchema, checkConnectionSchema } = await import(
      "../src/tools/groups.js"
    );
    expect(Object.keys(checkConnectionSchema.shape)).toEqual([]);
    for (const schema of [listGroupsSchema, getGroupSchema]) {
      for (const [field, sub] of Object.entries(schema.shape)) {
        const text = sub.description ?? "";
        expect(text.length, `${field}: ${text}`).toBeGreaterThan(0);
        expect(text.length, `${field}: ${text}`).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("listGroups", () => {
  it("issues ONE GET /b2/groups with the groups read profile and Loomio's largest page (no compact, no probing)", async () => {
    mockFetch(200, groupsIndexBody());
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const url = requestUrl();
    expect(url.pathname).toBe("/api/b2/groups");
    // `compact=1` would drop the `memberships` root where the admin flag
    // lives; the profile names only the two roots nothing reads.
    expect(url.searchParams.get("exclude_types")).toBe("tag translation");
    expect(url.searchParams.has("compact")).toBe(false);
    expect(url.searchParams.has("group_id")).toBe(false);
    // Loomio ≥ 3.11.1 pages the index (default 50); the connector asks
    // for the B2 maximum, explicitly from offset 0.
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(r.scope.upstream_calls).toBe(1);
    expect(r.scope).not.toHaveProperty("partial");
    expectBearerAuth(0, "test-key");
    for (const [u] of vi.mocked(fetch).mock.calls) expect(String(u)).not.toContain("/b2/polls");
  });

  it("returns slim member groups with the user's own membership summary, sorted by full_name", async () => {
    mockFetch(200, groupsIndexBody());
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});

    expect(r.groups.map((g) => g.id)).toEqual([7, 12, 15]);
    expect(r.groups.map((g) => g.full_name)).toEqual([
      "Example Org",
      "Example Org - Finance Team",
      "Example Org - Volunteers",
    ]);
    const finance = r.groups.find((g) => g.id === 12)!;
    expect(finance).toEqual({
      id: 12,
      key: "grpKEY12",
      handle: "example-org-finance",
      name: "Finance Team",
      full_name: "Example Org - Finance Team",
      group_privacy: "open",
      is_visible_to_public: true,
      discussion_privacy_options: "public_only",
      memberships_count: 8,
      discussions_count: 32,
      polls_count: 9,
      enabled: true,
      parent_id: 7,
      member: true,
      membership: { accepted: true, admin: true, delegate: false, title: "Connector" },
      url: "https://www.loomio.com/example-org-finance",
    });
    // Bloat is gone.
    expect(finance).not.toHaveProperty("description");
    expect(finance).not.toHaveProperty("link_previews");
    expect(finance).not.toHaveProperty("subscription");
    expect(finance).not.toHaveProperty("members_can_add_members");
    // A pending invitation is still listed, flagged as not accepted.
    const volunteers = r.groups.find((g) => g.id === 15)!;
    expect(volunteers.member).toBe(true);
    expect(volunteers.membership).toEqual({
      accepted: false,
      admin: false,
      delegate: false,
      title: null,
    });
    expect(r.total).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.scope.member_groups).toBe(3);
    expect(r.scope.non_member_parents).toBe(0);
    expect(r.scope.note).toMatch(/Publicly visible groups .* NOT listed/);
    expect(r.scope.note).not.toMatch(/ignored since/);
  });

  it("adds a parent the user is NOT a member of, flagged member:false, and dedupes a parent that is also a member group", async () => {
    // The user belongs to the subgroup only; Loomio still side-loads the
    // parent under `parent_groups` (no visibility check on it).
    mockFetch(
      200,
      groupsIndexBody({
        groups: [FINANCE],
        parent_groups: [EXAMPLE_ORG_NON_MEMBER],
        memberships: [membershipRow({ id: 9012, group_id: 12, admin: true })],
        meta: { root: "groups", total: 1 },
      }),
    );
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});

    expect(r.groups.map((g) => [g.id, g.member])).toEqual([
      [7, false],
      [12, true],
    ]);
    expect(r.groups[0]).not.toHaveProperty("membership");
    expect(r.groups[0]!.url).toBe("https://www.loomio.com/example-org");
    // `total` is Loomio's count of MEMBER groups; the parent is extra.
    expect(r.total).toBe(1);
    expect(r.returned).toBe(2);
    expect(r.scope.non_member_parents).toBe(1);
  });

  it("falls back to current_user_membership_id when a membership row lacks group_id", async () => {
    const row = membershipRow({ id: 9012, admin: true });
    delete (row as { group_id?: number }).group_id;
    mockFetch(
      200,
      groupsIndexBody({
        groups: [FINANCE],
        parent_groups: [],
        memberships: [row],
        meta: { root: "groups", total: 1 },
      }),
    );
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(r.groups[0]!.membership?.admin).toBe(true);
  });

  it("returns [] with total 0 for a user with no groups — and does not consult the health probe", async () => {
    // GroupsController#index answers 200 for any valid key, so a 200
    // with no groups IS the answer; nothing to second-guess.
    mockFetch(200, { groups: [], meta: { root: "groups", total: 0 } });
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(r.groups).toEqual([]);
    expect(r.total).toBe(0);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(fetchCallsTo("/v1/boot/version").length).toBe(0);
  });

  it("advertises no inputs; a 0.0.11 caller still sending the probe knobs is not rejected, its keys are dropped", async () => {
    mockFetch(200, groupsIndexBody());
    const { listGroups, listGroupsSchema } = await import("../src/tools/groups.js");
    // Nothing to advertise: the knobs cost ~340 bytes of tools/list per session and did nothing.
    expect(Object.keys(listGroupsSchema.shape)).toEqual([]);
    // z.object() strips unknown keys (no .strict() in src/tools), so the old call parses to {}.
    const parsed = listGroupsSchema.safeParse({
      start_id: 1,
      end_id: 5000,
      stop_after_consecutive_misses: 3,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({});
    const r = await listGroups(parsed.data);
    expect(r.groups).toHaveLength(3);
    expect(r.scope.note).not.toMatch(/start_id|ignored/);
    // Exactly one request; nothing about the knobs reaches the wire or the result.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(requestUrl().searchParams.has("start_id")).toBe(false);
  });

  it("throws the classified key error on Loomio's generic 403 (this path never 403s for visibility)", async () => {
    mockFetch(403, GENERIC_403);
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listGroups } = await import("../src/tools/groups.js");
    const err = await listGroups({}).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/no active user owns the bearer key/);
    expect(err.message).toContain("/profile/api_access");
    expect(err.message).not.toMatch(/visibility problem/);
    expect(err.message).not.toContain("test-key");
  });

  it("names the rejected key definitively when a fresh health verdict says so", async () => {
    setCachedHealth(
      { key_status: "rejected", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 5_000,
    );
    mockFetch(403, GENERIC_403);
    const { listGroups } = await import("../src/tools/groups.js");
    const err = await listGroups({}).catch((e) => e);
    expect(err.message).toMatch(/rejected the connector's API key/);
    expect(err.message).toMatch(/key-health probe .* failing the same way/);
  });

  it("propagates a 401 from an intermediary", async () => {
    mockFetch(401, { error: "proxy auth required" });
    const { listGroups } = await import("../src/tools/groups.js");
    await expect(listGroups({})).rejects.toThrow(/401/);
  });
});

// Loomio 3.11.1 (bc1a6cc02) pages the groups index: ordered by id, 50
// per page by default, `limit` clamped to 500, `meta.total` the whole
// count on every page. Before 3.11.1 one request returned every group.
describe("listGroups on Loomio's paged groups index", () => {
  it("walks 1 100 groups in three requests of limit=500 (offsets 0, 500, 1000) and returns them all", async () => {
    const calls = mockFetchPaged({
      "/b2/groups": {
        root: "groups",
        rows: manyGroups(1100),
        sideLoads: manyGroupsSideLoads,
        mode: "bounded",
      },
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([
      ["500", "0"],
      ["500", "500"],
      ["500", "1000"],
    ]);
    expect(r.total).toBe(1100);
    expect(r.scope.member_groups).toBe(1100);
    expect(r.returned).toBe(1100);
    expect(r.scope.upstream_calls).toBe(3);
    expect(r.scope).not.toHaveProperty("partial");
    expect(r.scope.non_member_parents).toBe(0);
    // Every group's own membership row arrived on its page and was merged.
    expect(r.groups.every((g) => g.member && g.membership?.accepted === true)).toBe(true);
    expect(new Set(r.groups.map((g) => g.id)).size).toBe(1100);
  });

  it("a server that ignores limit / offset (Loomio < 3.11.1) costs exactly one request", async () => {
    const calls = mockFetchPaged({
      "/b2/groups": {
        root: "groups",
        rows: manyGroups(620),
        sideLoads: manyGroupsSideLoads,
        mode: "legacy",
      },
    });
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(calls).toHaveLength(1);
    expect(r.scope.member_groups).toBe(620);
    expect(r.total).toBe(620);
    expect(r.scope.upstream_calls).toBe(1);
  });

  it("stops at MAX_GROUP_PAGES and says so: scope.partial plus a note, member_groups < total", async () => {
    // A Loomio clamping pages to 50 would need 22 requests for 1 100 groups.
    const calls = mockFetchPaged({
      "/b2/groups": {
        root: "groups",
        rows: manyGroups(1100),
        sideLoads: manyGroupsSideLoads,
        mode: "bounded",
        limitMax: 50,
      },
    });
    const { listGroups, MAX_GROUP_PAGES } = await import("../src/tools/groups.js");
    expect(MAX_GROUP_PAGES).toBe(20);
    const r = await listGroups({});
    expect(calls).toHaveLength(20);
    expect(r.scope.partial).toBe(true);
    expect(r.scope.member_groups).toBe(1000);
    expect(r.total).toBe(1100);
    expect(r.scope.note).toMatch(/PARTIAL \(scope\.partial\)/);
  });

  it("a member parent that a later page lists only under parent_groups (with its own membership row) is a member, not a non-member parent", async () => {
    // The 3.13.1 shape of `?limit=2&offset=2`: two subgroups on the page,
    // their parent — a member group on page 1 — only in parent_groups,
    // its own membership row still side-loaded.
    const { shapeGroupsIndex } = await import("../src/tools/groups.js");
    const r = shapeGroupsIndex(
      groupsIndexBody({
        groups: [FINANCE, VOLUNTEERS],
        parent_groups: [EXAMPLE_ORG],
        memberships: OWN_MEMBERSHIPS,
        meta: { root: "groups", total: 3 },
      }),
    );
    const parent = r.groups.find((g) => g.id === 7)!;
    expect(parent.member).toBe(true);
    expect(parent.membership).toEqual({
      accepted: true,
      admin: false,
      delegate: false,
      title: null,
    });
    expect(r.scope.non_member_parents).toBe(0);
    expect(r.scope).not.toHaveProperty("upstream_calls");

    // No membership row on the page, but the serializer's own-membership
    // id says member: still a member (summary unknown, so omitted).
    const idOnly = shapeGroupsIndex(
      groupsIndexBody({
        groups: [FINANCE],
        parent_groups: [EXAMPLE_ORG],
        memberships: [membershipRow({ id: 9012, group_id: 12 })],
        meta: { root: "groups", total: 2 },
      }),
    );
    expect(idOnly.groups.find((g) => g.id === 7)).toMatchObject({ member: true });
    expect(idOnly.groups.find((g) => g.id === 7)).not.toHaveProperty("membership");
    expect(idOnly.scope.non_member_parents).toBe(0);
  });
});

describe("getGroup", () => {
  it("GETs /b2/groups/{id} with the groups read profile and returns the full record minus bloat", async () => {
    mockFetch(200, groupShowBody(FINANCE));
    const { getGroup } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: 12 });

    const url = requestUrl();
    expect(url.pathname).toBe("/api/b2/groups/12");
    expect(url.searchParams.get("exclude_types")).toBe("tag translation");
    expectBearerAuth(0, "test-key");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);

    expect(r.group.id).toBe(12);
    expect(r.group.name).toBe("Finance Team");
    expect(r.group.description).toBe("<p>Budget, treasury and grants.</p>");
    expect(r.group.members_can_start_discussions).toBe(true);
    // The billing block (GroupSerializer#include_subscription? for any
    // member: plan, seat caps, renewal dates) is a serializer attribute no
    // exclude_types profile can drop — the connector drops it, along with
    // the migration hint and the discarder id. `enabled` still says whether
    // the subscription is active.
    expect(FINANCE.subscription).toBeDefined(); // fixture sanity: Loomio did send it
    expect(r.group.enabled).toBe(true);
    for (const dropped of [
      "attachments",
      "link_previews",
      "cover_url",
      "logo_url",
      "has_custom_cover_photo",
      "tag_ids",
      "subscription",
      "new_host",
      "discarded_by",
    ]) {
      expect(r.group).not.toHaveProperty(dropped);
    }
    expect(JSON.stringify(r)).not.toMatch(/renews_at|expires_at|max_members/);
    expect(r.member).toBe(true);
    expect(r.membership).toEqual({
      accepted: true,
      admin: true,
      delegate: false,
      title: "Connector",
    });
    expect(r.parent).toEqual({ id: 7, name: "Example Org", handle: "example-org" });
    expect(r.subgroups_count).toBe(0);
    expect(r.url).toBe("https://www.loomio.com/example-org-finance");
  });

  it("accepts a handle or short key as the path segment, encoded as one segment", async () => {
    mockFetch(200, groupShowBody(EXAMPLE_ORG));
    const { getGroup } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: "example-org" });
    expect(requestUrl().pathname).toBe("/api/b2/groups/example-org");
    expect(r.parent).toBeNull();
    expect(r.member).toBe(true);
    expect(r.subgroups_count).toBe(3);

    mockFetch(200, groupShowBody(EXAMPLE_ORG));
    await getGroup({ id_or_key_or_handle: "grpKEY07" });
    expect(requestUrl(1).pathname).toBe("/api/b2/groups/grpKEY07");
  });

  it("rejects path-like identifiers at the schema layer and dot segments before any request", async () => {
    const { getGroup, getGroupSchema } = await import("../src/tools/groups.js");
    expect(getGroupSchema.safeParse({ id_or_key_or_handle: "example-org-finance" }).success).toBe(
      true,
    );
    expect(getGroupSchema.safeParse({ id_or_key_or_handle: "../memberships?x=1" }).success).toBe(
      false,
    );
    expect(getGroupSchema.safeParse({ id_or_key_or_handle: "a/b" }).success).toBe(false);
    await expect(getGroup({ id_or_key_or_handle: ".." })).rejects.toThrow(/id_or_key/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("reports a non-member view of a public group: member false, membership null", async () => {
    mockFetch(200, groupShowBody(EXAMPLE_ORG, { memberships: [], users: [] }));
    const { getGroup } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: 7 });
    expect(r.member).toBe(false);
    expect(r.membership).toBeNull();
  });

  it("names the parent by id alone when Loomio did not side-load it", async () => {
    mockFetch(200, groupShowBody(FINANCE, { parent_groups: [] }));
    const { getGroup } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: 12 });
    expect(r.parent).toEqual({ id: 7, name: null, handle: null });
  });

  it('403 "Not authorized to show Group." → a hidden-group explanation, kind not_authorized', async () => {
    mockFetch(403, { error: "Not authorized to show Group." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { getGroup } = await import("../src/tools/groups.js");
    const err = await getGroup({ id_or_key_or_handle: 99 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("not_authorized");
    expect(err.message).toMatch(/HIDDEN from the connector's user/);
    expect(err.message).toMatch(/group admin to add the connector's user/);
    expect(err.message).not.toMatch(/rotated/i);
  });

  it("404 → 'no group with id, key or handle', distinguishing it from a hidden group", async () => {
    mockFetch(404, { error: "not found" });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { getGroup } = await import("../src/tools/groups.js");
    const err = await getGroup({ id_or_key_or_handle: "nope-team" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/no group with id, key or handle "nope-team"/);
    expect(err.message).toMatch(/hidden .* answers 403 instead/);
  });

  it("a 200 without a group record is a shape error, not a silent null", async () => {
    mockFetch(200, { groups: [], meta: { root: "groups" } });
    const { getGroup } = await import("../src/tools/groups.js");
    await expect(getGroup({ id_or_key_or_handle: 12 })).rejects.toThrow(/without a group record/);
  });
});

describe("checkConnection", () => {
  it("reuses a probe up to 10 s old — repeated calls cost no Loomio request (round-1 F-01; v0.0.16 forced one per call)", async () => {
    // Round 2: no test pinned the reuse, so reverting to `{ force: true }`
    // (two uncharged Loomio requests per call, outside the per-request
    // budget and the queue) left the suite green.
    const { CHECK_CONNECTION_PROBE_MAX_AGE_MS, HEALTH_CACHE_TTL_MS } = await import(
      "../src/loomio/health.js"
    );
    expect(CHECK_CONNECTION_PROBE_MAX_AGE_MS).toBe(10_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.parse("2026-10-25T10:00:00Z");
      vi.setSystemTime(t0);
      mockFetchRoutes({
        "/b2/groups": { status: 200, body: groupsIndexBody() },
        "/v1/boot/version": VERSION_OK,
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      const pairs = () => [
        fetchCallsTo("/v1/boot/version").length,
        fetchCallsTo("/b2/groups").length,
      ];
      const first = await checkConnection({});
      vi.setSystemTime(t0 + 4_000);
      await checkConnection({});
      vi.setSystemTime(t0 + CHECK_CONNECTION_PROBE_MAX_AGE_MS - 1);
      const third = await checkConnection({});
      expect(pairs()).toEqual([1, 1]);
      expect(third.checked_at).toBe(first.checked_at); // the reused probe's time

      // Older than 10 s (though inside the 60 s cache): one new pair.
      vi.setSystemTime(t0 + CHECK_CONNECTION_PROBE_MAX_AGE_MS + 1);
      const fourth = await checkConnection({});
      expect(pairs()).toEqual([2, 2]);
      expect(fourth.checked_at).not.toBe(first.checked_at);

      // A /health-style read inside the 60 s TTL still uses the cache, and
      // check_connection never asks for more than the TTL allows.
      const { checkLoomioHealth } = await import("../src/loomio/health.js");
      vi.setSystemTime(t0 + CHECK_CONNECTION_PROBE_MAX_AGE_MS + 5_000);
      await checkLoomioHealth();
      await checkConnection({});
      expect(pairs()).toEqual([2, 2]);
      expect(HEALTH_CACHE_TTL_MS).toBeGreaterThan(CHECK_CONNECTION_PROBE_MAX_AGE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("costs one request pair: the forced health probe's groups body is reused, not re-fetched", async () => {
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});

    expect(fetchCallsTo("/b2/groups").length).toBe(1);
    expect(fetchCallsTo("/v1/boot/version").length).toBe(1);
    // The probe itself sends the groups read profile.
    const probeUrl = new URL(String(fetchCallsTo("/b2/groups")[0]![0]));
    expect(probeUrl.searchParams.get("exclude_types")).toBe("tag translation");

    expect(r.connector_version).toBe(VERSION);
    expect(r.tested_loomio_version).toBe(TESTED_LOOMIO_VERSION);
    expect(r.loomio_version).toBe("3.13.1");
    expect(r.key_status).toBe("valid");
    expect(r.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.readonly).toBe(false);
    expect(r.b3_enabled).toBe(false);
    // The user is the membership rows' user_id resolved through users[]
    // — slim: no email, no avatar.
    expect(r.user).toEqual({ id: 501, name: "Ada Example", username: "ada" });
    expect(r.groups).toEqual([
      { id: 7, name: "Example Org", handle: "example-org", member_state: "member", admin: false },
      {
        id: 12,
        name: "Finance Team",
        handle: "example-org-finance",
        member_state: "member",
        admin: true,
      },
      {
        id: 15,
        name: "Volunteers",
        handle: "example-org-volunteers",
        member_state: "pending",
        admin: false,
      },
    ]);
    expect(r.groups_total).toBe(3);
    expect(r.notes.join(" ")).toMatch(/1 group invitation\(s\) are pending/);
    expect(r.notes.join(" ")).not.toMatch(/rejected|unreachable/i);
  });

  it("flags a subgroup's non-member parent as member_state 'parent' and notes it", async () => {
    mockFetchRoutes({
      "/b2/groups": {
        status: 200,
        body: groupsIndexBody({
          groups: [FINANCE],
          parent_groups: [EXAMPLE_ORG_NON_MEMBER],
          memberships: [membershipRow({ id: 9012, group_id: 12 })],
          meta: { root: "groups", total: 1 },
        }),
      },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.groups.map((g) => [g.id, g.member_state])).toEqual([
      [7, "parent"],
      [12, "member"],
    ]);
    expect(r.groups_total).toBe(1);
    expect(r.notes.join(" ")).toMatch(/1 parent group\(s\) are listed for navigation only/);
  });

  it("key rejected: no groups, no user, the key warning in notes — and no second groups request", async () => {
    mockFetchRoutes({
      "/b2/groups": { status: 403, body: GENERIC_403 },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.key_status).toBe("rejected");
    expect(r.user).toBeNull();
    expect(r.groups).toEqual([]);
    expect(r.groups_total).toBe(0);
    expect(r.notes.join(" ")).toMatch(/ROTATED/);
    expect(r.notes.join(" ")).toContain("/profile/api_access");
    expect(fetchCallsTo("/b2/groups").length).toBe(1);
  });

  it("unreachable: fixed wording, never the probe's detail (error text, hosts)", async () => {
    mockFetchRoutes({
      "/b2/groups": new Error("ECONNRESET to loomio.internal"),
      "/v1/boot/version": new Error("ECONNRESET to loomio.internal"),
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.key_status).toBe("unreachable");
    expect(r.loomio_version).toBeNull();
    expect(r.groups).toEqual([]);
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/could not reach Loomio/);
    expect(notes).toMatch(/Loomio version is unknown/);
    expect(notes).not.toContain("ECONNRESET");
    expect(notes).not.toContain("loomio.internal");
    expect(r).not.toHaveProperty("detail");
  });

  it("falls back to its own GET /b2/groups when the probe's 200 body was not JSON", async () => {
    let groupsCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const respond = (status: number, body: unknown) =>
        ({
          status,
          ok: status < 300,
          headers: new Headers(),
          json: async () => body,
          text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
          statusText: String(status),
        }) as Awaited<ReturnType<typeof fetch>>;
      if (url.pathname.endsWith("/b2/groups")) {
        groupsCalls++;
        return groupsCalls === 1
          ? respond(200, "<html>ok</html>")
          : respond(200, groupsIndexBody());
      }
      return respond(200, VERSION_OK.body);
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.key_status).toBe("valid");
    expect(groupsCalls).toBe(2);
    expect(r.groups_total).toBe(3);
    expect(r.user?.id).toBe(501);
  });

  it("valid key, zero groups: says so plainly and points at the public-read tools", async () => {
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], meta: { root: "groups", total: 0 } } },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.key_status).toBe("valid");
    expect(r.groups_total).toBe(0);
    expect(r.user).toBeNull();
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/belongs to no group/);
    expect(notes).toMatch(/could not be identified/);
  });

  it("read-only with a b3 secret: b3_enabled is FALSE (server.ts registers no b3 tool then) and the note says so; version drift noted", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    process.env["LOOMIO_B3_API_KEY"] = "b3-secret-that-is-long-enough";
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": { status: 200, body: { version: "3.10.0" } },
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.readonly).toBe(true);
    // tests/readonly.test.ts pins that this configuration advertises
    // exactly the reads; the discovery tool must agree with tools/list.
    expect(r.b3_enabled).toBe(false);
    expect(r.loomio_version).toBe("3.10.0");
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/LOOMIO_MCP_READONLY is set/);
    expect(notes).toMatch(
      /LOOMIO_B3_API_KEY is set but LOOMIO_MCP_READONLY is also set: NO b3 tools/,
    );
    expect(notes).not.toMatch(/are registered\./);
    expect(notes).toContain(
      `reports version 3.10.0; this connector was verified against ${TESTED_LOOMIO_VERSION}`,
    );
    expect(notes).not.toContain("b3-secret");
  });

  it("writable with a b3 secret: b3_enabled true and the 'are registered' note", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "b3-secret-that-is-long-enough";
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.readonly).toBe(false);
    expect(r.b3_enabled).toBe(true);
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/LOOMIO_B3_API_KEY is set: .* are registered/);
    expect(notes).not.toMatch(/NO b3 tools/);
    expect(notes).not.toContain("b3-secret");
  });

  it("does not embed the connector user's email even though Loomio sent it on the own row", async () => {
    expect(ADA.email).toBeDefined();
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(JSON.stringify(r)).not.toContain("ada@example.org");
  });

  describe("on Loomio's paged groups index (≥ 3.11.1)", () => {
    it("completes the probe's first page of 50 with ONE continuation at offset=50&limit=500, and never writes the merged list into the health cache", async () => {
      const calls = mockFetchPaged({
        "/b2/groups": {
          root: "groups",
          rows: manyGroups(120),
          sideLoads: manyGroupsSideLoads,
          mode: "bounded",
        },
        "/v1/boot/version": VERSION_OK,
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      const { getCachedGroupsIndex } = await import("../src/loomio/health.js");
      const r = await checkConnection({});
      // The probe sends no window (Loomio's default page of 50); the
      // continuation starts where it ended.
      expect(calls.map((c) => [c.limit, c.offset])).toEqual([
        [null, null],
        ["500", "50"],
      ]);
      expect(r.groups).toHaveLength(120);
      expect(r.groups_total).toBe(120);
      expect(r).not.toHaveProperty("groups_partial");
      expect(r.notes.join(" ")).not.toMatch(/groups_partial/);
      expect(r.user?.id).toBe(501);
      // The cache still holds exactly what the probe received.
      expect(getCachedGroupsIndex()?.groups).toHaveLength(50);
    });

    it("50 groups or fewer: no continuation at all (the probe page is complete)", async () => {
      const calls = mockFetchPaged({
        "/b2/groups": {
          root: "groups",
          rows: manyGroups(50),
          sideLoads: manyGroupsSideLoads,
          mode: "bounded",
        },
        "/v1/boot/version": VERSION_OK,
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      const r = await checkConnection({});
      expect(calls).toHaveLength(1);
      expect(r.groups).toHaveLength(50);
    });

    it("older Loomio returns every group to the probe: no continuation", async () => {
      const calls = mockFetchPaged({
        "/b2/groups": {
          root: "groups",
          rows: manyGroups(120),
          sideLoads: manyGroupsSideLoads,
          mode: "legacy",
        },
        "/v1/boot/version": VERSION_OK,
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      const r = await checkConnection({});
      expect(calls).toHaveLength(1);
      expect(r.groups).toHaveLength(120);
    });

    it("a failed continuation returns the probe's page flagged groups_partial with a fixed note — never an error, never upstream text", async () => {
      mockFetchPaged({
        "/b2/groups": {
          root: "groups",
          rows: manyGroups(120),
          sideLoads: manyGroupsSideLoads,
          mode: "bounded",
          override: (call) =>
            call.offset === null
              ? undefined
              : { status: 500, body: { error: "upstream exploded at db-7.internal" } },
        },
        "/v1/boot/version": VERSION_OK,
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      const r = await checkConnection({});
      expect(r.key_status).toBe("valid");
      expect(r.groups_partial).toBe(true);
      expect(r.groups).toHaveLength(50);
      expect(r.groups_total).toBe(120);
      const notes = r.notes.join(" ");
      expect(notes).toMatch(/Only the first 50 of 120 member groups are listed \(groups_partial\)/);
      expect(notes).not.toContain("db-7.internal");
    });

    it("a member parent that the page lists only under parent_groups is member_state 'member' (or 'pending'), not 'parent'", async () => {
      const { shapeConnectionGroups } = await import("../src/tools/groups.js");
      const shaped = shapeConnectionGroups(
        groupsIndexBody({
          groups: [FINANCE],
          parent_groups: [EXAMPLE_ORG],
          memberships: OWN_MEMBERSHIPS,
          meta: { root: "groups", total: 3 },
        }),
      );
      expect(shaped.groups.map((g) => [g.id, g.member_state])).toEqual([
        [7, "member"],
        [12, "member"],
      ]);
      const pending = shapeConnectionGroups(
        groupsIndexBody({
          groups: [FINANCE],
          parent_groups: [EXAMPLE_ORG],
          memberships: [
            membershipRow({ id: 9012, group_id: 12 }),
            membershipRow({ id: 9007, group_id: 7, accepted_at: null, admin: true }),
          ],
          meta: { root: "groups", total: 2 },
        }),
      );
      expect(pending.groups.find((g) => g.id === 7)).toMatchObject({
        member_state: "pending",
        admin: true,
      });
    });
  });

  it("shapes a group with no handle to a /g/{key} url and tolerates a missing users root", async () => {
    const noHandle = groupRow({
      id: 30,
      key: "grpKEY30",
      handle: null,
      name: "Ad hoc",
      full_name: "Ad hoc",
    });
    mockFetch(
      200,
      groupsIndexBody({
        groups: [noHandle],
        parent_groups: [],
        memberships: [membershipRow({ id: 9030, group_id: 30 })],
        users: undefined,
        meta: { root: "groups", total: 1 },
      }),
    );
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(r.groups[0]!.url).toBe("https://www.loomio.com/g/grpKEY30/ad-hoc");
    expect(VOLUNTEERS.id).toBe(15); // fixture sanity: the pending group is a distinct id
  });
});
