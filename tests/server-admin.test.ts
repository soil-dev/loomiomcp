/**
 * The Loomio 3.13 b3 provisioning tools (src/tools/server-admin.ts):
 * list_instance_groups, list_instance_memberships, add_group_members,
 * update_membership_roles, revoke_membership. Verified against Loomio's
 * source and tests only (app/controllers/api/b3/{groups,memberships}_controller.rb,
 * app/services/server_membership_service.rb,
 * test/integration/b3_provisioning_test.rb at v3.13.1) — there are no
 * live b3 captures — so these tests pin the WIRE: method, path, query,
 * the b3 bearer (never the per-user key), the JSON content type the
 * memberships controller keys its raw-body parse on, exact bodies
 * (above all: `remove_absent` can never be sent), the paging arithmetic
 * and the explanations for Loomio's bare error bodies.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { z } from "zod";
import { resetCachedHealth, setCachedHealth } from "../src/loomio/health-cache.js";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
const B3_SECRET = "long-enough-b3-secret-for-tests-0001";
setupLoomioTest({ LOOMIO_B3_API_KEY: B3_SECRET });
afterEach(() => {
  delete process.env["LOOMIO_MCP_READONLY"];
  resetCachedHealth();
});

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  const r = (opts ?? {}) as RequestInit & { headers?: Record<string, string> };
  return {
    url: new URL(String(url)),
    method: r.method ?? "GET",
    headers: r.headers ?? {},
    rawBody: r.body as string | undefined,
    body: r.body ? (JSON.parse(r.body as string) as Record<string, unknown>) : undefined,
  };
}

/** Every b3 call: the server secret as bearer, the per-user key nowhere. */
function expectB3Auth(index = 0) {
  expectBearerAuth(index, B3_SECRET);
  const { url, headers } = requestOf(index);
  expect(headers["Authorization"]).not.toContain("test-key");
  expect(url.toString()).not.toContain("test-key");
}

/** Illustrative rows in the exact b3 shapes (membership_json / the groups slice). */
function groupRow(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    key: `grpKEY${id}`,
    name: `Example group ${id}`,
    handle: `example-${id}`,
    parent_id: null,
    group_privacy: "secret",
    ...extra,
  };
}

function membershipRow(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    group_id: 7,
    user_id: 100 + id,
    user_email: `member${id}@example.org`,
    user_name: `Member ${id}`,
    admin: false,
    delegate: false,
    accepted_at: "2026-10-01T10:00:00.000Z",
    pending: false,
    ...extra,
  };
}

const GENERIC_403 = { error: "You are not authorized to access this page." };

// ── list_instance_groups ────────────────────────────────────────────────────

