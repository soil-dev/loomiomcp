import { describe, it, expect, vi } from "vitest";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const GENERIC_403 = { error: "You are not authorized to access this page." };

describe("listMemberships", () => {
  it("GETs /b2/memberships with group_id and pagination", async () => {
    mockFetch(200, { memberships: [{ id: 1 }] });
    const { listMemberships } = await import("../src/tools/memberships.js");
    await listMemberships({ group_id: 12, limit: 25, offset: 0 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/memberships?");
    expect(url).toContain("group_id=12");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=0");
    expectBearerAuth(0, "test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("passes a non-empty roster through untouched — no scope block, one request", async () => {
    const body = {
      memberships: [{ id: 1, user_id: 5, admin: true, accepted_at: "2026-01-01T00:00:00Z" }],
      users: [{ id: 5, name: "Ada", username: "ada" }],
      meta: { root: "memberships", total: 1 },
    };
    mockFetch(200, body);
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 12 });
    expect(r).toEqual(body);
    expect(r).not.toHaveProperty("scope");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("annotates an empty roster: Loomio answers 200 [] (not 403) to a non-member", async () => {
    mockFetch(200, { memberships: [], users: [], meta: { root: "memberships", total: 0 } });
    const { listMemberships, EMPTY_ROSTER_NOTE } = await import("../src/tools/memberships.js");
    const r = (await listMemberships({ group_id: 12 })) as {
      memberships: unknown[];
      scope: { note: string };
    };
    expect(r.memberships).toEqual([]);
    expect(r.scope.note).toBe(EMPTY_ROSTER_NOTE);
    expect(r.scope.note).toMatch(/not a member/);
    expect(r.scope.note).toMatch(/not 403/);
  });

  it("mentions the offset when an empty page may simply be past the end of the roster", async () => {
    mockFetch(200, { memberships: [] });
    const { listMemberships, EMPTY_ROSTER_NOTE } = await import("../src/tools/memberships.js");
    const r = (await listMemberships({ group_id: 12, offset: 200 })) as {
      scope: { note: string };
    };
    expect(r.scope.note).toContain(EMPTY_ROSTER_NOTE);
    expect(r.scope.note).toContain("offset=200");
  });

  it("requires group_id at schema layer", async () => {
    const { listMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(listMembershipsSchema.safeParse({}).success).toBe(false);
    expect(listMembershipsSchema.safeParse({ group_id: 1 }).success).toBe(true);
  });
});

// The old "403 fence" (a follow-up b2/polls probe to tell a bad key from
// a missing admin role) is gone: Loomio's 403 bodies are distinguishable
// and the HTTP client classifies them. These tests pin that the
// membership tools rely on that classification and issue NO extra
// request on a 403.
describe("membership 403s (classified by the client, no follow-up probe)", () => {
  it("manage: 'User is not an admin' → kind not_admin, explains the coordinator role", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, { error: "User is not an admin" });
    const { manageMemberships } = await import("../src/tools/memberships.js");

    const err = await manageMemberships({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("not_admin");
    expect(err.message).toContain("User is not an admin");
    expect(err.message).toMatch(/coordinator/);
    expect(err.message).toContain("/b2/memberships");
    // The key is fine — the message must not send the operator chasing it.
    expect(err.message).not.toMatch(/rotated/i);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("list: Loomio's generic body → kind unauthenticated, points at the key and /profile/api_access", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, GENERIC_403);
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 9 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/UNAUTHENTICATED/);
    expect(err.message).toContain("/profile/api_access");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("list: non-403 errors pass through untouched", async () => {
    const { LoomioApiError } = await import("../src/loomio/client.js");
    mockFetch(500, { error: "boom" });
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(500);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});

describe("manageMemberships", () => {
  it("POSTs a flat JSON body of group_id + emails and OMITS remove_absent when unset", async () => {
    mockFetch(200, { added_emails: ["a@example.org"], removed_emails: [] });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    const r = await manageMemberships({ group_id: 7, emails: ["a@example.org"] });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/memberships");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as { headers: Record<string, string> }).headers["Content-Type"]).toBe(
      "application/json",
    );
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ group_id: 7, emails: ["a@example.org"] });
    expect(body).not.toHaveProperty("remove_absent");
    // Loomio's response is passed through, typed.
    expect(r).toEqual({ added_emails: ["a@example.org"], removed_emails: [] });
  });

  it("OMITS remove_absent when explicitly false", async () => {
    mockFetch(200, { added_emails: [], removed_emails: [] });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    await manageMemberships({ group_id: 7, emails: ["a@example.org"], remove_absent: false });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("remove_absent");
  });

  it("sends remove_absent as the INTEGER 1, never the JSON boolean", async () => {
    // Loomio reads `params[:remove_absent].to_i == 1`. A JSON `true` has
    // no #to_i in Ruby → NoMethodError → HTTP 500, AFTER the invitations
    // for `emails` have already gone out. Loomio's own controller test
    // posts `remove_absent: 1`.
    mockFetch(200, { added_emails: [], removed_emails: ["b@example.org"] });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    await manageMemberships({ group_id: 7, emails: ["a@example.org"], remove_absent: true });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.remove_absent).toBe(1);
    expect(body.remove_absent).not.toBe(true);
    expect(body).toEqual({ group_id: 7, emails: ["a@example.org"], remove_absent: 1 });
  });

  it("keeps remove_absent a boolean at the schema layer (the integer is a wire detail)", async () => {
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(
      manageMembershipsSchema.safeParse({
        group_id: 1,
        emails: ["a@example.org"],
        remove_absent: true,
      }).success,
    ).toBe(true);
    expect(
      manageMembershipsSchema.safeParse({
        group_id: 1,
        emails: ["a@example.org"],
        remove_absent: 1,
      }).success,
    ).toBe(false);
  });

  it("requires group_id at schema layer", async () => {
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(manageMembershipsSchema.safeParse({ emails: ["a@example.org"] }).success).toBe(false);
  });

  it("rejects empty email list at the schema layer", async () => {
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(manageMembershipsSchema.safeParse({ group_id: 1, emails: [] }).success).toBe(false);
  });

  it("rejects malformed emails at the schema layer", async () => {
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(
      manageMembershipsSchema.safeParse({ group_id: 1, emails: ["not-an-email"] }).success,
    ).toBe(false);
  });
});
