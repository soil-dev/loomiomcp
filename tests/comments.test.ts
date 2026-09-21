/**
 * Comment writes (src/tools/comments.ts) on Loomio 3.8.1: FLAT JSON
 * bodies — the shape Loomio's own controller tests post `as: :json`
 * ("create happy case", "create accepts a bearer token with flat
 * parameters", "update accepts a bearer token with flat parameters",
 * "destroy soft deletes comment"). `Api::B2::CommentsController#create`
 * reads `discussion_id` from the top level; `body` / `body_format` /
 * `parent_id` / `parent_type` are Comment columns that Rails'
 * wrap_parameters folds into the permitted hash. The ≤ 3.1.2
 * form-encoding workaround is gone; a `{comment: {…}}` wrapper 400s.
 */

import { describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { commentRow, discussionRow, GRACE } from "./fixtures.js";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  const r = opts as RequestInit & { headers: Record<string, string> };
  return {
    url: new URL(String(url)),
    r,
    body: r.body ? (JSON.parse(r.body as string) as Record<string, unknown>) : undefined,
  };
}

describe("createComment", () => {
  it("POSTs /b2/comments with a FLAT JSON body carrying discussion_id (Loomio's own test shape)", async () => {
    mockFetch(200, { comments: [commentRow({ id: 1 })] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 42, body: "hi" });

    const { url, r, body } = requestOf();
    expect(url.pathname).toBe("/api/b2/comments");
    expect(url.search).toBe("");
    expectBearerAuth(0, "test-key");
    expect(r.method).toBe("POST");
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(body).toEqual({ discussion_id: 42, body: "hi" });
    // Not wrapped: `{comment: {…}}` would hide discussion_id from the controller (400, verified live).
    expect(body).not.toHaveProperty("comment");
  });

  // `comments.parent_id` is an integer column: a short key on the wire
  // would be cast to 0 (a thread-less comment). Search hits and URLs hand
  // the caller a key, so the tool resolves it first — one compact GET.
  it("a short key as discussion_id is resolved with ONE compact GET /b2/discussions/{key} and the POST carries the numeric id", async () => {
    mockFetch(200, { discussions: [discussionRow({ id: 601, key: "dscKEY01" })] });
    mockFetch(200, { comments: [commentRow({ id: 1, parent_id: 601 })] });
    const { createComment } = await import("../src/tools/comments.js");
    const r = await createComment({ discussion_id: "dscKEY01", body: "hi" });

    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    const get = requestOf(0);
    expect(get.r.method ?? "GET").toBe("GET");
    expect(get.url.pathname).toBe("/api/b2/discussions/dscKEY01");
    expect(get.url.searchParams.get("compact")).toBe("1");
    const post = requestOf(1);
    expect(post.r.method).toBe("POST");
    expect(post.url.pathname).toBe("/api/b2/comments");
    expect(post.body).toEqual({ discussion_id: 601, body: "hi" });
    expect(r.comment.parent_id).toBe(601);
  });

  it("an unknown key is the resolver's 404 ('no such id or key') before any POST", async () => {
    mockFetch(404, { error: 404 });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createComment } = await import("../src/tools/comments.js");
    const err = await createComment({ discussion_id: "nosuchKEY", body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/no discussion with id or key "nosuchKEY"/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("a numeric discussion_id costs no resolution call (schema accepts both forms)", async () => {
    const { createCommentSchema } = await import("../src/tools/comments.js");
    expect(createCommentSchema.safeParse({ discussion_id: "dscKEY01", body: "x" }).success).toBe(
      true,
    );
    expect(createCommentSchema.safeParse({ discussion_id: "a/b", body: "x" }).success).toBe(false);
    mockFetch(200, { comments: [commentRow()] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 42, body: "hi" });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  // body_format defaults to "md" on Loomio's side (db/schema.rb) — there is
  // no group default — so HTML without it would be stored as Markdown.
  it("refuses an HTML body without body_format at the schema; the description names the real default", async () => {
    const { createCommentSchema } = await import("../src/tools/comments.js");
    const r = createCommentSchema.safeParse({ discussion_id: 1, body: "<p>Hello</p>" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/body_format/);
    expect(
      createCommentSchema.safeParse({ discussion_id: 1, body: "<p>Hello</p>", body_format: "html" })
        .success,
    ).toBe(true);
    expect(createCommentSchema.safeParse({ discussion_id: 1, body: "Hello **md**" }).success).toBe(
      true,
    );
    // Wording-tolerant: the guard is that the text names 'md' as the default
    // and no longer claims a (non-existent) group-level default.
    const shape = createCommentSchema.def.shape as Record<string, { description?: string }>;
    expect(shape["body_format"]!.description).toMatch(/default/i);
    expect(shape["body_format"]!.description).toMatch(/'md'/);
    expect(shape["body_format"]!.description).not.toMatch(/group default/);
  });

  it("includes body_format when supplied and omits it when not", async () => {
    mockFetch(200, { comments: [commentRow()] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 1, body: "**bold**", body_format: "md" });
    expect(requestOf().body).toEqual({ discussion_id: 1, body: "**bold**", body_format: "md" });

    mockFetch(200, { comments: [commentRow()] });
    await createComment({ discussion_id: 1, body: "plain" });
    expect(requestOf(1).body).not.toHaveProperty("body_format");
  });

  it("a threaded reply sends parent_id + parent_type flat (the controller only falls back to discussion_id when parent_id is blank)", async () => {
    mockFetch(200, {
      comments: [commentRow({ id: 1703, parent_id: 1701, parent_type: "Comment" })],
    });
    const { createComment } = await import("../src/tools/comments.js");
    const r = await createComment({ parent_id: 1701, parent_type: "Comment", body: "Agreed." });
    expect(requestOf().body).toEqual({ parent_id: 1701, parent_type: "Comment", body: "Agreed." });
    expect(r.comment.parent_type).toBe("Comment");
    expect(r.comment.parent_id).toBe(1701);
  });

  it("discussion_id and an explicit parent may travel together (Loomio lets the parent win)", async () => {
    mockFetch(200, { comments: [commentRow()] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({
      discussion_id: 601,
      parent_id: 301,
      parent_type: "Poll",
      body: "On the poll",
    });
    expect(requestOf().body).toEqual({
      discussion_id: 601,
      parent_id: 301,
      parent_type: "Poll",
      body: "On the poll",
    });
  });

  it("returns the comment shaped like list_thread_items does (body whole, bloat dropped) plus its author", async () => {
    mockFetch(200, {
      comments: [commentRow({ id: 1, topic_id: 701, body: "<p>hi</p>", author_id: 502 })],
      users: [GRACE],
    });
    const { createComment } = await import("../src/tools/comments.js");
    const r = await createComment({ discussion_id: 601, body: "hi" });
    expect(Object.keys(r).sort()).toEqual(["comment", "users"]);
    expect(r.comment).toEqual(
      expect.objectContaining({
        id: 1,
        topic_id: 701,
        body: "<p>hi</p>",
        body_format: "html",
        author_id: 502,
        parent_id: 601,
        parent_type: "Discussion",
      }),
    );
    expect(r.comment).not.toHaveProperty("content_locale");
    expect(r.comment).not.toHaveProperty("body_truncated");
    expect(r.users).toEqual([{ id: 502, name: "Grace Sample", username: "grace" }]);
  });

  it("names an echo without a comment record instead of returning an empty success", async () => {
    mockFetch(200, {});
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createComment } = await import("../src/tools/comments.js");
    const err = await createComment({ discussion_id: 1, body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/POST \/b2\/comments without a comment record/);
  });

  it("schema: a target is required; parent_id and parent_type go together; body must be non-empty", async () => {
    const { createCommentSchema } = await import("../src/tools/comments.js");
    expect(createCommentSchema.safeParse({ discussion_id: 1, body: "" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "x" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ parent_id: 5, body: "x" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ parent_type: "Comment", body: "x" }).success).toBe(
      false,
    );
    expect(
      createCommentSchema.safeParse({ parent_id: 5, parent_type: "Comment", body: "x" }).success,
    ).toBe(true);
    expect(
      createCommentSchema.safeParse({ parent_id: 5, parent_type: "Tag", body: "x" }).success,
    ).toBe(false);
    expect(createCommentSchema.safeParse({ discussion_id: 1, body: "x" }).success).toBe(true);
  });

  it("a 403 'Not authorized to create Comment.' is a permission refusal (locked thread / not a member)", async () => {
    mockFetch(403, { error: "Not authorized to create Comment." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { createComment } = await import("../src/tools/comments.js");
    const err = await createComment({ discussion_id: 1, body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
  });
});

describe("updateComment", () => {
  it("PATCHes /b2/comments/{id} with a FLAT {body, body_format} body (Loomio test 'update accepts a bearer token with flat parameters')", async () => {
    mockFetch(200, {
      comments: [commentRow({ id: 5, body: "Edited", body_format: "md", versions_count: 2 })],
      users: [GRACE],
    });
    const { updateComment } = await import("../src/tools/comments.js");
    const r = await updateComment({ id: 5, body: "Edited", body_format: "md" });

    const { url, r: req, body } = requestOf();
    expect(url.pathname).toBe("/api/b2/comments/5");
    expect(url.search).toBe("");
    expect(req.method).toBe("PATCH");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(body).toEqual({ body: "Edited", body_format: "md" });
    expect(body).not.toHaveProperty("comment");
    expect(body).not.toHaveProperty("id");
    expect(r.comment.body).toBe("Edited");
    expect(r.comment.versions_count).toBe(2);
  });

  it("takes a numeric id only (comments have no short key) and never offers parent fields", async () => {
    const { updateCommentSchema } = await import("../src/tools/comments.js");
    expect(updateCommentSchema.safeParse({ id: "abcDEF12", body: "x" }).success).toBe(false);
    expect(updateCommentSchema.safeParse({ id: 0, body: "x" }).success).toBe(false);
    expect(updateCommentSchema.safeParse({ id: 5, body: "" }).success).toBe(false);
    expect(updateCommentSchema.safeParse({ id: 5, body: "x" }).success).toBe(true);
    const shape = updateCommentSchema.def.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("parent_id");
    expect(shape).not.toHaveProperty("discussion_id");
  });

  it("a 403 'Not authorized to update Comment.' (members_can_edit_comments off) is a permission refusal", async () => {
    mockFetch(403, { error: "Not authorized to update Comment." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { updateComment } = await import("../src/tools/comments.js");
    const err = await updateComment({ id: 5, body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
    expect(err.message).toContain("/b2/comments/:id");
    expect(err.message).not.toMatch(/\b5\b/);
  });
});

describe("deleteComment", () => {
  it("DELETEs /b2/comments/{id} and reports the soft discard (body nulled, discarded_at set)", async () => {
    mockFetch(200, {
      comments: [
        commentRow({ id: 5, body: null, discarded_at: "2026-09-20T10:00:00Z", discarded_by: 501 }),
      ],
    });
    const { deleteComment } = await import("../src/tools/comments.js");
    const r = await deleteComment({ id: 5 });

    const { url, r: req, body } = requestOf();
    expect(url.pathname).toBe("/api/b2/comments/5");
    expect(req.method).toBe("DELETE");
    expect(body).toEqual({});
    expect(r.discarded).toBe(true);
    expect(r.comment.body).toBeNull();
    expect(r.comment.discarded_at).toBe("2026-09-20T10:00:00Z");
    expect(r.note).toMatch(/Soft-discarded/);
    expect(r.note).toMatch(/Nothing was permanently deleted/);
  });

  it("a 403 'Not authorized to discard Comment.' is a permission refusal", async () => {
    mockFetch(403, { error: "Not authorized to discard Comment." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { deleteComment } = await import("../src/tools/comments.js");
    const err = await deleteComment({ id: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
  });

  it("an unknown id is Loomio's 404", async () => {
    mockFetch(404, { error: 404 });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { deleteComment } = await import("../src/tools/comments.js");
    const err = await deleteComment({ id: 999 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
  });
});
