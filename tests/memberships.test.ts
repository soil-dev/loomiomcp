import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("listMemberships", () => {
  it("GETs /b2/memberships with group_id and pagination", async () => {
    mockFetch(200, { memberships: [] });
    const { listMemberships } = await import("../src/tools/memberships.js");
    await listMemberships({ group_id: 12, limit: 25, offset: 0 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/memberships?");
    expect(url).toContain("group_id=12");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=0");
    expect(url).toContain("api_key=test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("requires group_id at schema layer", async () => {
    const { listMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(listMembershipsSchema.safeParse({}).success).toBe(false);
    expect(listMembershipsSchema.safeParse({ group_id: 1 }).success).toBe(true);
  });
});

describe("listMemberships 403 fence", () => {
  it("classifies 403 + member-gated probe 200 as a missing-admin-role boundary", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, { error: 403 }); // the /b2/memberships call itself
    mockFetch(200, { polls: [] }); // the b2/polls access probe
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    // It explains the role boundary, names the group, and points at the fallback.
    expect(err.message).toContain("group 2");
    expect(err.message).toMatch(/admin|coordinator/i);
    expect(err.message).toContain("get_user_activity");
    // It must NOT claim the key is invalid — that's the whole point.
    expect(err.message).not.toMatch(/invalid or expired/i);

    // Probe hit the member-gated endpoint for the same group.
    const probeUrl = vi.mocked(fetch).mock.calls[1]![0] as string;
    expect(probeUrl).toContain("/b2/polls?");
    expect(probeUrl).toContain("group_id=2");
  });

  it("classifies 403 + probe 403 as no access to the group at all", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, { error: 403 }); // /b2/memberships
    mockFetch(403, { error: 403 }); // probe also denied
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 9 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("group 9");
    expect(err.message).toMatch(/invalid or expired|not a member/i);
  });

  it("passes non-403 errors through untouched (no probe)", async () => {
    const { LoomioApiError } = await import("../src/loomio/client.js");
    mockFetch(500, { error: "boom" }); // server error, not a permission issue
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    // Only the original call happened — no access probe on a 500.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("falls back to the original 403 if the access probe itself errors", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, { error: 403 }); // /b2/memberships denied
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET")); // probe network-fails
    const { listMemberships } = await import("../src/tools/memberships.js");

    const err = await listMemberships({ group_id: 2 }).catch((e) => e);
    // Probe failure must NOT mask the real 403 with a 504/500.
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    // The generic both-causes message, not a probe-derived one.
    expect(err.message).toMatch(/Loomio sends the same 403|returned 403/i);
    expect(err.message).not.toContain("only visible to a group admin");
  });
});

describe("manageMemberships", () => {
  it("POSTs /b2/memberships with a flat body including group_id", async () => {
    mockFetch(200, { added_emails: ["a@x.test"], removed_emails: [] });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    await manageMemberships({ group_id: 7, emails: ["a@x.test"] });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/memberships");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ group_id: 7, emails: ["a@x.test"] });
  });

  it("passes remove_absent through to Loomio", async () => {
    mockFetch(200, { added_emails: [], removed_emails: ["b@x.test"] });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    await manageMemberships({ group_id: 7, emails: ["a@x.test"], remove_absent: true });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.remove_absent).toBe(true);
  });

  it("explains the admin-role requirement on a 403 (probe 200)", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, { error: 403 }); // POST /b2/memberships denied
    mockFetch(200, { polls: [] }); // member-gated probe succeeds
    const { manageMemberships } = await import("../src/tools/memberships.js");

    const err = await manageMemberships({ group_id: 7, emails: ["a@x.test"] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("membership changes");
    expect(err.message).toContain("group 7");
    expect(err.message).toMatch(/admin|coordinator/i);
  });

  it("requires group_id at schema layer", async () => {
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    expect(manageMembershipsSchema.safeParse({ emails: ["a@x.test"] }).success).toBe(false);
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
