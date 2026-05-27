import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("createComment", () => {
  it("POSTs /b2/comments with discussion_id in URL, FORM-encoded body (avoids Rails wrap_parameters bug)", async () => {
    mockFetch(200, { comments: [{ id: 1 }] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 42, body: "hi" });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/comments?");
    expect(url).toContain("discussion_id=42");
    expect(url).toContain("api_key=test-key");
    const r = opts as RequestInit & { headers: Record<string, string> };
    expect(r.method).toBe("POST");
    expect(r.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(r.body as string);
    expect(form.get("body")).toBe("hi");
    expect(form.get("comment")).toBeNull();
    expect(form.get("discussion_id")).toBeNull();
  });

  it("includes body_format when supplied (form-encoded)", async () => {
    mockFetch(200, {});
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 1, body: "**bold**", body_format: "md" });
    const opts = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    const form = new URLSearchParams(opts.body as string);
    expect(form.get("body")).toBe("**bold**");
    expect(form.get("body_format")).toBe("md");
  });

  it("rejects empty body at schema layer", async () => {
    const { createCommentSchema } = await import("../src/tools/comments.js");
    expect(createCommentSchema.safeParse({ discussion_id: 1, body: "" }).success).toBe(false);
  });
});
