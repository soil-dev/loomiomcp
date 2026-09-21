import { describe, it, expect, vi } from "vitest";
import { fetch } from "undici";
import { ADA, GRACE, LINUS, membershipRow, membershipsListBody } from "./fixtures.js";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const GENERIC_403 = { error: "You are not authorized to access this page." };

describe("listMemberships", () => {
  it("GETs /b2/memberships with group_id, pagination and compact=1 (no topics join needed here)", async () => {
    mockFetch(200, membershipsListBody());
    const { listMemberships } = await import("../src/tools/memberships.js");
    await listMemberships({ group_id: 7, limit: 25, offset: 0 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/api/b2/memberships");
    expect(u.searchParams.get("group_id")).toBe("7");
    expect(u.searchParams.get("limit")).toBe("25");
    expect(u.searchParams.get("offset")).toBe("0");
    expect(u.searchParams.get("compact")).toBe("1");
    expect(u.searchParams.has("exclude_types")).toBe(false);
    expectBearerAuth(0, "test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("slims each row to its meaningful fields and each user to id/name/username; no scope block when non-empty", async () => {
    mockFetch(200, membershipsListBody());
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.memberships).toEqual([
      {
        id: 3,
        user_id: 502,
        group_id: 7,
        admin: true,
        delegate: false,
        title: "Operations",
        inviter_id: null,
        created_at: "2024-10-19T09:55:12.970Z",
        accepted_at: "2024-10-19T09:55:12.964Z",
      },
      {
        id: 61,
        user_id: 503,
        group_id: 7,
        admin: false,
        delegate: true,
        title: null,
        inviter_id: 502,
        created_at: "2024-11-30T17:26:12.000Z",
        accepted_at: "2024-12-01T08:00:00.000Z",
      },
    ]);
    for (const row of r.memberships) {
      expect(row).not.toHaveProperty("experiences");
      expect(row).not.toHaveProperty("volume_email");
      expect(row).not.toHaveProperty("user_email");
    }
    expect(r.users).toEqual([
      { id: 502, name: "Grace Sample", username: "grace" },
      { id: 503, name: "Linus Placeholder", username: "linus" },
    ]);
    expect(r.total).toBe(12);
    expect(r.returned).toBe(2);
    expect(r).not.toHaveProperty("scope");
  });

  it("keeps user_email on rows where Loomio sent it (admin groups); users[] never carry email", async () => {
    const body = membershipsListBody();
    body.memberships![1]!.user_email = "linus@example.org";
    mockFetch(200, body);
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.memberships[0]).not.toHaveProperty("user_email");
    expect(r.memberships[1]!.user_email).toBe("linus@example.org");
    for (const u of r.users) expect(u).not.toHaveProperty("email");
  });

  it("drops the connector account's OWN email, which Loomio puts on its users[] row for any member group (AuthorSerializer#include_email? is true for current_user_id)", async () => {
    // The own row's membership carries no user_email (a plain member is
    // not entitled to roster emails), yet users[] has the account's
    // email — that is the API user's mailbox, not roster data.
    const body = membershipsListBody({
      memberships: [
        membershipRow({ id: 90, user_id: ADA.id, group_id: 7, admin: false, inviter_id: 502 }),
        ...membershipsListBody().memberships!,
      ],
      users: [ADA, GRACE, LINUS],
    });
    expect(ADA.email).toBeDefined();
    mockFetch(200, body);
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.users.find((u) => u.id === ADA.id)).toEqual({
      id: 501,
      name: "Ada Example",
      username: "ada",
    });
    expect(JSON.stringify(r)).not.toContain("ada@example.org");
  });

  it("annotates an empty roster: Loomio answers 200 [] (not 403) to a non-member", async () => {
    mockFetch(200, { memberships: [], meta: { root: "memberships", total: 0 } });
    const { listMemberships, EMPTY_ROSTER_NOTE } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 99 });
    expect(r.memberships).toEqual([]);
    expect(r.users).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.scope?.note).toBe(EMPTY_ROSTER_NOTE);
    expect(r.scope?.note).toMatch(/not a member/);
    expect(r.scope?.note).toMatch(/not 403/);
  });

  it("mentions the offset when an empty page may simply be past the end of the roster", async () => {
    mockFetch(200, { memberships: [], meta: { root: "memberships", total: 12 } });
    const { listMemberships, EMPTY_ROSTER_NOTE } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7, offset: 200 });
    expect(r.scope?.note).toContain(EMPTY_ROSTER_NOTE);
    expect(r.scope?.note).toContain("offset=200");
    expect(r.total).toBe(12);
  });

  it("requires group_id at schema layer", async () => {
    const { listMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(listMembershipsSchema.safeParse({}).success).toBe(false);
    expect(listMembershipsSchema.safeParse({ group_id: 1 }).success).toBe(true);
  });
});

// Every input description is paid by every session in tools/list; the
// 120-character cap is the v0.0.12 writing rule (long form: HOWTO.md).
describe("input descriptions stay within the catalogue budget", () => {
  it("every .describe() in the membership schemas is at most 120 characters", async () => {
    const { listMembershipsSchema, manageMembershipsSchema } = await import(
      "../src/tools/memberships.js"
    );
    for (const schema of [listMembershipsSchema, manageMembershipsSchema]) {
      for (const [field, sub] of Object.entries(schema.shape)) {
        const text = sub.description ?? "";
        expect(text.length, `${field}: ${text}`).toBeGreaterThan(0);
        expect(text.length, `${field}: ${text}`).toBeLessThanOrEqual(120);
      }
    }
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
