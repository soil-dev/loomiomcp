/**
 * Discussion tools (src/tools/discussions.ts) on Loomio 3.8.1: the
 * `exclude_types` read profiles (never `compact`, which drops the
 * `topics` root the counters live on), the topics join, description
 * truncation, canonical urls, `meta.total`, the `include_items` seam,
 * and the NESTED create body that replaces the 0.0.11 v1 pre-flight.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { htmlToText, TOPIC_JOIN_FIELDS } from "../src/loomio/shape.js";
import {
  ADA,
  DISCUSSION_2,
  discussionRow,
  discussionShowBody,
  discussionsListBody,
  EXAMPLE_ORG,
  LONG_HTML,
  topicRow,
} from "./fixtures.js";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
afterEach(() => delete process.env["LOOMIO_API_BASE_URL"]);

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  const r = (opts ?? {}) as RequestInit;
  return {
    url: new URL(String(url)),
    method: r.method ?? "GET",
    body: r.body ? (JSON.parse(r.body as string) as Record<string, unknown>) : undefined,
  };
}

const READER_FIELDS = [
  "reader_volume_email",
  "reader_volume_push",
  "last_read_at",
  "dismissed_at",
  "read_ranges",
  "reader_inviter_id",
  "reader_guest",
  "reader_admin",
  "ranges",
  "max_depth",
];

describe("getDiscussion", () => {
  it("GETs /b2/discussions/{id} with the show profile (keeps topics and groups) and shapes the record", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601 });

    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/discussions/601");
    expect(req.method).toBe("GET");
    expect(req.url.searchParams.get("exclude_types")).toBe(
      "parent membership reaction translation",
    );
    expect(req.url.searchParams.has("compact")).toBe(false);
    expectBearerAuth(0, "test-key");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);

    // Topic counters are folded onto the discussion …
    expect(r.discussion).toMatchObject({
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      group_id: 7,
      topic_id: 701,
      author_id: 502,
      versions_count: 4,
      items_count: 9,
      replies_count: 8,
      last_activity_at: "2026-08-15T09:03:41.491Z",
      locked_at: null,
      pinned_at: "2026-05-29T11:28:24.096Z",
      tags: ["guide"],
      members_count: 369,
      seen_by_count: 103,
      active_polls_count: 0,
      closed_polls_count: 0,
      attachments_count: 1,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    for (const f of TOPIC_JOIN_FIELDS) expect(r.discussion).toHaveProperty(f);
    // … the reader-state and loading internals are not.
    for (const f of READER_FIELDS) expect(r.discussion).not.toHaveProperty(f);
    for (const f of ["attachments", "link_previews", "content_locale", "mentioned_usernames"]) {
      expect(r.discussion).not.toHaveProperty(f);
    }
    // The show returns the FULL description.
    expect(r.discussion.description).toBe(LONG_HTML);
    expect(r.discussion).not.toHaveProperty("description_truncated");
    // Group and users are slim.
    expect(r.group).toEqual({
      id: 7,
      key: "grpKEY07",
      handle: "example-org",
      name: "Example Org",
      full_name: "Example Org",
      group_privacy: "open",
      is_visible_to_public: true,
      discussion_privacy_options: "public_only",
      memberships_count: 12,
      discussions_count: 21,
      polls_count: 2,
      enabled: true,
      parent_id: null,
    });
    expect(r.users).toEqual([{ id: 502, name: "Grace Sample", username: "grace" }]);
    expect(r).not.toHaveProperty("thread_items");
  });

  it("builds the url from LOOMIO_API_BASE_URL minus /api", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api";
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: "dscKEY01" });
    expect(requestOf().url.pathname).toBe("/api/b2/discussions/dscKEY01");
    expect(r.discussion.url).toBe("https://loomio.example.org/d/dscKEY01/budget-planning-for-2027");
  });

  it("strip_html: true converts the HTML description to plain text (description_format 'text'), whole and unflagged; the default keeps the stored HTML", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601, strip_html: true });
    expect(r.discussion.description).toBe(htmlToText(LONG_HTML));
    expect(r.discussion.description).not.toContain("<");
    expect(r.discussion.description_format).toBe("text");
    expect(r.discussion).not.toHaveProperty("description_truncated");
    expect(r.discussion).not.toHaveProperty("description_chars");
    mockFetch(200, discussionShowBody());
    const kept = await getDiscussion({ id_or_key: 601, strip_html: false });
    expect(kept.discussion.description).toBe(LONG_HTML);
    expect(kept.discussion.description_format).toBe("html");
  });

  it("include_items: calls the thread-items seam with the record's OWN topic_id (no second lookup) and embeds the result", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const fetchItems = vi.fn(async (input: { topic_id: number }) => ({
      topic_id: input.topic_id,
      items: [{ id: 1, kind: "new_discussion" }],
      total: 1,
      returned: 1,
    }));
    const r = await getDiscussion({ id_or_key: 601, include_items: true }, { fetchItems });
    expect(fetchItems).toHaveBeenCalledTimes(1);
    // The record travels along so the items request can exclude the
    // opening post (`items_known_thread`) and the header needs nothing
    // from that response.
    expect(fetchItems).toHaveBeenCalledWith(
      { topic_id: 701 },
      {
        type: "Discussion",
        id: 601,
        key: "dscKEY01",
        title: "Budget planning for 2027",
        group_id: 7,
      },
    );
    expect(r.thread_items).toEqual({
      topic_id: 701,
      items: [{ id: 1, kind: "new_discussion" }],
      total: 1,
      returned: 1,
    });
    // Only the discussion GET went over the wire from this module.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("include_items forwards items_limit / items_body_max_chars to the seam, and nothing else", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const fetchItems = vi.fn(async () => ({ topic_id: 701, items: [], total: 0, returned: 0 }));
    await getDiscussion(
      { id_or_key: 601, include_items: true, items_limit: 50, items_body_max_chars: 800 },
      { fetchItems },
    );
    expect(fetchItems).toHaveBeenCalledWith(
      { topic_id: 701, limit: 50, body_max_chars: 800 },
      expect.objectContaining({ type: "Discussion", id: 601 }),
    );
  });

  it("include_items false / absent never touches the seam", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const fetchItems = vi.fn();
    await getDiscussion({ id_or_key: 601, include_items: false }, { fetchItems });
    expect(fetchItems).not.toHaveBeenCalled();
  });

  it("include_items with a record lacking topic_id: thread_items null plus a scope note, no seam call", async () => {
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ topic_id: undefined })] }));
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const fetchItems = vi.fn();
    const r = await getDiscussion({ id_or_key: 601, include_items: true }, { fetchItems });
    expect(fetchItems).not.toHaveBeenCalled();
    expect(r.thread_items).toBeNull();
    expect(r.scope?.note).toMatch(/no topic_id/);
  });

  it("the default seam is the threads module's listThreadItems", async () => {
    mockFetch(200, discussionShowBody());
    const threads = await import("../src/tools/threads.js");
    const spy = vi.spyOn(threads, "listThreadItems").mockResolvedValue({
      topic_id: 701,
      items: [],
      total: 0,
      returned: 0,
    });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601, include_items: true });
    expect(spy).toHaveBeenCalledWith(
      { topic_id: 701 },
      expect.objectContaining({ type: "Discussion", id: 601 }),
    );
    expect(r.thread_items).toMatchObject({ topic_id: 701 });
    spy.mockRestore();
  });

  it("a record whose topic is missing from topics[] comes back without counters (no zeros invented)", async () => {
    mockFetch(200, discussionShowBody({ topics: [] }));
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601 });
    expect(r.discussion.id).toBe(601);
    expect(r.discussion).not.toHaveProperty("items_count");
    expect(r.discussion).not.toHaveProperty("replies_count");
  });

  it("a 200 without a discussion record is a shape error", async () => {
    mockFetch(200, { discussions: [], meta: { root: "discussions" } });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 601 })).rejects.toThrow(/without a discussion record/);
  });

  it("encodes string keys as a single path segment", async () => {
    mockFetch(200, discussionShowBody());
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: "../memberships?group_id=7" });
    expect(requestOf().url.pathname).toBe("/api/b2/discussions/..%2Fmemberships%3Fgroup_id%3D7");
  });

  it("rejects path-like string keys at schema layer and dot-only keys before any request", async () => {
    const { getDiscussion, getDiscussionSchema } = await import("../src/tools/discussions.js");
    expect(getDiscussionSchema.safeParse({ id_or_key: "abcDEF12" }).success).toBe(true);
    expect(
      getDiscussionSchema.safeParse({ id_or_key: "abcDEF12", include_items: true }).success,
    ).toBe(true);
    expect(getDiscussionSchema.safeParse({ id_or_key: "../memberships?group_id=7" }).success).toBe(
      false,
    );
    expect(getDiscussionSchema.safeParse({ id_or_key: "abc/def" }).success).toBe(false);
    await expect(getDiscussion({ id_or_key: ".." })).rejects.toThrow(/id_or_key/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('403 "Not authorized to show Discussion." is classified as a permission refusal, not a key problem', async () => {
    mockFetch(403, { error: "Not authorized to show Discussion." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const err = await getDiscussion({ id_or_key: 601 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
    expect(err.message).toMatch(/lacks permission/);
  });
});

describe("listDiscussions", () => {
  it("GETs /b2/discussions with group_id, explicit status, pagination and the list profile", async () => {
    mockFetch(200, discussionsListBody());
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7, status: "all", limit: 100, offset: 50 });

    const { url, method } = requestOf();
    expect(url.pathname).toBe("/api/b2/discussions");
    expect(method).toBe("GET");
    expect(url.searchParams.get("group_id")).toBe("7");
    expect(url.searchParams.get("status")).toBe("all");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("50");
    // The list profile drops the group (the caller passed the id) but
    // KEEPS topics; `compact=1` would drop them.
    expect(url.searchParams.get("exclude_types")).toBe(
      "group parent membership reaction translation",
    );
    expect(url.searchParams.has("compact")).toBe(false);
    expectBearerAuth(0, "test-key");
  });

  it("always sends status — 'open' by default — and omits limit/offset when not supplied", async () => {
    // Loomio reads anything but locked/closed/unlocked/open as "every
    // kept thread"; the connector's documented default must be on the wire.
    mockFetch(200, discussionsListBody());
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({ group_id: 7 });
    const { url } = requestOf();
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
    expect(r.scope).toEqual({
      group_id: 7,
      status: "open",
      offset: 0,
      description_max_chars: 1500,
      strip_html: true,
    });
  });

  it("passes each explicit status through unchanged", async () => {
    const { listDiscussions } = await import("../src/tools/discussions.js");
    for (const status of ["open", "closed", "all"] as const) {
      mockFetch(200, discussionsListBody());
      await listDiscussions({ group_id: 7, status });
      const url = new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]));
      expect(url.searchParams.get("status")).toBe(status);
    }
  });

  it("joins topics onto each discussion, slims users, surfaces meta.total and returned", async () => {
    mockFetch(200, discussionsListBody());
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({ group_id: 7 });

    expect(r.total).toBe(13);
    expect(r.returned).toBe(2);
    expect(r.discussions.map((d) => d.id)).toEqual([601, 602]);
    expect(r.discussions[0]).toMatchObject({
      items_count: 9,
      replies_count: 8,
      pinned_at: "2026-05-29T11:28:24.096Z",
      tags: ["guide"],
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    expect(r.discussions[1]).toMatchObject({
      id: 602,
      items_count: 1,
      replies_count: 0,
      members_count: 27,
      tags: [],
      url: "https://www.loomio.com/d/dscKEY02/how-to-nominate-a-candidate",
    });
    for (const f of READER_FIELDS) expect(r.discussions[0]).not.toHaveProperty(f);
    expect(r.users).toEqual([
      { id: 502, name: "Grace Sample", username: "grace" },
      { id: 503, name: "Linus Placeholder", username: "linus" },
    ]);
    // No groups root was requested, so none is returned.
    expect(r).not.toHaveProperty("groups");
  });

  it("strip_html: false — an HTML description longer than the cap is stripped of tag attributes before the cut; description_chars is the stored length; short bodies are byte-identical", async () => {
    const anchor =
      '<a target="_blank" href="https://example.org/plan" rel="nofollow ugc noreferrer noopener">the plan</a>';
    const long = `<h2 id="budget-planning">Budget planning</h2><p>Read ${anchor} ${"carefully. ".repeat(40)}</p>`;
    mockFetch(200, discussionsListBody({ discussions: [discussionRow({ description: long })] }));
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({
      group_id: 7,
      description_max_chars: 100,
      strip_html: false,
    });
    const d = r.discussions[0]!;
    expect((d.description as string).length).toBe(100);
    expect(d.description as string).toMatch(
      /^<h2>Budget planning<\/h2><p>Read <a href="https:\/\/example.org\/plan">the plan<\/a> carefully\./,
    );
    expect(d.description).not.toContain("rel=");
    expect(d.description_format).toBe("html");
    expect(d.description_truncated).toBe(true);
    expect(d.description_chars).toBe(long.length);
    expect(r.scope.strip_html).toBe(false);
    // The compacted text fits the default cap here, so the flags are off but the markup is compact.
    mockFetch(200, discussionsListBody({ discussions: [discussionRow({ description: long })] }));
    const fits = await listDiscussions({
      group_id: 7,
      description_max_chars: long.length - 5,
      strip_html: false,
    });
    expect(fits.discussions[0]!.description).not.toContain("target=");
    expect(fits.discussions[0]).not.toHaveProperty("description_truncated");
    // get_discussion returns the stored HTML untouched.
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ description: long })] }));
    const { getDiscussion } = await import("../src/tools/discussions.js");
    expect((await getDiscussion({ id_or_key: 601 })).discussion.description).toBe(long);
  });

  it("by default (strip_html true) an HTML description becomes plain text BEFORE the 1500-char cap: description_format 'text', the flags describe the text; short and Markdown bodies stay whole", async () => {
    const md = discussionRow({
      id: 604,
      key: "dscKEY04",
      topic_id: 704,
      description: "# Plan\n\nSome *Markdown* with an inline <br> tag.",
      description_format: "md",
    });
    mockFetch(200, discussionsListBody({ discussions: [discussionRow(), DISCUSSION_2, md] }));
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({ group_id: 7 });
    const text = htmlToText(LONG_HTML);
    expect(text.length).toBeGreaterThan(1500);
    const long = r.discussions[0]!;
    expect(long.description).toBe(text.slice(0, 1500));
    expect(long.description).not.toContain("<");
    expect(long.description_format).toBe("text");
    expect(long.description_truncated).toBe(true);
    expect(long.description_chars).toBe(text.length);
    const short = r.discussions[1]!;
    expect(short.description).toBe("Short guide.");
    expect(short.description_format).toBe("text");
    expect(short).not.toHaveProperty("description_truncated");
    expect(short).not.toHaveProperty("description_chars");
    // Markdown is already readable: never rewritten, format kept.
    expect(r.discussions[2]!.description).toBe(md.description);
    expect(r.discussions[2]!.description_format).toBe("md");
    expect(r.scope.strip_html).toBe(true);
  });

  it("description_max_chars: 0 omits the body (keeping its length), -1 returns it whole, N caps it — with strip_html the length is the text's", async () => {
    const { listDiscussions } = await import("../src/tools/discussions.js");

    mockFetch(200, discussionsListBody());
    const omitted = await listDiscussions({
      group_id: 7,
      description_max_chars: 0,
      strip_html: false,
    });
    expect(omitted.discussions[0]).not.toHaveProperty("description");
    expect(omitted.discussions[0]!.description_omitted).toBe(true);
    expect(omitted.discussions[0]!.description_chars).toBe(LONG_HTML.length);
    expect(omitted.scope.description_max_chars).toBe(0);

    mockFetch(200, discussionsListBody());
    const full = await listDiscussions({
      group_id: 7,
      description_max_chars: -1,
      strip_html: false,
    });
    expect(full.discussions[0]!.description).toBe(LONG_HTML);
    expect(full.discussions[0]).not.toHaveProperty("description_truncated");

    mockFetch(200, discussionsListBody());
    const capped = await listDiscussions({
      group_id: 7,
      description_max_chars: 40,
      strip_html: false,
    });
    expect((capped.discussions[0]!.description as string).length).toBe(40);
    expect(capped.discussions[0]!.description_truncated).toBe(true);

    mockFetch(200, discussionsListBody());
    const omittedText = await listDiscussions({ group_id: 7, description_max_chars: 0 });
    expect(omittedText.discussions[0]!.description_omitted).toBe(true);
    expect(omittedText.discussions[0]!.description_chars).toBe(htmlToText(LONG_HTML).length);
    expect(omittedText.discussions[0]!.description_format).toBe("text");
  });

  it("a discarded discussion (no title / description) still shapes cleanly with a slug-less url", async () => {
    const discarded = discussionRow({
      id: 603,
      key: "dscKEY03",
      topic_id: 703,
      title: undefined,
      description: undefined,
      discarded_at: "2026-09-01T00:00:00Z",
    });
    mockFetch(
      200,
      discussionsListBody({
        discussions: [discarded],
        topics: [topicRow({ id: 703, topicable_id: 603, discussion_id: 603 })],
        meta: { root: "discussions", total: 1 },
      }),
    );
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({ group_id: 7, status: "all" });
    expect(r.discussions[0]).toMatchObject({
      id: 603,
      discarded_at: "2026-09-01T00:00:00Z",
      url: "https://www.loomio.com/d/dscKEY03",
    });
    expect(r.discussions[0]).not.toHaveProperty("description_truncated");
  });

  it("an empty page carries total from meta and returned 0", async () => {
    mockFetch(200, {
      discussions: [],
      users: [],
      topics: [],
      meta: { root: "discussions", total: 13 },
    });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const r = await listDiscussions({ group_id: 7, offset: 200 });
    expect(r.discussions).toEqual([]);
    expect(r.total).toBe(13);
    expect(r.returned).toBe(0);
    expect(r.scope.offset).toBe(200);
  });

  it("schema: accepts the three statuses, rejects others; description_max_chars ≥ -1; strip_html is a boolean", async () => {
    const { getDiscussionSchema, listDiscussionsSchema } = await import(
      "../src/tools/discussions.js"
    );
    for (const s of ["open", "closed", "all"]) {
      expect(listDiscussionsSchema.safeParse({ group_id: 1, status: s }).success).toBe(true);
    }
    expect(listDiscussionsSchema.safeParse({ group_id: 1, status: "bogus" }).success).toBe(false);
    expect(
      listDiscussionsSchema.safeParse({ group_id: 1, description_max_chars: -1 }).success,
    ).toBe(true);
    expect(
      listDiscussionsSchema.safeParse({ group_id: 1, description_max_chars: -2 }).success,
    ).toBe(false);
    expect(listDiscussionsSchema.safeParse({ group_id: 1, limit: 201 }).success).toBe(false);
    expect(listDiscussionsSchema.safeParse({ group_id: 1, strip_html: false }).success).toBe(true);
    expect(listDiscussionsSchema.safeParse({ group_id: 1, strip_html: "no" }).success).toBe(false);
    expect(getDiscussionSchema.safeParse({ id_or_key: 1, strip_html: true }).success).toBe(true);
    expect(getDiscussionSchema.safeParse({ id_or_key: 1, strip_html: 1 }).success).toBe(false);
  });

  // The tools/list catalogue is paid for by every session before its
  // first question, so each field's text is capped at 120 characters.
  it("every field description in the discussion schemas is at most 120 characters", async () => {
    const m = await import("../src/tools/discussions.js");
    const schemas = {
      getDiscussionSchema: m.getDiscussionSchema,
      listDiscussionsSchema: m.listDiscussionsSchema,
      createDiscussionSchema: m.createDiscussionSchema,
      updateDiscussionSchema: m.updateDiscussionSchema,
      deleteDiscussionSchema: m.deleteDiscussionSchema,
    };
    // Text owned by src/tools/_common.ts (maxCharsSchema, formatFieldDescription) is checked where it lives.
    const shared = (schema: string, field: string) =>
      field === "description_max_chars" ||
      (schema === "createDiscussionSchema" && field === "description_format");
    for (const [name, schema] of Object.entries(schemas)) {
      const shape = schema.def.shape as Record<string, { description?: string }>;
      for (const [field, def] of Object.entries(shape)) {
        if (shared(name, field)) continue;
        // A self-naming field (title, group_id, description, tags) carries no
        // describe at all: the key costs ~25 bytes per session and adds nothing.
        if (def.description === undefined) continue;
        expect(def.description.length, `${name}.${field}: ${def.description}`).toBeLessThanOrEqual(
          120,
        );
      }
    }
  });

  it("a generic 403 on the GET index is explained as key OR group visibility", async () => {
    mockFetch(403, { error: "You are not authorized to access this page." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 99 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/not visible to the connector's user/);
  });
});

describe("createDiscussion", () => {
  it("POSTs ONE request with a NESTED {discussion: {…}} body and no v1 pre-flight", async () => {
    mockFetch(200, { discussions: [{ id: 99, group_id: 7, title: "T" }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({
      title: "T",
      group_id: 7,
      description: "Body",
      description_format: "md",
    });

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/discussions");
    expect(req.url.search).toBe("");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({
      discussion: { title: "T", group_id: 7, description: "Body", description_format: "md" },
    });
    // Nothing at the top level besides the wrapper.
    expect(Object.keys(req.body!)).toEqual(["discussion"]);
    for (const [u] of vi.mocked(fetch).mock.calls) expect(String(u)).not.toContain("/v1/");
  });

  it("omits `private` unless the caller set it (Loomio applies the group default itself)", async () => {
    const { createDiscussion } = await import("../src/tools/discussions.js");

    mockFetch(200, { discussions: [{ id: 1, group_id: 7 }] });
    await createDiscussion({ title: "T", group_id: 7 });
    expect(requestOf(0).body).toEqual({ discussion: { title: "T", group_id: 7 } });

    mockFetch(200, { discussions: [{ id: 2, group_id: 7 }] });
    await createDiscussion({ title: "T", group_id: 7, private: false });
    expect(requestOf(1).body).toEqual({ discussion: { title: "T", group_id: 7, private: false } });

    mockFetch(200, { discussions: [{ id: 3, group_id: 7 }] });
    await createDiscussion({ title: "T", group_id: 7, private: true });
    expect(requestOf(2).body).toEqual({ discussion: { title: "T", group_id: 7, private: true } });
  });

  it("nests recipient_* and tags inside the wrapper (DiscussionService reads them from the permitted hash)", async () => {
    mockFetch(200, { discussions: [{ id: 5, group_id: 7 }] });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await createDiscussion({
      title: "T",
      group_id: 7,
      tags: ["budget"],
      recipient_audience: "group",
      recipient_user_ids: [502],
      recipient_emails: ["new@example.org"],
      recipient_message: "Please read",
      notify_recipients: true,
    });
    expect(requestOf().body).toEqual({
      discussion: {
        title: "T",
        group_id: 7,
        tags: ["budget"],
        recipient_audience: "group",
        recipient_user_ids: [502],
        recipient_emails: ["new@example.org"],
        recipient_message: "Please read",
        notify_recipients: true,
      },
    });
  });

  it("returns the created discussion shaped like get_discussion — topics joined, url built, users slim", async () => {
    // A write answers `respond_with_resource`: the same roots as the
    // show (discussions, topics, groups, users). Handing that back raw
    // would be the bulk of a get_discussion payload for a record the
    // caller only needs the id, key and url of.
    mockFetch(200, {
      discussions: [
        discussionRow({ id: 99, key: "newKEY99", title: "T", topic_id: 990, group_id: 7 }),
      ],
      topics: [topicRow({ id: 990, topicable_id: 99, items_count: 1, replies_count: 0 })],
      groups: [EXAMPLE_ORG],
      users: [ADA],
      meta: { root: "discussions" },
    });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    const r = await createDiscussion({ title: "T", group_id: 7 });
    expect(Object.keys(r).sort()).toEqual(["discussion", "group", "users"]);
    expect(r.discussion.id).toBe(99);
    expect(r.discussion.url).toMatch(/\/d\/newKEY99\/t$/);
    expect(r.discussion.items_count).toBe(1);
    expect(r.discussion.description).toBe(LONG_HTML); // whole, never truncated on a write
    expect(r.discussion).not.toHaveProperty("attachments");
    expect(r.group).toEqual(expect.objectContaining({ id: 7, name: "Example Org" }));
    expect(r.users).toEqual([{ id: 501, name: "Ada Example", username: "ada" }]);
  });

  it("THROWS when Loomio echoes group_id null — the orphan a FLAT body produces (verified live)", async () => {
    mockFetch(200, { discussions: [{ id: 98, group_id: null, title: "T" }] });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createDiscussion } = await import("../src/tools/discussions.js");
    const err = await createDiscussion({ title: "T", group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.message).toMatch(/discussion 98 in group null, not the requested group 7/);
    expect(err.message).toMatch(/delete_discussion/);
  });

  it("THROWS naming the created id when Loomio echoes a different group_id (misdirected write)", async () => {
    mockFetch(200, { discussions: [{ id: 99, group_id: 3, title: "T" }] });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createDiscussion } = await import("../src/tools/discussions.js");
    const err = await createDiscussion({ title: "T", group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.message).toMatch(/discussion 99 in group 3, not the requested group 7/);
    expect(err.message).toMatch(/get_discussion 99/);
  });

  it("a generic 403 on the POST is the key, not group visibility (only the GET index is gated)", async () => {
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

  it("propagates a 422 validation error (e.g. privacy not permitted by the group) verbatim", async () => {
    mockFetch(422, { errors: { private: ["must be public"] } });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await expect(createDiscussion({ title: "T", group_id: 7, private: true })).rejects.toThrow(
      /private: must be public/,
    );
  });

  it("requires title and group_id at schema layer", async () => {
    const { createDiscussionSchema } = await import("../src/tools/discussions.js");
    expect(createDiscussionSchema.safeParse({ title: "T" }).success).toBe(false);
    expect(createDiscussionSchema.safeParse({ group_id: 1 }).success).toBe(false);
    expect(createDiscussionSchema.safeParse({ title: "T", group_id: 1 }).success).toBe(true);
    expect(DISCUSSION_2.id).toBe(602); // fixture sanity
  });

  // discussions.description_format is `default: "md"` (db/schema.rb 3.8.1)
  // and no group-level format exists: HTML sent without the format would
  // be stored as Markdown and stripped from every server-rendered surface.
  it("refuses an HTML description without description_format; the description names the real default", async () => {
    const { createDiscussionSchema, updateDiscussionSchema } = await import(
      "../src/tools/discussions.js"
    );
    const html = createDiscussionSchema.safeParse({
      title: "T",
      group_id: 1,
      description: "<p>Body</p>",
    });
    expect(html.success).toBe(false);
    expect(JSON.stringify(html.error?.issues)).toMatch(/description_format/);
    expect(
      createDiscussionSchema.safeParse({
        title: "T",
        group_id: 1,
        description: "<p>Body</p>",
        description_format: "html",
      }).success,
    ).toBe(true);
    expect(
      createDiscussionSchema.safeParse({ title: "T", group_id: 1, description: "# Body" }).success,
    ).toBe(true);
    // The create's format text is _common.ts's shared wording; only the fact is pinned here.
    const shape = createDiscussionSchema.def.shape as Record<string, { description?: string }>;
    expect(shape["description_format"]!.description).toMatch(/'md'/);
    expect(shape["description_format"]!.description).not.toMatch(/group default/);
    const upd = updateDiscussionSchema.def.shape as Record<string, { description?: string }>;
    expect(upd["description_format"]!.description).toMatch(/STORED format stays/);
  });
});

// ── update_discussion / delete_discussion ───────────────────────────────────

describe("updateDiscussion", () => {
  it("PATCHes /b2/discussions/{id} with a NESTED {discussion: {…}} body and no query string", async () => {
    mockFetch(200, {
      discussions: [discussionRow({ title: "New title", versions_count: 5 })],
      topics: [topicRow()],
      groups: [EXAMPLE_ORG],
      users: [ADA],
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    const r = await updateDiscussion({
      id_or_key: 601,
      title: "New title",
      description: "Body v2",
      description_format: "md",
    });

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/discussions/601");
    expect(req.url.search).toBe("");
    expect(req.method).toBe("PATCH");
    expect(req.body).toEqual({
      discussion: { title: "New title", description: "Body v2", description_format: "md" },
    });
    expect(Object.keys(req.body!)).toEqual(["discussion"]);
    expectBearerAuth(0, "test-key");
    expect(r.discussion.title).toBe("New title");
    expect(r.discussion.versions_count).toBe(5);
    expect(r.discussion.items_count).toBe(topicRow().items_count);
    expect(r.group?.id).toBe(7);
  });

  it("accepts the short key as the path segment (Discussion.find uses friendly_id finders)", async () => {
    mockFetch(200, { discussions: [discussionRow()] });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: "dscKEY01", allow_comments: false });
    expect(requestOf().url.pathname).toBe("/api/b2/discussions/dscKEY01");
    expect(requestOf().body).toEqual({ discussion: { allow_comments: false } });
  });

  it("nests recipients (DiscussionService.update reads them from the permitted hash) and sends nothing else", async () => {
    mockFetch(200, { discussions: [discussionRow()] });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({
      id_or_key: 601,
      recipient_user_ids: [502],
      recipient_message: "Please re-read",
      notify_recipients: true,
    });
    expect(requestOf().body).toEqual({
      discussion: {
        recipient_user_ids: [502],
        recipient_message: "Please re-read",
        notify_recipients: true,
      },
    });
  });

  it("refuses an empty update at the schema layer, and never offers group_id / tags (silent no-ops upstream)", async () => {
    const { updateDiscussionSchema } = await import("../src/tools/discussions.js");
    expect(updateDiscussionSchema.safeParse({ id_or_key: 1 }).success).toBe(false);
    expect(updateDiscussionSchema.safeParse({ id_or_key: 1, title: "x" }).success).toBe(true);
    expect(
      updateDiscussionSchema.safeParse({ id_or_key: 1, recipient_emails: ["a@example.org"] })
        .success,
    ).toBe(true);
    const shape = updateDiscussionSchema.def.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("group_id");
    expect(shape).not.toHaveProperty("tags");
  });

  it("a 403 'Not authorized to update Discussion.' is a permission refusal, named as such", async () => {
    mockFetch(403, { error: "Not authorized to update Discussion." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    const err = await updateDiscussion({ id_or_key: 601, title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
    expect(err.message).toContain("/b2/discussions/:id");
    expect(err.message).not.toContain("601");
  });

  it("an unknown id or key is Loomio's 404", async () => {
    mockFetch(404, { error: 404 });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    const err = await updateDiscussion({ id_or_key: "nope", title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
  });
});

describe("deleteDiscussion", () => {
  it("DELETEs /b2/discussions/{id} and reports the soft discard from Loomio's echo", async () => {
    // Loomio's destroy is `DiscussionService.discard`: the echoed record
    // carries discarded_at and the serializer nulls title/description
    // (controller test "destroy soft deletes discussion").
    mockFetch(200, {
      discussions: [
        discussionRow({
          title: null,
          description: null,
          discarded_at: "2026-09-20T10:00:00Z",
          discarded_by: 501,
        }),
      ],
      topics: [topicRow({ discarded_at: "2026-09-20T10:00:00Z" })],
      users: [],
    });
    const { deleteDiscussion } = await import("../src/tools/discussions.js");
    const r = await deleteDiscussion({ id_or_key: 601 });

    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/discussions/601");
    expect(req.method).toBe("DELETE");
    expect(req.body).toEqual({});
    expect(r.discarded).toBe(true);
    expect(r.discussion.discarded_at).toBe("2026-09-20T10:00:00Z");
    expect(r.discussion.title).toBeNull();
    expect(r.note).toMatch(/Soft-discarded/);
    expect(r.note).toMatch(/Nothing was permanently deleted/);
  });

  it("discarded is false when the echo carries no discarded_at (says what happened, never assumes)", async () => {
    mockFetch(200, { discussions: [discussionRow()] });
    const { deleteDiscussion } = await import("../src/tools/discussions.js");
    const r = await deleteDiscussion({ id_or_key: "dscKEY01" });
    expect(requestOf().url.pathname).toBe("/api/b2/discussions/dscKEY01");
    expect(r.discarded).toBe(false);
  });

  it("a 403 'Not authorized to discard Discussion.' is a permission refusal", async () => {
    mockFetch(403, { error: "Not authorized to discard Discussion." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { deleteDiscussion } = await import("../src/tools/discussions.js");
    const err = await deleteDiscussion({ id_or_key: 601 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
  });
});
