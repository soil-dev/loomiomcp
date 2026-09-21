import { afterEach, describe, it, expect, vi } from "vitest";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";
import { resetCachedHealth, setCachedHealth } from "../src/loomio/health-cache.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest({ LOOMIO_B3_API_KEY: "long-enough-admin-secret-12345" });
afterEach(() => resetCachedHealth());

const GENERIC_403 = { error: "You are not authorized to access this page." };

const USER_42 = {
  id: 42,
  name: "Ada",
  username: "ada",
  email: "ada@example.org",
  is_admin: false,
  active: true,
  deactivated_at: null,
  identities: [],
};

describe("deactivateUser (b3 admin)", () => {
  it("POSTs the MEMBER route /b3/users/{id}/deactivate — no ?id= query — with the b3 secret as bearer", async () => {
    mockFetch(200, { success: true, user: USER_42 });
    const { deactivateUser } = await import("../src/tools/admin.js");
    await deactivateUser({ id: 42 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    // Loomio's OpenAPI marks `POST /api/b3/users/deactivate?id=` deprecated
    // ("legacy query-ID route"); the path form is the supported one.
    expect(String(url)).toMatch(/\/b3\/users\/42\/deactivate$/);
    expect(String(url)).not.toContain("?");
    expect(String(url)).not.toContain("/b3/users/deactivate?");
    // b3 authenticates with the server-instance secret, not the
    // per-user key — and neither may appear in the URL.
    expectBearerAuth(0, "long-enough-admin-secret-12345");
    expect(url).not.toContain("test-key");
    expect((opts as RequestInit).method).toBe("POST");
  });

  it("returns Loomio's { success: true, user } — and the echoed user may still be active", async () => {
    // Deactivation is asynchronous (DeactivateUserWorker); user_json is
    // read back before the job runs, so `active: true` here is what
    // Loomio really answers, not a bug in the tool.
    mockFetch(200, { success: true, user: USER_42 });
    const { deactivateUser } = await import("../src/tools/admin.js");
    const r = await deactivateUser({ id: 42 });
    expect(r.success).toBe(true);
    expect(r.user.id).toBe(42);
    expect(r.user.active).toBe(true);
    expect(r.user.deactivated_at).toBeNull();
    expect(r.user.identities).toEqual([]);
  });

  it("throws if LOOMIO_B3_API_KEY missing", async () => {
    delete process.env["LOOMIO_B3_API_KEY"];
    const { deactivateUser } = await import("../src/tools/admin.js");
    await expect(deactivateUser({ id: 1 })).rejects.toThrow(/LOOMIO_B3_API_KEY/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("surfaces Loomio's 404 for a user that is not currently active", async () => {
    const { LoomioApiError } = await import("../src/loomio/client.js");
    mockFetch(404, { error: "Couldn't find User" });
    const { deactivateUser } = await import("../src/tools/admin.js");
    const err = await deactivateUser({ id: 42 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
  });

  it("a generic 403 is the b3 SECRET being refused — named as LOOMIO_B3_API_KEY, never the per-user key", async () => {
    // Loomio's Api::B3::UsersController#authenticate_api_key! answers a
    // wrong LOOMIO_B3_API_KEY (or a server with B3_API_KEY unset / ≤ 16
    // chars) with the SAME body b2 uses for a rotated per-user key. The
    // per-user key and the health probe (which tests it against
    // GET /b2/groups) are irrelevant here, so a fresh verdict either way
    // must not colour the message — neither "rotated in between" (valid)
    // nor "failing the same way" (rejected).
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { deactivateUser, reactivateUser } = await import("../src/tools/admin.js");
    const verdicts = [undefined, "valid", "rejected"] as const;
    for (const [i, keyStatus] of verdicts.entries()) {
      if (keyStatus) {
        setCachedHealth({
          key_status: keyStatus,
          loomio_version: "3.8.1",
          checked_at: new Date().toISOString(),
        });
      } else {
        resetCachedHealth();
      }
      mockFetch(403, GENERIC_403);
      const call = i % 2 === 0 ? deactivateUser({ id: 42 }) : reactivateUser({ id: 42 });
      const err = await call.catch((e) => e);
      expect(err).toBeInstanceOf(LoomioAuthError);
      expect(err.status).toBe(403);
      expect(err.kind).toBe("unauthenticated");
      expect(err.message).toMatch(/\/b3\/users\/:id\/(de|re)activate/);
      expect(err.message).not.toContain("42");
      expect(err.message).toMatch(/LOOMIO_B3_API_KEY/);
      expect(err.message).toMatch(/ENV\['B3_API_KEY'\]/);
      expect(err.message).not.toContain("/profile/api_access");
      expect(err.message).not.toMatch(/password changes|rotated|update LOOMIO_API_KEY/);
      expect(err.message).not.toMatch(/failing the same way|rotated in between|key-health probe/);
      expect(err.message).not.toContain("long-enough-admin-secret-12345");
    }
  });
});

describe("reactivateUser (b3 admin)", () => {
  it("POSTs the MEMBER route /b3/users/{id}/reactivate with the b3 secret as bearer", async () => {
    mockFetch(200, { success: true, user: { ...USER_42, id: 7 } });
    const { reactivateUser } = await import("../src/tools/admin.js");
    const r = await reactivateUser({ id: 7 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/\/b3\/users\/7\/reactivate$/);
    expect(String(url)).not.toContain("?");
    expectBearerAuth(0, "long-enough-admin-secret-12345");
    expect((opts as RequestInit).method).toBe("POST");
    // Reactivation is synchronous — the echoed user is already active.
    expect(r).toEqual({ success: true, user: { ...USER_42, id: 7 } });
  });

  it("rejects non-positive ids at the schema layer (they would corrupt the path)", async () => {
    const { deactivateUserSchema, reactivateUserSchema } = await import("../src/tools/admin.js");
    for (const schema of [deactivateUserSchema, reactivateUserSchema]) {
      expect(schema.safeParse({ id: 42 }).success).toBe(true);
      expect(schema.safeParse({ id: 0 }).success).toBe(false);
      expect(schema.safeParse({ id: -1 }).success).toBe(false);
      expect(schema.safeParse({ id: 1.5 }).success).toBe(false);
      expect(schema.safeParse({ id: "42/../deactivate" }).success).toBe(false);
    }
  });
});

// ── get_user / list_users (b3 reads) ────────────────────────────────────────

describe("getUser (b3 admin read)", () => {
  it("GETs /b3/users/{id} with the b3 secret as bearer and no query", async () => {
    mockFetch(200, { user: USER_42 });
    const { getUser } = await import("../src/tools/admin.js");
    const r = await getUser({ id: 42 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/b3/users/42");
    expect(String(url)).not.toContain("?");
    expectBearerAuth(0, "long-enough-admin-secret-12345");
    expect(String(url)).not.toContain("test-key");
    expect((opts as RequestInit).method ?? "GET").toBe("GET");
    expect((opts as RequestInit).body).toBeUndefined();
    expect(r).toEqual({ user: USER_42, resolved_by: "id" });
    expect(r.user.email).toBe("ada@example.org"); // b3 rows carry the email — by design, documented
  });

  it("GETs /b3/users/identity/{type}/{uid} with both segments percent-encoded", async () => {
    mockFetch(200, { user: USER_42 });
    const { getUser } = await import("../src/tools/admin.js");
    const r = await getUser({ identity_type: "saml", uid: "ext/12 3?x" });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/b3/users/identity/saml/ext%2F12%203%3Fx");
    expect(String(url)).not.toContain("?");
    expect(r.resolved_by).toBe("identity");
  });

  it("schema: exactly one of id or identity_type + uid", async () => {
    const { getUserSchema } = await import("../src/tools/admin.js");
    expect(getUserSchema.safeParse({}).success).toBe(false);
    expect(getUserSchema.safeParse({ id: 42 }).success).toBe(true);
    expect(getUserSchema.safeParse({ identity_type: "saml", uid: "abc" }).success).toBe(true);
    expect(getUserSchema.safeParse({ identity_type: "saml" }).success).toBe(false);
    expect(getUserSchema.safeParse({ uid: "abc" }).success).toBe(false);
    expect(getUserSchema.safeParse({ id: 42, identity_type: "saml", uid: "abc" }).success).toBe(
      false,
    );
    expect(getUserSchema.safeParse({ id: "42" }).success).toBe(false);
  });

  it("surfaces Loomio's 404 for an unknown user or identity", async () => {
    const { LoomioApiError } = await import("../src/loomio/client.js");
    mockFetch(404, { error: "Couldn't find Identity" });
    const { getUser } = await import("../src/tools/admin.js");
    const err = await getUser({ identity_type: "saml", uid: "nobody" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
  });

  it("a generic 403 on the GET names the b3 secret, with the identity segments redacted", async () => {
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    mockFetch(403, GENERIC_403);
    const { getUser } = await import("../src/tools/admin.js");
    const err = await getUser({ identity_type: "saml", uid: "jane-doe" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/LOOMIO_B3_API_KEY/);
    expect(err.message).toContain("/b3/users/identity/:type/:uid");
    expect(err.message).not.toContain("jane-doe");
  });

  it("is a READ: the client does not refuse it in read-only mode (registration is the gate)", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    try {
      mockFetch(200, { user: USER_42 });
      const { getUser } = await import("../src/tools/admin.js");
      await expect(getUser({ id: 42 })).resolves.toMatchObject({ resolved_by: "id" });
    } finally {
      delete process.env["LOOMIO_MCP_READONLY"];
    }
  });
});

describe("listUsers (b3 admin read)", () => {
  it("GETs /b3/users with no query when is_admin is omitted, and returns rows + scope", async () => {
    const other = {
      ...USER_42,
      id: 43,
      name: "Grace",
      username: "grace",
      email: "grace@example.org",
    };
    mockFetch(200, { users: [USER_42, other] });
    const { listUsers } = await import("../src/tools/admin.js");
    const r = await listUsers({});
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/b3/users");
    expect(String(url)).not.toContain("?");
    expectBearerAuth(0, "long-enough-admin-secret-12345");
    expect(r.users).toEqual([USER_42, other]);
    expect(r.returned).toBe(2);
    expect(r.scope.is_admin).toBeNull();
    expect(r.scope.note).toMatch(/Every account on the Loomio instance/);
    expect(r.scope.note).toMatch(/unpaginated/);
    expect(r.scope.note).toMatch(/email/);
  });

  it("passes is_admin through as a query parameter (Loomio casts the string with ActiveModel::Type::Boolean)", async () => {
    mockFetch(200, { users: [] });
    const { listUsers } = await import("../src/tools/admin.js");
    const r = await listUsers({ is_admin: true });
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/b3/users");
    expect(url.searchParams.get("is_admin")).toBe("true");
    expect(r.returned).toBe(0);
    expect(r.scope.is_admin).toBe(true);
    expect(r.scope.note).toContain("is_admin=true");

    mockFetch(200, { users: [] });
    await listUsers({ is_admin: false });
    expect(new URL(String(vi.mocked(fetch).mock.calls[1]![0])).searchParams.get("is_admin")).toBe(
      "false",
    );
  });

  it("tolerates a missing users root (an empty list, not a crash)", async () => {
    mockFetch(200, {});
    const { listUsers } = await import("../src/tools/admin.js");
    const r = await listUsers();
    expect(r.users).toEqual([]);
    expect(r.returned).toBe(0);
  });

  it("throws if LOOMIO_B3_API_KEY is missing, before any network call", async () => {
    delete process.env["LOOMIO_B3_API_KEY"];
    const { listUsers } = await import("../src/tools/admin.js");
    await expect(listUsers({})).rejects.toThrow(/LOOMIO_B3_API_KEY/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
