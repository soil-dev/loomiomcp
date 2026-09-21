/**
 * Group tools on Loomio 3.8's native GET /b2/groups (src/tools/groups.ts):
 * list_groups (one call, member groups ∪ their parents), get_group
 * (id / key / handle, hidden → 403 explained, unknown → 404 explained)
 * and check_connection (health probe + the groups body it already
 * fetched). Fixture shapes follow live 3.8.1 captures (tests/fixtures.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { setCachedHealth } from "../src/loomio/health-cache.js";
import { resetHealthForTests } from "../src/loomio/health.js";
import {
  ADA,
  EXAMPLE_ORG,
  FINANCE,
  groupRow,
  groupShowBody,
  groupsIndexBody,
  membershipRow,
  VOLUNTEERS,
} from "./fixtures.js";
import {
  expectBearerAuth,
  fetchCallsTo,
  mockFetch,
  mockFetchRoutes,
  setupLoomioTest,
} from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const GENERIC_403 = { error: "You are not authorized to access this page." };
const VERSION_OK = { status: 200, body: { version: "3.8.1" } };

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
  it("issues ONE GET /b2/groups with the groups read profile (no compact, no probing)", async () => {
    mockFetch(200, groupsIndexBody());
    const { listGroups } = await import("../src/tools/groups.js");
    await listGroups({});

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const url = requestUrl();
    expect(url.pathname).toBe("/api/b2/groups");
    // `compact=1` would drop the `memberships` root where the admin flag
    // lives; the profile names only the two roots nothing reads.
    expect(url.searchParams.get("exclude_types")).toBe("tag translation");
    expect(url.searchParams.has("compact")).toBe(false);
    expect(url.searchParams.has("group_id")).toBe(false);
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
        parent_groups: [EXAMPLE_ORG],
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

    expect(r.connector_version).toBe("0.0.12");
    expect(r.tested_loomio_version).toBe("3.8.1");
    expect(r.loomio_version).toBe("3.8.1");
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
          parent_groups: [EXAMPLE_ORG],
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
      "/v1/boot/version": { status: 200, body: { version: "3.9.0" } },
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.readonly).toBe(true);
    // tests/readonly.test.ts pins that this configuration advertises
    // exactly the reads; the discovery tool must agree with tools/list.
    expect(r.b3_enabled).toBe(false);
    expect(r.loomio_version).toBe("3.9.0");
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/LOOMIO_MCP_READONLY is set/);
    expect(notes).toMatch(
      /LOOMIO_B3_API_KEY is set but LOOMIO_MCP_READONLY is also set: NO b3 tools/,
    );
    expect(notes).not.toMatch(/are registered\./);
    expect(notes).toMatch(/reports version 3\.9\.0; this connector was verified against 3\.8\.1/);
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
