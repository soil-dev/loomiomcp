import { describe, it, expect, vi } from "vitest";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("getDiscussion", () => {
  it("GETs /b2/discussions/{id} with api_key in query", async () => {
    mockFetch(200, { discussions: [{ id: 42, title: "Hi" }] });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const result = await getDiscussion({ id_or_key: 42 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/discussions/42");
    expectBearerAuth(0, "test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(result).toEqual({ discussions: [{ id: 42, title: "Hi" }] });
  });

  it("accepts string keys", async () => {
    mockFetch(200, {});
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: "abcDEF12" });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/discussions/abcDEF12");
  });

  it("encodes string keys as a single path segment", async () => {
    mockFetch(200, {});
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: "../memberships?group_id=7" });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url as string).toMatch(/\/b2\/discussions\/\.\.%2Fmemberships%3Fgroup_id%3D7$/);
    expect(url).not.toContain("/b2/memberships");
  });

  it("rejects path-like string keys at schema layer", async () => {
    const { getDiscussionSchema } = await import("../src/tools/discussions.js");
    expect(getDiscussionSchema.safeParse({ id_or_key: "abcDEF12" }).success).toBe(true);
    expect(getDiscussionSchema.safeParse({ id_or_key: "../memberships?group_id=7" }).success).toBe(
      false,
    );
    expect(getDiscussionSchema.safeParse({ id_or_key: "abc/def" }).success).toBe(false);
  });

  it("rejects dot-only string keys before building a URL", async () => {
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: ".." })).rejects.toThrow(/id_or_key/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("createDiscussion", () => {
  it("auto-resolves private from group setting (public_only → false)", async () => {
    // First call: GET /v1/groups/{id}. Second call: POST /b2/discussions.
    mockFetch(200, { groups: [{ id: 7, discussion_privacy_options: "public_only" }] });
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7 });

    const [getUrl] = vi.mocked(fetch).mock.calls[0]!;
    expect(getUrl).toContain("/v1/groups/7");
    const [postUrl, postOpts] = vi.mocked(fetch).mock.calls[1]!;
    expect(postUrl as string).toMatch(/\/b2\/discussions$/);
    expect((postOpts as RequestInit).method).toBe("POST");
    const body = JSON.parse((postOpts as RequestInit).body as string);
    expect(body).toEqual({ title: "T", group_id: 7, private: false });
  });

  it("auto-resolves private from group setting (private_only → true)", async () => {
    mockFetch(200, { groups: [{ id: 7, discussion_privacy_options: "private_only" }] });
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7 });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(body.private).toBe(true);
  });

  it("auto-resolves private from group setting (public_or_private → true, matching Loomio's default)", async () => {
    mockFetch(200, { groups: [{ id: 7, discussion_privacy_options: "public_or_private" }] });
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7 });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(body.private).toBe(true);
  });

  it("falls back to private=true when v1/groups/{id} 403s (hidden group; Loomio forces private_only)", async () => {
    mockFetch(403, { error: 403 });
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7 });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(body.private).toBe(true);
  });

  it("propagates a 401 from the private auto-resolve fetch (v1 path; Loomio's own session 401 or a proxy)", async () => {
    mockFetch(401, { error: "you gotta be signed in" });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await expect(createDiscussion({ title: "T", group_id: 7 })).rejects.toThrow(/401/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("respects explicit private=true (no group fetch)", async () => {
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7, private: true });

    // Only ONE fetch — no group lookup when caller is explicit.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.private).toBe(true);
  });

  it("respects explicit private=false (no group fetch)", async () => {
    mockFetch(200, { discussions: [{ id: 99 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({ title: "T", group_id: 7, private: false });

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.private).toBe(false);
  });

  it("propagates non-403 errors from the group fetch", async () => {
    mockFetch(500, { error: 500 });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await expect(createDiscussion({ title: "T", group_id: 7 })).rejects.toThrow();
  });

  it("a generic 403 on the POST is the key, not group visibility (only the GET index is gated)", async () => {
    // Same path as list_discussions, different method: DiscussionsController
    // #create never calls records_visible_in_group, so Loomio's generic
    // body on the write can only come from authenticate_api_key!. The
    // method must reach the classifier for it to know that.
    mockFetch(403, { error: "You are not authorized to access this page." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { createDiscussion } = await import("../src/tools/discussions.js");
    const err = await createDiscussion({ title: "T", group_id: 7, private: true }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toContain("/b2/discussions");
    expect(err.message).toMatch(/not a visibility or role problem/);
    expect(err.message).not.toMatch(/not visible|visibility problem|\?group_id= list/);
    expect(err.message).toContain("/profile/api_access");
  });

  it("requires title and group_id at schema layer", async () => {
    const { createDiscussionSchema } = await import("../src/tools/discussions.js");
    expect(createDiscussionSchema.safeParse({ title: "T" }).success).toBe(false);
    expect(createDiscussionSchema.safeParse({ group_id: 1 }).success).toBe(false);
    expect(createDiscussionSchema.safeParse({ title: "T", group_id: 1 }).success).toBe(true);
  });
});

describe("listDiscussions", () => {
  it("GETs /b2/discussions with group_id, status, limit, offset", async () => {
    mockFetch(200, { discussions: [] });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7, status: "all", limit: 100, offset: 50 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/discussions?");
    expect(url).toContain("group_id=7");
    expect(url).toContain("status=all");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=50");
    expectBearerAuth(0, "test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("always sends status — 'open' by default — and omits limit/offset when not supplied", async () => {
    // Loomio's own default for a missing `status` is `scope.kept`, i.e.
    // EVERY kept thread including locked ones; the connector documents
    // 'open' as its default, so it must say so on the wire.
    mockFetch(200, {});
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("status=open");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("offset=");
  });

  it("passes an explicit status through unchanged", async () => {
    const { listDiscussions } = await import("../src/tools/discussions.js");
    for (const status of ["open", "closed", "all"] as const) {
      mockFetch(200, {});
      await listDiscussions({ group_id: 7, status });
      const [url] = vi.mocked(fetch).mock.calls.at(-1)!;
      expect(url).toContain(`status=${status}`);
    }
  });

  it("accepts all three status values", async () => {
    const { listDiscussionsSchema } = await import("../src/tools/discussions.js");
    for (const s of ["open", "closed", "all"]) {
      expect(listDiscussionsSchema.safeParse({ group_id: 1, status: s }).success).toBe(true);
    }
    expect(listDiscussionsSchema.safeParse({ group_id: 1, status: "bogus" }).success).toBe(false);
  });
});
