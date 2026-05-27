import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
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
    expect(url).toContain("api_key=test-key");
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
    expect(url).toContain("/b2/discussions/..%2Fmemberships%3Fgroup_id%3D7?");
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
    expect(postUrl).toContain("/b2/discussions?");
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

  it("propagates 401 from the private auto-resolve fetch", async () => {
    mockFetch(401, { error: "bad api key" });
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
    expect(url).toContain("api_key=test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("omits optional params when not supplied", async () => {
    mockFetch(200, {});
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).not.toContain("status=");
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("offset=");
  });

  it("accepts all three status values", async () => {
    const { listDiscussionsSchema } = await import("../src/tools/discussions.js");
    for (const s of ["open", "closed", "all"]) {
      expect(listDiscussionsSchema.safeParse({ group_id: 1, status: s }).success).toBe(true);
    }
    expect(listDiscussionsSchema.safeParse({ group_id: 1, status: "bogus" }).success).toBe(false);
  });
});