describe("listInstanceGroups", () => {
  it("GETs /b3/groups with limit=50 and offset=0 ALWAYS sent, the b3 secret as bearer", async () => {
    mockFetch(200, { groups: [groupRow(101), groupRow(103)], meta: { total: 2 } });
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    const r = await listInstanceGroups({});
    const req = requestOf();
    expect(req.method).toBe("GET");
    expect(req.url.pathname).toBe("/api/b3/groups");
    // `limit=0` would be clamped to ONE row by Loomio; the default is sent explicitly.
    expect(req.url.searchParams.get("limit")).toBe("50");
    expect(req.url.searchParams.get("offset")).toBe("0");
    expectB3Auth();
    expect(r.groups.map((g) => g.id)).toEqual([101, 103]);
    expect(r).toMatchObject({ total: 2, returned: 2, next_offset: null });
    expect(r.scope).toMatchObject({ limit: 50, offset: 0 });
    expect(r.scope.note).toMatch(/secret groups/);
    expect(r.scope.note).toMatch(/member or not|whether or not/);
  });

  it("next_offset = offset + returned while meta.total says more; null on the last page", async () => {
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    mockFetch(200, { groups: [groupRow(11), groupRow(12)], meta: { total: 5 } });
    const first = await listInstanceGroups({ limit: 2, offset: 0 });
    expect(first.next_offset).toBe(2);
    mockFetch(200, { groups: [groupRow(15)], meta: { total: 5 } });
    const last = await listInstanceGroups({ limit: 2, offset: 4 });
    expect(last.next_offset).toBeNull();
    expect(requestOf(1).url.searchParams.get("limit")).toBe("2");
    expect(requestOf(1).url.searchParams.get("offset")).toBe("4");
  });

  it("an empty page never points onward (a caller looping on next_offset terminates)", async () => {
    mockFetch(200, { groups: [], meta: { total: 3 } });
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    const r = await listInstanceGroups({ offset: 0 });
    expect(r).toMatchObject({ returned: 0, total: 3, next_offset: null });
  });

  it("keeps exactly the six documented fields, and tolerates a missing root", async () => {
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    mockFetch(200, { groups: [groupRow(3, { surprise: "x" })], meta: { total: 1 } });
    const r = await listInstanceGroups({});
    expect(Object.keys(r.groups[0]!).sort()).toEqual(
      ["group_privacy", "handle", "id", "key", "name", "parent_id"].sort(),
    );
    mockFetch(200, {});
    const empty = await listInstanceGroups({});
    expect(empty.groups).toEqual([]);
  });

  it("schema: limit is 1..50 (Loomio's b3 maximum), offset >= 0", async () => {
    const { listInstanceGroupsSchema } = await import("../src/tools/server-admin.js");
    expect(listInstanceGroupsSchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(listInstanceGroupsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(listInstanceGroupsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listInstanceGroupsSchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it("a 404 is a Loomio older than 3.13 (no such route)", async () => {
    mockFetch(404, "<html>The page you were looking for doesn't exist.</html>");
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const err = await listInstanceGroups({}).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/older than 3\.13\.0/);
  });

  it("is a READ: not refused by the client in read-only mode (registration is the gate)", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    mockFetch(200, { groups: [], meta: { total: 0 } });
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    await expect(listInstanceGroups({})).resolves.toMatchObject({ returned: 0 });
  });
});

// ── list_instance_memberships ───────────────────────────────────────────────

describe("listInstanceMemberships", () => {
  it("GETs /b3/memberships?group_id=&limit=50&offset=0 with the b3 bearer and returns the rows with emails", async () => {
    mockFetch(200, {
      memberships: [membershipRow(1), membershipRow(2, { pending: true, accepted_at: null })],
      meta: { total: 2 },
    });
    const { listInstanceMemberships } = await import("../src/tools/server-admin.js");
    const r = await listInstanceMemberships({ group_id: 7 });
    const req = requestOf();
    expect(req.method).toBe("GET");
    expect(req.url.pathname).toBe("/api/b3/memberships");
    expect(req.url.searchParams.get("group_id")).toBe("7");
    expect(req.url.searchParams.get("limit")).toBe("50");
    expect(req.url.searchParams.get("offset")).toBe("0");
    expectB3Auth();
    expect(r.memberships).toHaveLength(2);
    expect(r.memberships[0]?.user_email).toBe("member1@example.org");
    expect(r.memberships[1]?.pending).toBe(true);
    expect(r).toMatchObject({ total: 2, returned: 2, next_offset: null });
    expect(r.scope).toMatchObject({ group_id: 7, limit: 50, offset: 0 });
    expect(r.scope.note).toMatch(/DIRECT members only/);
    expect(r.scope.note).toMatch(/email/);
  });

  it("pages by meta.total: limit 1, offset 1 of 3 → next_offset 2", async () => {
    mockFetch(200, { memberships: [membershipRow(2)], meta: { total: 3 } });
    const { listInstanceMemberships } = await import("../src/tools/server-admin.js");
    const r = await listInstanceMemberships({ group_id: 7, limit: 1, offset: 1 });
    expect(r.next_offset).toBe(2);
    expect(requestOf().url.searchParams.get("limit")).toBe("1");
  });

  it("schema: group_id required and positive; limit capped at 50", async () => {
    const { listInstanceMembershipsSchema } = await import("../src/tools/server-admin.js");
    expect(listInstanceMembershipsSchema.safeParse({}).success).toBe(false);
    expect(listInstanceMembershipsSchema.safeParse({ group_id: 0 }).success).toBe(false);
    expect(listInstanceMembershipsSchema.safeParse({ group_id: 7, limit: 51 }).success).toBe(false);
  });

  it("404 names an unknown or deleted group, or an older Loomio", async () => {
    mockFetch(404, { error: 404 });
    const { listInstanceMemberships } = await import("../src/tools/server-admin.js");
    const err = await listInstanceMemberships({ group_id: 7 }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Group 7 is unknown or deleted/);
    expect(err.message).toMatch(/older than 3\.13\.0/);
    expect(err.message).toMatch(/list_instance_groups/);
  });
});

// ── add_group_members ───────────────────────────────────────────────────────

describe("addGroupMembers", () => {
  it("POSTs EXACTLY {group_id, emails} as JSON to /b3/memberships with the b3 bearer — never remove_absent", async () => {
    mockFetch(200, { added_emails: ["new@example.org"], removed_emails: [] });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    await addGroupMembers({ group_id: 7, emails: ["new@example.org"] });
    const req = requestOf();
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/api/b3/memberships");
    expect(req.url.search).toBe("");
    // The controller parses `raw_post` as JSON only for a JSON request
    // (so `[null]` stays a 400): the content type is load-bearing.
    expect(req.headers["Content-Type"]).toBe("application/json");
    expectB3Auth();
    expect(req.body).toEqual({ group_id: 7, emails: ["new@example.org"] });
    expect(Object.keys(req.body!).sort()).toEqual(["emails", "group_id"]);
    expect(req.rawBody).not.toContain("remove_absent");
  });

  it("the body is built field by field: an input object carrying remove_absent cannot smuggle it through", async () => {
    // The strict schema refuses the key first (next test); this pins the
    // second line of defence for a direct caller that bypassed the schema.
    mockFetch(200, { added_emails: [], removed_emails: [] });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const sneaky = { group_id: 7, emails: ["a@example.org"], remove_absent: true } as never;
    await addGroupMembers(sneaky);
    expect(requestOf().body).toEqual({ group_id: 7, emails: ["a@example.org"] });
    expect(requestOf().rawBody).not.toContain("remove_absent");
  });

  it("schema is STRICT: remove_absent and any other extra key are rejected; 1..50 valid emails", async () => {
    const { addGroupMembersSchema } = await import("../src/tools/server-admin.js");
    const ok = { group_id: 7, emails: ["a@example.org"] };
    expect(addGroupMembersSchema.safeParse(ok).success).toBe(true);
    expect(addGroupMembersSchema.safeParse({ ...ok, remove_absent: true }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ ...ok, remove_absent: false }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ ...ok, notify: true }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ group_id: 7, emails: [] }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ group_id: 7, emails: ["not-an-email"] }).success).toBe(
      false,
    );
    const fifty = Array.from({ length: 50 }, (_, i) => `p${i}@example.org`);
    expect(addGroupMembersSchema.safeParse({ group_id: 7, emails: fifty }).success).toBe(true);
    expect(
      addGroupMembersSchema.safeParse({ group_id: 7, emails: [...fifty, "x@example.org"] }).success,
    ).toBe(false);
  });

  it("unchanged_emails = the input normalised like Loomio (trim, lowercase, dedupe) minus added_emails; removed_emails relayed", async () => {
    mockFetch(200, { added_emails: ["new@example.org"], removed_emails: [] });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const r = await addGroupMembers({
      group_id: 7,
      emails: ["New@Example.org", "old@example.org", "OLD@example.org"],
    });
    expect(r).toMatchObject({
      group_id: 7,
      added_emails: ["new@example.org"],
      unchanged_emails: ["old@example.org"],
      removed_emails: [],
    });
    expect(r.scope.note).toMatch(/Additive only/);
    expect(r.scope.note).toMatch(/invitation email/);
    expect(r.scope.note).toMatch(/case-sensitively/);
  });

  it("normaliseEmails mirrors ServerMembershipService.sync (strip, downcase, uniq; input order)", async () => {
    const { normaliseEmails } = await import("../src/tools/server-admin.js");
    expect(normaliseEmails([" B@example.org", "a@example.org", "b@EXAMPLE.org"])).toEqual([
      "b@example.org",
      "a@example.org",
    ]);
  });

  it("an echo without added_emails is a named 502 (the call may have taken effect), never 'all unchanged'", async () => {
    mockFetch(200, {});
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/may have taken effect/);
  });

  it("400 {error:400} is explained: an address failed Loomio's check or is over 200 chars; nothing changed", async () => {
    mockFetch(400, { error: 400 });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/email check/);
    expect(err.message).toMatch(/200 characters/);
    expect(err.message).toMatch(/Nothing was changed/);
  });

  it("404 {error:404} is explained: unknown or deleted group, or Loomio < 3.13", async () => {
    mockFetch(404, { error: 404 });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Group 7 is unknown or deleted/);
    expect(err.message).toMatch(/older than 3\.13\.0/);
    expect(err.message).toMatch(/Nothing was changed/);
  });

  it("422 passes Loomio's text through and names the deactivated account and reactivate_user", async () => {
    mockFetch(422, { errors: { email: ["belongs to a deactivated account"] } });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.message).toContain("email: belongs to a deactivated account");
    expect(err.message).toMatch(/reactivate_user first/);
    expect(err.message).toMatch(/all-or-nothing/);
    expect(err.message).not.toMatch(/SPAM_REGEX/);
  });

  it("422 'no spam' (a NEW address the User model refuses) is NOT blamed on a deactivated account", async () => {
    // ServerMembershipService.sync → User.find_or_create_by! → the User
    // model's `no_spam_for :email` → RecordInvalid → SnorlaxBase's 422.
    mockFetch(422, { errors: { email: ["no spam"] } });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.message).toContain("email: no spam");
    expect(err.message).toMatch(/refused to create an account/);
    expect(err.message).toMatch(/SPAM_REGEX/);
    expect(err.message).toMatch(/all-or-nothing/);
    expect(err.message).toMatch(/Drop that address/);
    expect(err.message).not.toMatch(/reactivate_user|DEACTIVATED/);
  });

  it("403 {error:403} is plan_limit with the inactive-subscription wording and the b3-membership sentence", async () => {
    mockFetch(403, { error: 403 });
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("plan_limit");
    expect(err.message).toMatch(/subscription is inactive or expired/);
    expect(err.message).toMatch(/b3 membership write/);
    expect(err.message).toMatch(/member cap/);
    expect(err.message).not.toContain(B3_SECRET);
  });

  it("the generic CanCan body on /b3/ is the b3 SECRET being refused, whatever the b2 health verdict", async () => {
    setCachedHealth({
      key_status: "valid",
      loomio_version: "3.13.1",
      checked_at: new Date().toISOString(),
    });
    mockFetch(403, GENERIC_403);
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/LOOMIO_B3_API_KEY/);
    expect(err.message).toMatch(/\/b3\/memberships/);
    expect(err.message).not.toMatch(/rotated in between|\/profile\/api_access/);
  });

  it("read-only mode refuses before any request", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    const { LoomioReadOnlyError } = await import("../src/loomio/client.js");
    const err = await addGroupMembers({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioReadOnlyError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a missing LOOMIO_B3_API_KEY fails before any request", async () => {
    delete process.env["LOOMIO_B3_API_KEY"];
    const { addGroupMembers } = await import("../src/tools/server-admin.js");
    await expect(addGroupMembers({ group_id: 7, emails: ["a@example.org"] })).rejects.toThrow(
      /LOOMIO_B3_API_KEY/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── update_membership_roles ─────────────────────────────────────────────────

describe("updateMembershipRoles", () => {
  it("PATCHes /b3/memberships/{id} with {membership:{admin:true}} — only the roles given — as JSON with the b3 bearer", async () => {
    mockFetch(200, { membership: membershipRow(9, { admin: true }) });
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    const r = await updateMembershipRoles({ id: 9, admin: true });
    const req = requestOf();
    expect(req.method).toBe("PATCH");
    expect(req.url.pathname).toBe("/api/b3/memberships/9");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expectB3Auth();
    expect(req.body).toEqual({ membership: { admin: true } });
    expect(r.membership).toMatchObject({ id: 9, admin: true });
  });

  it("sends both roles when both are given, false included", async () => {
    mockFetch(200, { membership: membershipRow(9) });
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    await updateMembershipRoles({ id: 9, admin: false, delegate: true });
    expect(requestOf().body).toEqual({ membership: { admin: false, delegate: true } });
  });

  it("schema: at least one role (Loomio 400s on none); strict; booleans only", async () => {
    const { updateMembershipRolesSchema } = await import("../src/tools/server-admin.js");
    const none = updateMembershipRolesSchema.safeParse({ id: 9 });
    expect(none.success).toBe(false);
    expect(JSON.stringify(none.error?.issues)).toMatch(/admin and\/or delegate/);
    expect(updateMembershipRolesSchema.safeParse({ id: 9, delegate: false }).success).toBe(true);
    expect(updateMembershipRolesSchema.safeParse({ id: 9, admin: "yes" }).success).toBe(false);
    expect(updateMembershipRolesSchema.safeParse({ id: 9, admin: true, weight: 2 }).success).toBe(
      false,
    );
    expect(updateMembershipRolesSchema.safeParse({ id: 0, admin: true }).success).toBe(false);
  });

  it("400 {error:400} is explained as an invalid or missing role; nothing changed", async () => {
    mockFetch(400, { error: 400 });
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    const err = await updateMembershipRoles({ id: 9, admin: true }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/invalid role/);
    expect(err.message).toMatch(/Nothing was changed/);
  });

  it("404 names a revoked or unknown membership (and that a user id is not a membership id)", async () => {
    mockFetch(404, { error: 404 });
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    const err = await updateMembershipRoles({ id: 9, admin: true }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Membership 9 is unknown or REVOKED/);
    expect(err.message).toMatch(/user id is not one/);
  });

  it("an echo without `membership` is a named 502", async () => {
    mockFetch(200, {});
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    const err = await updateMembershipRoles({ id: 9, admin: true }).catch((e) => e);
    expect(err.status).toBe(502);
  });

  it("read-only mode refuses before any request", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    const { updateMembershipRoles } = await import("../src/tools/server-admin.js");
    const { LoomioReadOnlyError } = await import("../src/loomio/client.js");
    await expect(updateMembershipRoles({ id: 9, admin: true })).rejects.toBeInstanceOf(
      LoomioReadOnlyError,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── revoke_membership ───────────────────────────────────────────────────────

describe("revokeMembership", () => {
  it("DELETEs /b3/memberships/{id} with the b3 bearer and reports the revocation and its partial undo", async () => {
    mockFetch(200, { success: true });
    const { revokeMembership } = await import("../src/tools/server-admin.js");
    const r = await revokeMembership({ id: 9 });
    const req = requestOf();
    expect(req.method).toBe("DELETE");
    expect(req.url.pathname).toBe("/api/b3/memberships/9");
    expect(req.url.search).toBe("");
    expectB3Auth();
    expect(r).toMatchObject({ success: true, membership_id: 9 });
    expect(r.scope.note).toMatch(/SUBGROUPS/);
    expect(r.scope.note).toMatch(/cast votes included/);
    expect(r.scope.note).toMatch(/THIS group only/);
    expect(r.scope.note).toMatch(/not the admin role/);
    expect(r.scope.note).toMatch(/delegate flag survives/);
    expect(r.scope.note).toMatch(/pending with a fresh invitation/);
  });

  it("schema is strict and takes a positive membership id", async () => {
    const { revokeMembershipSchema } = await import("../src/tools/server-admin.js");
    expect(revokeMembershipSchema.safeParse({ id: 9 }).success).toBe(true);
    expect(revokeMembershipSchema.safeParse({ id: 9, user_id: 3 }).success).toBe(false);
    expect(revokeMembershipSchema.safeParse({ id: -1 }).success).toBe(false);
  });

  it("404 names an unknown membership or a deleted group — and that a repeat revoke is not a 404", async () => {
    mockFetch(404, { error: 404 });
    const { revokeMembership } = await import("../src/tools/server-admin.js");
    const err = await revokeMembership({ id: 9 }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Membership 9 is unknown or its group is deleted/);
    expect(err.message).toMatch(/repeating a revoke succeeds/);
  });

  it("a generic 403 names the b3 secret, with the membership id redacted from the path", async () => {
    mockFetch(403, GENERIC_403);
    const { revokeMembership } = await import("../src/tools/server-admin.js");
    const err = await revokeMembership({ id: 987654 }).catch((e) => e);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/\/b3\/memberships\/:id/);
    expect(err.message).not.toContain("987654");
    expect(err.message).toMatch(/LOOMIO_B3_API_KEY/);
  });

  it("read-only mode refuses before any request", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    const { revokeMembership } = await import("../src/tools/server-admin.js");
    const { LoomioReadOnlyError } = await import("../src/loomio/client.js");
    await expect(revokeMembership({ id: 9 })).rejects.toBeInstanceOf(LoomioReadOnlyError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── tool-facing text ────────────────────────────────────────────────────────

describe("schemas", () => {
  it("every field description is at most 120 characters", async () => {
    const m = await import("../src/tools/server-admin.js");
    const schemas = {
      listInstanceGroupsSchema: m.listInstanceGroupsSchema,
      listInstanceMembershipsSchema: m.listInstanceMembershipsSchema,
      addGroupMembersSchema: m.addGroupMembersSchema,
      updateMembershipRolesSchema: m.updateMembershipRolesSchema,
      revokeMembershipSchema: m.revokeMembershipSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      const shape = schema.def.shape as Record<string, { description?: string }>;
      for (const [field, def] of Object.entries(shape)) {
        expect(def.description, `${name}.${field} has a describe`).toBeDefined();
        expect(def.description!.length, `${name}.${field}`).toBeLessThanOrEqual(120);
      }
    }
  });

  it("the three writes are strict object schemas; the two reads strip unknown keys like every other read", async () => {
    const m = await import("../src/tools/server-admin.js");
    for (const s of [
      m.addGroupMembersSchema,
      m.updateMembershipRolesSchema,
      m.revokeMembershipSchema,
    ]) {
      expect(z.toJSONSchema(s, { io: "input" }).additionalProperties).toBe(false);
    }
    for (const s of [m.listInstanceGroupsSchema, m.listInstanceMembershipsSchema]) {
      expect(z.toJSONSchema(s, { io: "input" }).additionalProperties).toBeUndefined();
    }
    expect(m.listInstanceGroupsSchema.safeParse({ unknown: 1 }).success).toBe(true);
  });
});
