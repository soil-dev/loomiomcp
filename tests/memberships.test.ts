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
