import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("classifyGroupForbidden", () => {
  it("treats a 200 from the member-gated probe as not_admin", async () => {
    mockFetch(200, { polls: [] });
    const { classifyGroupForbidden } = await import("../src/loomio/access.js");
    expect(await classifyGroupForbidden(2)).toEqual({ kind: "not_admin" });
  });

  it("treats a 403 from the probe as no_access", async () => {
    mockFetch(403, { error: 403 });
    const { classifyGroupForbidden } = await import("../src/loomio/access.js");
    expect(await classifyGroupForbidden(2)).toEqual({ kind: "no_access" });
  });

  it("treats anything else as inconclusive, carrying the status", async () => {
    mockFetch(500, { error: "boom" });
    const { classifyGroupForbidden } = await import("../src/loomio/access.js");
    expect(await classifyGroupForbidden(2)).toEqual({ kind: "inconclusive", probeStatus: 500 });
  });

  it("probes the member-gated b2/polls endpoint for the given group", async () => {
    mockFetch(200, { polls: [] });
    const { classifyGroupForbidden } = await import("../src/loomio/access.js");
    const { fetch } = await import("undici");
    await classifyGroupForbidden(42);
    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain("/b2/polls?");
    expect(url).toContain("group_id=42");
    expect(url).toContain("status=all");
  });
});

describe("adminRequiredError", () => {
  it("not_admin: blames the role, not the key, and appends the fallback", async () => {
    const { adminRequiredError } = await import("../src/loomio/access.js");
    const err = adminRequiredError({
      groupId: 3,
      resource: "the member list (names, emails, roles)",
      classification: { kind: "not_admin" },
      fallback: "Use get_user_activity instead.",
    });
    expect(err.status).toBe(403);
    expect(err.message).toContain("group 3");
    expect(err.message).toMatch(/admin|coordinator/i);
    expect(err.message).toContain("Use get_user_activity instead.");
    expect(err.message).not.toMatch(/invalid or expired/i);
  });

  it("no_access: names both the bad-key and not-a-member possibilities", async () => {
    const { adminRequiredError } = await import("../src/loomio/access.js");
    const err = adminRequiredError({
      groupId: 8,
      resource: "the member list",
      classification: { kind: "no_access" },
    });
    expect(err.message).toContain("group 8");
    expect(err.message).toMatch(/invalid or expired/i);
    expect(err.message).toMatch(/not a member/i);
  });

  it("inconclusive: surfaces the probe status", async () => {
    const { adminRequiredError } = await import("../src/loomio/access.js");
    const err = adminRequiredError({
      groupId: 5,
      resource: "the member list",
      classification: { kind: "inconclusive", probeStatus: 502 },
    });
    expect(err.message).toContain("group 5");
    expect(err.message).toContain("502");
  });
});
