/**
 * list_threads / list_thread_items / get_thread_markdown against
 * anonymised Loomio 3.8.1 shapes (tests/fixtures.ts): request shape
 * (paths, compact vs explicit exclude_types, limit/offset), thread
 * resolution (topic_id direct, discussion_id / poll_id one extra call),
 * kinds filter with `other`, client-side slicing with side-load
 * narrowing, `strip_html` (HTML bodies as text, default on) and body
 * truncation flags, poll-result gating with and without a known own
 * identity, 404 semantics, and the get_discussion include_items seam
 * end to end.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetch } from "undici";
import { expectBearerAuth, mockFetch, mockFetchRoutes, setupLoomioTest } from "./test-helpers.js";
import {
  commentRow,
  discussionShowBody,
  groupsIndexBody,
  ITEM_POLL,
  LONG_MD,
  outcomeRow,
  ownStanceRow,
  pollRow,
  pollShowBody,
  pollThreadItemsBody,
  STANDALONE_POLL_TOPIC,
  THREAD_COMMENTS,
  THREAD_MARKDOWN,
  threadItemsBody,
  threadsIndexBody,
  TOPIC_702,
  topicItemRow,
  topicRow,
  voterStanceRow,
} from "./fixtures.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

afterEach(async () => {
  const { resetCachedHealth } = await import("../src/loomio/health-cache.js");
  resetCachedHealth();
});

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  return {
    url: new URL(String(url)),
    method: ((opts as RequestInit | undefined)?.method ?? "GET").toUpperCase(),
  };
}

/** Pretend the startup health probe ran and learned the connector user's identity (Ada, 501). */
async function primeOwnIdentity() {
  const { setCachedHealth } = await import("../src/loomio/health-cache.js");
  setCachedHealth(
    { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
    Date.now(),
    groupsIndexBody(),
  );
}

// ── list_threads ────────────────────────────────────────────────────────────

describe("listThreads", () => {
  it("GETs /b2/threads with the threads profile (compact minus `tag`, so rows keep their tags FIELD) and the connector's default page (limit 20, offset 0)", async () => {
    mockFetch(200, threadsIndexBody());
    const { listThreads } = await import("../src/tools/threads.js");
    await listThreads({});
    const { url, method } = requestOf();
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/b2/threads");
    // compact=1 would strip `tags` from every TopicSerializer row (the
    // attribute is gated on include_type?('tag') — live 3.8.1 capture).
    expect(url.searchParams.has("compact")).toBe(false);
    expect(url.searchParams.get("exclude_types")).toBe(
      "topic group parent membership reaction translation",
    );
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.has("group_id")).toBe(false);
    expectBearerAuth(0, "test-key");
  });

  it("forwards limit and offset upstream", async () => {
    mockFetch(200, threadsIndexBody());
    const { listThreads } = await import("../src/tools/threads.js");
    await listThreads({ limit: 100, offset: 40 });
    const { url } = requestOf();
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("40");
  });

  it("joins each topic row with the discussion or poll it fronts, slims it and adds the url", async () => {
    mockFetch(200, threadsIndexBody());
    const { listThreads } = await import("../src/tools/threads.js");
    const r = await listThreads();
    expect(r.total).toBe(467);
    expect(r.returned).toBe(3);
    expect(r.scope).toMatchObject({
      limit: 20,
      offset: 0,
      page_size: 3,
      group_id: null,
      type: null,
    });

    const [d1, d2, p] = r.threads;
    expect(d1).toMatchObject({
      topic_id: 701,
      type: "Discussion",
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      group_id: 7,
      author_id: 502,
      items_count: 9,
      replies_count: 8,
      last_activity_at: "2026-08-15T09:03:41.491Z",
      locked_at: null,
      pinned_at: "2026-05-29T11:28:24.096Z",
      tags: ["guide"],
      members_count: 369,
      active_polls_count: 0,
      closed_polls_count: 0,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    expect(d1).not.toHaveProperty("poll_type");
    expect(d2).toMatchObject({ topic_id: 702, id: 602, title: "How to nominate a candidate" });
    expect(p).toMatchObject({
      topic_id: 712,
      type: "Poll",
      id: 302,
      key: "polKEY02",
      title: "Pick a date for the budget meeting",
      group_id: 12,
      poll_type: "meeting",
      closing_at: "2026-10-05T12:00:00Z",
      closed_at: null,
      url: "https://www.loomio.com/p/polKEY02/pick-a-date-for-the-budget-meeting",
    });
    // Reader state, ranges and the raw records never reach the caller.
    for (const row of r.threads) {
      expect(row).not.toHaveProperty("reader_volume_email");
      expect(row).not.toHaveProperty("read_ranges");
      expect(row).not.toHaveProperty("ranges");
      expect(row).not.toHaveProperty("description");
      expect(row).not.toHaveProperty("results");
    }
  });

  it("group_id / type filter the fetched page client-side; total stays instance-wide and the note says so", async () => {
    mockFetch(200, threadsIndexBody());
    const { listThreads } = await import("../src/tools/threads.js");
    const r = await listThreads({ group_id: 12 });
    expect(r.threads.map((t) => t.topic_id)).toEqual([712]);
    expect(r.returned).toBe(1);
    expect(r.total).toBe(467);
    expect(r.scope.page_size).toBe(3);
    expect(r.scope.group_id).toBe(12);
    expect(r.scope.note).toMatch(/client-side/);
    // Nothing group-related was sent upstream.
    expect(requestOf().url.searchParams.has("group_id")).toBe(false);

    mockFetch(200, threadsIndexBody());
    const byType = await listThreads({ type: "Discussion" });
    expect(byType.threads.map((t) => t.type)).toEqual(["Discussion", "Discussion"]);
    expect(byType.scope.type).toBe("Discussion");
  });

  it("without filters the note does not mention client-side filtering", async () => {
    mockFetch(200, threadsIndexBody());
    const { listThreads } = await import("../src/tools/threads.js");
    const r = await listThreads();
    expect(r.scope.note).not.toMatch(/client-side/);
  });

  it("a topic whose record is missing from the side-loads still lists (title null, no url)", async () => {
    mockFetch(200, threadsIndexBody({ discussions: [], polls: [] }));
    const { listThreads } = await import("../src/tools/threads.js");
    const r = await listThreads();
    expect(r.threads[0]).toMatchObject({ topic_id: 701, type: "Discussion", id: 601, title: null });
    expect(r.threads[0]).not.toHaveProperty("url");
  });

  // Loomio's threads route reads only limit / offset and orders by
  // last_activity_at DESC (NULLs first in Postgres), so "since" can only
  // be a client-side cutoff — and the caller needs to know when to stop
  // paging.
  describe("since", () => {
    // Fixture activity: 701 → 2026-08-15, 702 → 2026-08-03, 712 → 2026-09-12.
    it("drops rows older than the cutoff client-side; total stays instance-wide; the note says so", async () => {
      mockFetch(200, threadsIndexBody());
      const { listThreads } = await import("../src/tools/threads.js");
      const r = await listThreads({ since: "2026-08-10T00:00:00Z" });
      expect(r.threads.map((t) => t.topic_id)).toEqual([701, 712]);
      expect(r.returned).toBe(2);
      expect(r.total).toBe(467);
      expect(r.scope).toMatchObject({
        since: "2026-08-10T00:00:00Z",
        undated_dropped: 0,
        page_size: 3,
      });
      expect(r.scope.note).toMatch(/since was applied client-side/);
      expect(r.scope.note).toMatch(/exhausted/);
      // Nothing date-related was sent upstream.
      const url = requestOf().url;
      expect([...url.searchParams.keys()].sort()).toEqual(["exclude_types", "limit", "offset"]);
    });

    it("exhausted: true when the page's last DATED row already predates the cutoff (nothing newer can follow), or the page was short", async () => {
      const { listThreads } = await import("../src/tools/threads.js");
      // Full page (limit 3) whose last dated row (702, 2026-08-03) predates the cutoff.
      mockFetch(200, threadsIndexBody({ threads: [STANDALONE_POLL_TOPIC, topicRow(), TOPIC_702] }));
      const full = await listThreads({ since: "2026-08-10T00:00:00Z", limit: 3 });
      expect(full.threads.map((t) => t.topic_id)).toEqual([712, 701]);
      expect(full.scope.exhausted).toBe(true);
      // Full page whose last dated row is still newer than the cutoff: keep paging.
      mockFetch(200, threadsIndexBody({ threads: [STANDALONE_POLL_TOPIC, topicRow(), TOPIC_702] }));
      const more = await listThreads({ since: "2026-08-01T00:00:00Z", limit: 3 });
      expect(more.threads).toHaveLength(3);
      expect(more.scope.exhausted).toBe(false);
      // A short page (fewer rows than limit) is the end of the visible set.
      mockFetch(200, threadsIndexBody());
      const short = await listThreads({ since: "2026-08-01T00:00:00Z", limit: 20 });
      expect(short.scope.exhausted).toBe(true);
    });

    it("rows without a last_activity_at are dropped and counted, and a null tail never marks the set exhausted", async () => {
      const undated = topicRow({ id: 799, topicable_id: 699, last_activity_at: null });
      mockFetch(
        200,
        threadsIndexBody({
          // Postgres DESC puts NULLs first; a null at the tail is also covered.
          threads: [undated, STANDALONE_POLL_TOPIC, topicRow(), TOPIC_702, { ...undated, id: 798 }],
        }),
      );
      const { listThreads } = await import("../src/tools/threads.js");
      const r = await listThreads({ since: "2026-08-01T00:00:00Z", limit: 5 });
      expect(r.threads.map((t) => t.topic_id)).toEqual([712, 701, 702]);
      expect(r.scope.undated_dropped).toBe(2);
      // Last DATED row (702, 2026-08-03) is newer than the cutoff → not exhausted.
      expect(r.scope.exhausted).toBe(false);
    });

    it("without since: no filtering, exhausted null, undated rows pass", async () => {
      const undated = topicRow({ id: 799, topicable_id: 699, last_activity_at: null });
      mockFetch(200, threadsIndexBody({ threads: [undated, topicRow()] }));
      const { listThreads } = await import("../src/tools/threads.js");
      const r = await listThreads();
      expect(r.threads).toHaveLength(2);
      expect(r.scope).toMatchObject({ since: null, exhausted: null, undated_dropped: 0 });
      expect(r.scope.note).not.toMatch(/since/);
    });

    it("schema: since must parse as a timestamp", async () => {
      const { listThreadsSchema } = await import("../src/tools/threads.js");
      expect(listThreadsSchema.safeParse({ since: "2026-09-13" }).success).toBe(true);
      expect(listThreadsSchema.safeParse({ since: "last week" }).success).toBe(false);
    });
  });

  it("schema: limit is capped at 100", async () => {
    const { listThreadsSchema } = await import("../src/tools/threads.js");
    expect(listThreadsSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(listThreadsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listThreadsSchema.safeParse({ type: "Comment" }).success).toBe(false);
  });
});

// ── list_thread_items ───────────────────────────────────────────────────────

describe("listThreadItems", () => {
  it("topic_id: ONE call, GET /b2/threads/{topic_id}/items?compact=1, header completed from the root item", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const { url, method } = requestOf();
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/b2/threads/701/items");
    expect(url.searchParams.get("compact")).toBe("1");
    expect(url.searchParams.has("exclude_types")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
    expectBearerAuth(0, "test-key");

    expect(r).toMatchObject({
      topic_id: 701,
      type: "Discussion",
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      group_id: 7,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
      total: 5,
      matched: 5,
      returned: 5,
    });
    expect(r.scope).toMatchObject({
      offset: 0,
      limit: 200,
      kinds: null,
      include_reactions: false,
      body_max_chars: 4000,
      strip_html: true,
      upstream_calls: 1,
      own_user_known: false,
    });
    expect(r).not.toHaveProperty("reactions");
  });

  it("shapes items (no position_key / topic_id / itemable pointer), comments (HTML bodies as text by default), users", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701 });
    expect(r.items.map((i) => i.sequence_id)).toEqual([0, 1, 2, 3, 4]);
    expect(r.items[1]).toEqual({
      id: 7002,
      sequence_id: 1,
      position: 1,
      depth: 1,
      kind: "new_comment",
      actor_id: 503,
      created_at: "2026-06-01T08:31:10.220Z",
      parent_id: 7001,
      child_count: 1,
      pinned: false,
      itemable_type: "Comment",
      itemable_id: 1701,
    });
    expect(r.items[3]).toMatchObject({ depth: 2, parent_id: 7002, itemable_id: 1703 });
    expect(r.items[4]).toMatchObject({ kind: "discussion_edited", itemable_type: "Discussion" });

    expect(r.comments.map((c) => c.id)).toEqual([1701, 1702, 1703]);
    expect(r.comments[0]).toEqual({
      id: 1701,
      body: "First reply: the draft looks reasonable.",
      body_format: "text",
      author_id: 503,
      parent_id: 601,
      parent_type: "Discussion",
      created_at: "2026-06-01T08:31:10.169Z",
      updated_at: "2026-06-01T08:31:10.169Z",
      discarded_at: null,
      versions_count: 0,
      attachments_count: 0,
    });
    expect(r.comments[1]).toMatchObject({ attachments_count: 1, body_format: "md" });
    expect(r.comments[1]).not.toHaveProperty("mentioned_usernames");
    expect(r.comments[1]).not.toHaveProperty("attachments");
    expect(r.comments[2]).toMatchObject({ parent_id: 1701, parent_type: "Comment" });

    expect(r.users).toEqual([
      { id: 502, name: "Grace Sample", username: "grace" },
      { id: 503, name: "Linus Placeholder", username: "linus" },
    ]);
    expect(r.polls).toEqual([]);
    expect(r.stances).toEqual([]);
    expect(r.outcomes).toEqual([]);
  });

  it("body_max_chars caps the stored bodies (strip_html: false) with the *_truncated / *_chars flags; 0 omits the body", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    // Comment 1703's HTML is 35 characters; 1701's is 47; 1702's runs to
    // well over a thousand. A cap of 40 cuts two of the three.
    const r = await listThreadItems({ topic_id: 701, body_max_chars: 40, strip_html: false });
    const long = r.comments.find((c) => c.id === 1702)!;
    expect(long.body).toHaveLength(40);
    expect(long["body_truncated"]).toBe(true);
    expect(long["body_chars"]).toBeGreaterThan(1000);
    const first = r.comments.find((c) => c.id === 1701)!;
    expect(first).toMatchObject({ body_truncated: true, body_chars: 47 });
    const short = r.comments.find((c) => c.id === 1703)!;
    expect(short.body).toBe("<p>Replying to the first reply.</p>");
    expect(short).not.toHaveProperty("body_truncated");
    expect(short).not.toHaveProperty("body_chars");
    expect(r.scope.body_max_chars).toBe(40);

    mockFetch(200, threadItemsBody());
    const omitted = await listThreadItems({ topic_id: 701, body_max_chars: 0, strip_html: false });
    expect(omitted.comments[0]).not.toHaveProperty("body");
    expect(omitted.comments[0]!["body_omitted"]).toBe(true);
    expect(omitted.comments[0]!["body_chars"]).toBeGreaterThan(0);
  });

  it("discussion_id: resolves via GET /b2/discussions/{id}?compact=1 first (2 calls), header from the record", async () => {
    mockFetch(200, discussionShowBody());
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ discussion_id: 601 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const first = requestOf(0);
    expect(first.url.pathname).toBe("/api/b2/discussions/601");
    expect(first.url.searchParams.get("compact")).toBe("1");
    expect(first.url.searchParams.has("exclude_types")).toBe(false);
    expect(requestOf(1).url.pathname).toBe("/api/b2/threads/701/items");
    expect(r).toMatchObject({ topic_id: 701, type: "Discussion", id: 601, key: "dscKEY01" });
    expect(r.scope.upstream_calls).toBe(2);
  });

  it("discussion_id accepts a short key and encodes it as one path segment", async () => {
    mockFetch(200, discussionShowBody());
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    await listThreadItems({ discussion_id: "dscKEY01" });
    expect(requestOf(0).url.pathname).toBe("/api/b2/discussions/dscKEY01");
  });

  it("poll_id: resolves via GET /b2/polls/{id}?compact=1, then the poll's thread", async () => {
    mockFetch(200, pollShowBody());
    mockFetch(
      200,
      pollThreadItemsBody({
        items: [
          topicItemRow({ id: 7020, itemable_type: "Poll", itemable_id: 301, kind: "poll_created" }),
        ],
        meta: { root: "items", total: 1 },
      }),
    );
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ poll_id: 301 });
    expect(requestOf(0).url.pathname).toBe("/api/b2/polls/301");
    expect(requestOf(0).url.searchParams.get("compact")).toBe("1");
    expect(requestOf(1).url.pathname).toBe("/api/b2/threads/711/items");
    expect(r).toMatchObject({
      topic_id: 711,
      type: "Poll",
      id: 301,
      key: "polKEY01",
      title: "Adopt the 2027 budget?",
      url: "https://www.loomio.com/p/polKEY01/adopt-the-2027-budget",
    });
  });

  it("a poll thread addressed by topic_id names its poll from the root item", async () => {
    mockFetch(
      200,
      pollThreadItemsBody({
        discussions: [],
        items: [
          topicItemRow({
            id: 7020,
            itemable_type: "Poll",
            itemable_id: 301,
            kind: "poll_created",
            itemable: { type: "poll", id: 301 },
          }),
        ],
        meta: { root: "items", total: 1 },
      }),
    );
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 711 });
    expect(r).toMatchObject({ topic_id: 711, type: "Poll", id: 301, key: "polKEY01", group_id: 7 });
  });

  it("kinds filters client-side: total counts everything, matched what passed, side-loads narrow to the returned items", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701, kinds: ["new_comment"] });
    expect(r.total).toBe(5);
    expect(r.matched).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.items.every((i) => i.kind === "new_comment")).toBe(true);
    expect(r.comments).toHaveLength(3);
    expect(r.scope.kinds).toEqual(["new_comment"]);
    // The kinds filter is not a Loomio parameter.
    expect(requestOf().url.searchParams.has("kinds")).toBe(false);
  });

  it("kinds: 'other' passes kinds the connector does not catalogue", async () => {
    mockFetch(
      200,
      threadItemsBody({
        items: [
          ...threadItemsBody().items!,
          topicItemRow({
            id: 7099,
            sequence_id: 5,
            kind: "future_kind",
            itemable_type: null,
            itemable_id: null,
          }),
        ],
        meta: { root: "items", total: 6 },
      }),
    );
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701, kinds: ["discussion_edited", "other"] });
    expect(r.items.map((i) => i.kind)).toEqual(["discussion_edited", "future_kind"]);
    expect(r.matched).toBe(2);
    expect(r.comments).toEqual([]);
  });

  it("limit/offset slice client-side after the filter; only the slice's records and actors are returned", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701, offset: 1, limit: 2 });
    expect(r.items.map((i) => i.sequence_id)).toEqual([1, 2]);
    expect(r.total).toBe(5);
    expect(r.matched).toBe(5);
    expect(r.returned).toBe(2);
    expect(r.comments.map((c) => c.id)).toEqual([1701, 1702]);
    expect(r.users.map((u) => u.id).sort()).toEqual([502, 503]);
    expect(r.scope).toMatchObject({ offset: 1, limit: 2 });
    // The whole thread was still fetched once — nothing paged upstream.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(requestOf().url.searchParams.has("offset")).toBe(false);
  });

  it("an offset past the end returns an empty slice, not an error", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701, offset: 50 });
    expect(r.items).toEqual([]);
    expect(r.returned).toBe(0);
    expect(r.total).toBe(5);
    expect(r.comments).toEqual([]);
    expect(r.users).toEqual([]);
  });

  // `limit` × `body_max_chars` bounds each dimension but not the product
  // (200 × 4000 ≈ 900 KB); the budget bounds the reply itself and hands
  // back where to continue.
  describe("max_total_chars budget", () => {
    it("defaults to 120000, is reported in scope with the characters used, and does not cut a thread that fits", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems, DEFAULT_ITEMS_MAX_TOTAL_CHARS } = await import(
        "../src/tools/threads.js"
      );
      const r = await listThreadItems({ topic_id: 701 });
      expect(DEFAULT_ITEMS_MAX_TOTAL_CHARS).toBe(120_000);
      expect(r.scope.max_total_chars).toBe(120_000);
      expect(r.scope.chars).toBeGreaterThan(1000);
      expect(r.scope.chars).toBeLessThan(120_000);
      expect(r.truncated_by_budget).toBe(false);
      expect(r.next_offset).toBeNull();
      expect(r.returned).toBe(5);
    });

    it("stops BEFORE the item that would overrun the budget, flags it and points at the next offset; the omitted items' records and actors are not returned", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      // Item 0 (~220 chars) + comment 1701 (~300) fit; comment 1702 (> 1000 chars) does not.
      const r = await listThreadItems({ topic_id: 701, max_total_chars: 900 });
      expect(r.items.map((i) => i.sequence_id)).toEqual([0, 1]);
      expect(r.returned).toBe(2);
      expect(r.total).toBe(5);
      expect(r.matched).toBe(5);
      expect(r.truncated_by_budget).toBe(true);
      expect(r.next_offset).toBe(2);
      expect(r.scope.chars).toBeLessThanOrEqual(900);
      expect(r.comments.map((c) => c.id)).toEqual([1701]);
      // Grace (502) authored 1702 and the edit item, both outside the slice.
      expect(r.users.map((u) => u.id).sort()).toEqual([502, 503]);
      expect(r.scope.note).toMatch(/max_total_chars/);
    });

    it("continuing at next_offset returns the rest; the budget composes with limit/offset", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, offset: 2, max_total_chars: 900 });
      // Comment 1702 alone exceeds 900 chars but is the FIRST item of this slice: returned anyway (capped only by body_max_chars).
      expect(r.items.map((i) => i.sequence_id)).toEqual([2]);
      expect(r.comments.map((c) => c.id)).toEqual([1702]);
      expect(r.truncated_by_budget).toBe(true);
      expect(r.next_offset).toBe(3);
      mockFetch(200, threadItemsBody());
      const rest = await listThreadItems({ topic_id: 701, offset: 3, max_total_chars: 900 });
      expect(rest.items.map((i) => i.sequence_id)).toEqual([3, 4]);
      expect(rest.truncated_by_budget).toBe(false);
      expect(rest.next_offset).toBeNull();
    });

    it("next_offset is set when `limit` ends the slice too, and -1 disables the budget", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, limit: 2 });
      expect(r.returned).toBe(2);
      expect(r.truncated_by_budget).toBe(false);
      expect(r.next_offset).toBe(2);
      mockFetch(200, threadItemsBody());
      const all = await listThreadItems({ topic_id: 701, max_total_chars: -1 });
      expect(all.returned).toBe(5);
      expect(all.scope.max_total_chars).toBe(-1);
      expect(all.truncated_by_budget).toBe(false);
    });

    it("a stance's poll counts toward the budget once and travels with the first stance that needs it", async () => {
      mockFetch(200, pollThreadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      // Slice starting at the first stance: the poll is pulled in for it.
      const r = await listThreadItems({ topic_id: 701, offset: 2, limit: 2 });
      expect(r.items.map((i) => i.sequence_id)).toEqual([2, 3]);
      expect(r.polls.map((p) => p.id)).toEqual([301]);
      expect(r.stances).toHaveLength(2);
      expect(r.next_offset).toBe(4);
    });

    it("schema: max_total_chars is -1 or positive", async () => {
      const { listThreadItemsSchema } = await import("../src/tools/threads.js");
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, max_total_chars: -1 }).success).toBe(
        true,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, max_total_chars: 500 }).success).toBe(
        true,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, max_total_chars: 0 }).success).toBe(
        false,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, max_total_chars: -2 }).success).toBe(
        false,
      );
    });
  });

  it("include_reactions swaps compact=1 for the explicit exclude_types minus reaction and returns the reactions root", async () => {
    mockFetch(
      200,
      threadItemsBody({
        reactions: [
          { id: 1, reaction: "👍", reactable_type: "Comment", reactable_id: 1701, user_id: 502 },
          { id: 2, reaction: "🎉", reactable_type: "Comment", reactable_id: 9999, user_id: 502 },
          { id: 3, reaction: "❤️", reactable_type: "Discussion", reactable_id: 601, user_id: 503 },
        ],
      }),
    );
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701, include_reactions: true });
    const { url } = requestOf();
    expect(url.searchParams.has("compact")).toBe(false);
    expect(url.searchParams.get("exclude_types")).toBe(
      "topic group parent membership tag translation",
    );
    expect(r.reactions).toEqual([
      { id: 1, reaction: "👍", user_id: 502, reactable_type: "Comment", reactable_id: 1701 },
      { id: 3, reaction: "❤️", user_id: 503, reactable_type: "Discussion", reactable_id: 601 },
    ]);
    expect(r.scope.include_reactions).toBe(true);
  });

  it("a 404 from the items route is 'thread not found or not visible', never a shape error", async () => {
    mockFetch(404, { error: "Not found" });
    const { listThreadItems } = await import("../src/tools/threads.js");
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const err = await listThreadItems({ topic_id: 4040 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect((err as InstanceType<typeof LoomioApiError>).status).toBe(404);
    expect((err as Error).message).toMatch(/topic_id 4040/);
    expect((err as Error).message).toMatch(/not found or not visible/);
    expect((err as Error).message).toMatch(/thread id, not the discussion or poll id/);
  });

  it("a 404 while resolving a discussion_id names the discussion as UNKNOWN (the show route 403s for an invisible one), not 'not visible'", async () => {
    mockFetch(404, { error: "Not found" });
    const { listThreadItems } = await import("../src/tools/threads.js");
    const err = await listThreadItems({ discussion_id: 999 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/no discussion with id or key "999"/);
    expect((err as Error).message).toMatch(/GET \/b2\/discussions\/\{id\}/);
    expect((err as Error).message).toMatch(/answers 403 'Not authorized to show/);
    expect((err as Error).message).toMatch(/not a topic_id/);
    expect((err as Error).message).not.toMatch(/not visible/);
    expect((err as Error).message).not.toMatch(/not a member/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("a 404 while resolving a poll_id likewise names the poll as unknown", async () => {
    mockFetch(404, { error: "Not found" });
    const { listThreadItems } = await import("../src/tools/threads.js");
    await expect(listThreadItems({ poll_id: "polNOPE" })).rejects.toThrow(
      /no poll with id or key "polNOPE".*GET \/b2\/polls\/\{id\}/,
    );
  });

  it("a 403 while resolving is the client's classified auth error, untouched", async () => {
    mockFetch(403, { error: "Not authorized to show Discussion." });
    const { listThreadItems } = await import("../src/tools/threads.js");
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const err = await listThreadItems({ discussion_id: 601 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect((err as InstanceType<typeof LoomioAuthError>).kind).toBe("not_authorized");
  });

  it("a discussion record without topic_id is a shape error", async () => {
    mockFetch(200, discussionShowBody({ discussions: [{ id: 601, key: "dscKEY01" }] }));
    const { listThreadItems } = await import("../src/tools/threads.js");
    await expect(listThreadItems({ discussion_id: 601 })).rejects.toThrow(/topic_id/);
  });

  describe("poll results inside a thread", () => {
    it("until_vote with NO cached own identity: results hidden, every voter's choice and reason stripped", async () => {
      mockFetch(200, pollThreadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.scope.own_user_known).toBe(false);
      expect(r.polls).toHaveLength(1);
      const poll = r.polls[0]!;
      expect(poll).toMatchObject({
        id: 301,
        key: "polKEY01",
        title: "Adopt the 2027 budget?",
        poll_type: "proposal",
        hide_results: "until_vote",
        anonymous: false,
        closed_at: null,
        voters_count: 6,
        decided_voters_count: 4,
        results_visible: false,
        results_hidden_reason: "until_vote",
        url: "https://www.loomio.com/p/polKEY01/adopt-the-2027-budget",
      });
      // Options come from the poll_options root, priority-ordered, with
      // the ids that stances' option_scores are keyed by.
      expect(poll.poll_options).toEqual([
        { id: 1, name: "agree", priority: 0 },
        { id: 2, name: "disagree", priority: 1 },
        { id: 3, name: "abstain", priority: 2 },
      ]);
      expect(poll).not.toHaveProperty("poll_option_names");
      expect(poll).not.toHaveProperty("stance_counts");
      expect(poll).not.toHaveProperty("total_score");
      expect(poll).not.toHaveProperty("results");
      expect(poll).not.toHaveProperty("result_columns");

      expect(r.stances).toHaveLength(2);
      for (const s of r.stances) {
        expect(s).toMatchObject({ poll_id: 301, latest: true });
        expect(s).not.toHaveProperty("option_scores");
        expect(s).not.toHaveProperty("reason");
        expect(s).not.toHaveProperty("none_of_the_above");
        expect(s).toHaveProperty("participant_id");
        expect(s).toHaveProperty("cast_at");
      }
      expect(r.outcomes).toEqual([
        {
          id: 801,
          poll_id: 301,
          poll_option_id: 1,
          statement: "Adopted with three votes in favour.",
          statement_format: "text",
          author_id: 502,
          created_at: "2026-10-01T13:00:00Z",
          review_on: null,
          latest: true,
        },
      ]);
      expect(r.users.map((u) => u.id).sort()).toEqual([501, 502, 503]);
    });

    it("until_vote with the own identity known and the own stance cast: results visible, choices kept", async () => {
      await primeOwnIdentity();
      mockFetch(200, pollThreadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.scope.own_user_known).toBe(true);
      expect(r.polls[0]).toMatchObject({
        results_visible: true,
        stance_counts: [3, 1, 0],
        total_score: 4,
      });
      expect(r.polls[0]).not.toHaveProperty("results_hidden_reason");
      const voter = r.stances.find((s) => s.id === 902)!;
      expect(voter).toMatchObject({
        participant_id: 503,
        option_scores: { "2": 1 },
        reason: "I object to the reserve figure.",
      });
      const own = r.stances.find((s) => s.id === 901)!;
      expect(own).toMatchObject({ participant_id: 501, option_scores: { "1": 1 } });
      // The option_scores keys resolve through the poll's poll_options[]
      // — without that map "2" would be unreadable.
      const byId = new Map(r.polls[0]!.poll_options.map((o) => [String(o.id), o.name]));
      expect(byId.get(Object.keys(voter.option_scores!)[0]!)).toBe("disagree");
      expect(byId.get(Object.keys(own.option_scores!)[0]!)).toBe("agree");
      // stance_counts[i] is the tally of poll_options[i].
      expect(r.polls[0]!.poll_options.map((o) => o.name)).toEqual(["agree", "disagree", "abstain"]);
      expect(r.polls[0]!.stance_counts).toEqual([3, 1, 0]);
      expect(r.scope.note).toMatch(/option_scores is keyed by poll_option ID/);
    });

    it("without a poll_options root the options are zipped from the record's own poll_option_ids / poll_option_names", async () => {
      mockFetch(
        200,
        pollThreadItemsBody({
          poll_options: undefined,
          polls: [{ ...ITEM_POLL, poll_option_ids: [1, 2, 3] }],
        }),
      );
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.polls[0]!.poll_options).toEqual([
        { id: 1, name: "agree", priority: 0 },
        { id: 2, name: "disagree", priority: 1 },
        { id: 3, name: "abstain", priority: 2 },
      ]);
    });

    it("until_vote, identity known but the user has NOT voted: hidden, except the user's own (absent) stance", async () => {
      await primeOwnIdentity();
      mockFetch(200, pollThreadItemsBody({ stances: [pollThreadItemsBody().stances![0]!] }));
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.polls[0]).toMatchObject({
        results_visible: false,
        results_hidden_reason: "until_vote",
      });
      expect(r.stances[0]).not.toHaveProperty("option_scores");
    });

    it("hide_results off: visible whoever the user is", async () => {
      mockFetch(
        200,
        pollThreadItemsBody({ polls: [pollRow({ hide_results: "off", topic_id: 701 })] }),
      );
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.polls[0]).toMatchObject({ results_visible: true, stance_counts: [3, 1, 0] });
      expect(r.stances.find((s) => s.id === 902)).toMatchObject({ option_scores: { "2": 1 } });
    });

    it("until_vote on a CLOSED poll: visible", async () => {
      mockFetch(
        200,
        pollThreadItemsBody({ polls: [{ ...ITEM_POLL, closed_at: "2026-10-01T12:00:00Z" }] }),
      );
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.polls[0]).toMatchObject({
        results_visible: true,
        closed_at: "2026-10-01T12:00:00Z",
      });
    });

    it("until_closed, still open: Loomio already withheld the fields; the pair says why", async () => {
      const poll = pollRow({ hide_results: "until_closed", topic_id: 701 });
      delete poll.results;
      delete poll.stance_counts;
      delete poll.total_score;
      mockFetch(200, pollThreadItemsBody({ polls: [poll] }));
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.polls[0]).toMatchObject({
        results_visible: false,
        results_hidden_reason: "until_closed",
      });
    });

    it("poll details are capped by body_max_chars like every other body", async () => {
      mockFetch(200, pollThreadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, body_max_chars: 5 });
      expect(r.polls[0]!.details).toBe("<p>Sh");
      expect(r.polls[0]!["details_truncated"]).toBe(true);
      expect(r.outcomes[0]!["statement_truncated"]).toBe(true);
    });

    it("a stance's poll pulled in even when the poll_created item is outside the slice", async () => {
      mockFetch(200, pollThreadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, kinds: ["stance_created"] });
      expect(r.items).toHaveLength(2);
      expect(r.polls.map((p) => p.id)).toEqual([301]);
      expect(r.outcomes).toEqual([]);
    });
  });

  // A model reads a thread, it does not render one: `strip_html`
  // (default on) turns HTML comment bodies, vote reasons and outcome
  // statements into text — format re-labelled "text" — BEFORE the cap,
  // so every capped character is a word. Poll `details` are left as
  // stored, Markdown bodies too.
  describe("strip_html", () => {
    it("default on: HTML comment bodies become plain text with body_format 'text'; Markdown bodies are untouched", async () => {
      mockFetch(
        200,
        threadItemsBody({
          comments: [
            commentRow({ body: "<p>Two &amp; three</p><ul><li>a</li><li>b</li></ul><p>Next</p>" }),
            ...THREAD_COMMENTS.slice(1),
          ],
        }),
      );
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.scope.strip_html).toBe(true);
      expect(r.comments[0]).toMatchObject({
        id: 1701,
        body: "Two & three\n\n- a\n- b\n\nNext",
        body_format: "text",
      });
      expect(r.comments[0]).not.toHaveProperty("body_truncated");
      // 1702 is Markdown: nothing to strip, the format stays what Loomio said.
      expect(r.comments[1]).toMatchObject({ id: 1702, body: LONG_MD, body_format: "md" });
    });

    it("applies to vote reasons and outcome statements too, and leaves poll `details` as stored", async () => {
      mockFetch(
        200,
        pollThreadItemsBody({
          polls: [pollRow({ hide_results: "off", topic_id: 701, current_outcome_id: 801 })],
          stances: [
            voterStanceRow({
              reason: "<p>I <em>object</em> to the reserve figure.</p>",
              reason_format: "html",
            }),
            ownStanceRow(),
          ],
          outcomes: [outcomeRow({ statement: "<p>Adopted &mdash; three in favour.</p>" })],
        }),
      );
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701 });
      expect(r.stances.find((s) => s.id === 902)).toMatchObject({
        reason: "I object to the reserve figure.",
        reason_format: "text",
      });
      expect(r.stances.find((s) => s.id === 901)).toMatchObject({
        reason: "Looks sound.",
        reason_format: "md",
      });
      expect(r.outcomes[0]).toMatchObject({
        statement: "Adopted — three in favour.",
        statement_format: "text",
      });
      expect(r.polls[0]).toMatchObject({
        details: "<p>Shall we adopt the proposed budget?</p>",
        details_format: "html",
      });
    });

    it("the cap applies to the TEXT: body_chars is the text length and the cut carries words, not tags", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, body_max_chars: 20 });
      expect(r.comments.find((c) => c.id === 1701)).toMatchObject({
        body: "First reply: the dra",
        body_format: "text",
        body_truncated: true,
        body_chars: 40,
      });
      // The 40 characters of text fit a cap the 47-character HTML would overrun.
      mockFetch(200, threadItemsBody());
      const fits = await listThreadItems({ topic_id: 701, body_max_chars: 40 });
      expect(fits.comments.find((c) => c.id === 1701)).not.toHaveProperty("body_truncated");
    });

    it("strip_html: false returns the stored HTML byte-for-byte with its real format", async () => {
      mockFetch(200, threadItemsBody());
      const { listThreadItems } = await import("../src/tools/threads.js");
      const r = await listThreadItems({ topic_id: 701, strip_html: false });
      expect(r.scope.strip_html).toBe(false);
      expect(r.comments[0]).toMatchObject({
        body: "<p>First reply: the draft looks reasonable.</p>",
        body_format: "html",
      });
      mockFetch(200, pollThreadItemsBody());
      const poll = await listThreadItems({ topic_id: 701, strip_html: false });
      expect(poll.outcomes[0]).toMatchObject({
        statement: "<p>Adopted with three votes in favour.</p>",
        statement_format: "html",
      });
    });
  });

  describe("schema", () => {
    it("requires exactly one of discussion_id / poll_id / topic_id", async () => {
      const { listThreadItemsSchema } = await import("../src/tools/threads.js");
      expect(listThreadItemsSchema.safeParse({}).success).toBe(false);
      expect(listThreadItemsSchema.safeParse({ topic_id: 1 }).success).toBe(true);
      expect(listThreadItemsSchema.safeParse({ discussion_id: "abcDEF12" }).success).toBe(true);
      expect(listThreadItemsSchema.safeParse({ poll_id: 3 }).success).toBe(true);
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, discussion_id: 2 }).success).toBe(
        false,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, poll_id: 2 }).success).toBe(false);
    });

    it("bounds limit at 1000 and offset at 0", async () => {
      const { listThreadItemsSchema } = await import("../src/tools/threads.js");
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, limit: 1000 }).success).toBe(true);
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, limit: 1001 }).success).toBe(false);
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, offset: -1 }).success).toBe(false);
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, body_max_chars: -1 }).success).toBe(
        true,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, body_max_chars: -2 }).success).toBe(
        false,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, strip_html: false }).success).toBe(
        true,
      );
      expect(listThreadItemsSchema.safeParse({ topic_id: 1, strip_html: "no" }).success).toBe(
        false,
      );
    });

    // The full 15-kind catalogue lives in HOWTO.md "Tool reference" (it cost
    // ~240 chars in every session's tools/list); the describe names the
    // kinds a caller filters on most and the "other" passthrough.
    it("names the common item kinds and the 'other' passthrough in the kinds description", async () => {
      const { THREAD_ITEM_KINDS, listThreadItemsSchema } = await import("../src/tools/threads.js");
      const description = listThreadItemsSchema.shape.kinds.description ?? "";
      expect(description).toContain("new_comment");
      expect(description).toContain("stance_created");
      expect(description).toContain("'other'");
      expect(description.length).toBeLessThanOrEqual(120);
      expect(THREAD_ITEM_KINDS).toContain("new_comment");
      expect(THREAD_ITEM_KINDS).toContain("stance_updated");
      expect(THREAD_ITEM_KINDS).toContain("discussion_moved");
    });
  });
});

// ── get_discussion include_items — the seam end to end ──────────────────────

describe("getDiscussion include_items → listThreadItems", () => {
  it("embeds the real list_thread_items result using the record's topic_id: exactly two upstream calls, the second EXCLUDING the opening post it already has", async () => {
    mockFetchRoutes({
      "/b2/discussions/601": { status: 200, body: discussionShowBody() },
      "/b2/threads/701/items": {
        status: 200,
        // What Loomio sends with `discussion` excluded: no discussions root.
        body: threadItemsBody({ discussions: undefined }),
      },
    });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601, include_items: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(requestOf(1).url.pathname).toBe("/api/b2/threads/701/items");
    expect(requestOf(1).url.searchParams.has("compact")).toBe(false);
    expect(requestOf(1).url.searchParams.get("exclude_types")).toBe(
      "topic group parent membership reaction tag translation discussion",
    );
    const items = r.thread_items as {
      topic_id: number;
      type: string | null;
      id: number | null;
      key: string | null;
      title: string | null;
      group_id: number | null;
      url?: string;
      total: number;
      returned: number;
      items: unknown[];
      scope: { profile: string };
    };
    // The header is filled from the record get_discussion had, not from
    // the (absent) discussions root.
    expect(items).toMatchObject({
      topic_id: 701,
      type: "Discussion",
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      group_id: 7,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    expect(items.scope.profile).toBe("items_known_thread");
    expect(items.total).toBe(5);
    expect(items.returned).toBe(5);
    expect(items.items).toHaveLength(5);
  });
});

describe("listThreadItems — which side-loads are dropped, per path", () => {
  it("bare topic_id: compact=1 (the discussions / polls root is needed to learn what the thread is)", async () => {
    mockFetch(200, threadItemsBody());
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ topic_id: 701 });
    expect(requestOf().url.searchParams.get("compact")).toBe("1");
    expect(requestOf().url.searchParams.has("exclude_types")).toBe(false);
    expect(r.scope.profile).toBe("compact");
    expect(r).toMatchObject({ type: "Discussion", id: 601, key: "dscKEY01" });
  });

  it("discussion_id: the resolver already read the record, so the items request excludes `discussion` (no second copy of the opening post)", async () => {
    mockFetchRoutes({
      "/b2/discussions/601": { status: 200, body: discussionShowBody() },
      "/b2/threads/701/items": { status: 200, body: threadItemsBody({ discussions: undefined }) },
    });
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ discussion_id: 601 });
    expect(requestOf(1).url.searchParams.has("compact")).toBe(false);
    expect(requestOf(1).url.searchParams.get("exclude_types")).toBe(
      "topic group parent membership reaction tag translation discussion",
    );
    expect(r.scope.profile).toBe("items_known_thread");
    expect(r.scope.upstream_calls).toBe(2);
    expect(r).toMatchObject({ type: "Discussion", id: 601, title: "Budget planning for 2027" });
  });

  it("include_reactions wins over the known-thread profile: `discussion` stays included because the opening post's reactions come through its serializer", async () => {
    mockFetchRoutes({
      "/b2/discussions/601": { status: 200, body: discussionShowBody() },
      "/b2/threads/701/items": { status: 200, body: threadItemsBody({ reactions: [] }) },
    });
    const { listThreadItems } = await import("../src/tools/threads.js");
    const r = await listThreadItems({ discussion_id: 601, include_reactions: true });
    expect(requestOf(1).url.searchParams.get("exclude_types")).toBe(
      "topic group parent membership tag translation",
    );
    expect(r.scope.profile).toBe("items_with_reactions");
  });
});

describe("resolveThread with lookupTopic (create_poll's topic_id + group_id cross-check)", () => {
  it("GETs /b2/threads/{topic_id}?compact=1 and fills the header from the TopicSerializer row and the fronting record", async () => {
    mockFetch(200, {
      threads: [threadsIndexBody().threads![0]!],
      discussions: [discussionShowBody().discussions![0]!],
      users: [],
      meta: { root: "threads" },
    });
    const { resolveThread } = await import("../src/tools/threads.js");
    const { header, calls } = await resolveThread({ topic_id: 701 }, { lookupTopic: true });
    expect(calls).toBe(1);
    expect(requestOf().url.pathname).toBe("/api/b2/threads/701");
    expect(requestOf().url.searchParams.get("compact")).toBe("1");
    expect(header).toEqual({
      topic_id: 701,
      type: "Discussion",
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      group_id: 7,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
  });

  it("without lookupTopic a topic_id costs nothing and knows nothing", async () => {
    const { resolveThread } = await import("../src/tools/threads.js");
    const { header, calls } = await resolveThread({ topic_id: 701 });
    expect(calls).toBe(0);
    expect(header.group_id).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── get_thread_markdown ─────────────────────────────────────────────────────

describe("getThreadMarkdown", () => {
  it("topic_id: ONE call to GET /b2/threads/{topic_id}/markdown (no compact — it is not a Snorlax read)", async () => {
    mockFetch(200, { markdown: THREAD_MARKDOWN });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    const r = await getThreadMarkdown({ topic_id: 701 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const { url, method } = requestOf();
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/b2/threads/701/markdown");
    expect(url.search).toBe("");
    expectBearerAuth(0, "test-key");
    expect(r).toMatchObject({
      topic_id: 701,
      type: null,
      id: null,
      title: null,
      heading: "Discussion: Budget planning for 2027 · Grace Sample 2026-05-29 11:25",
      markdown: THREAD_MARKDOWN,
      chars: THREAD_MARKDOWN.length,
      truncated: false,
    });
    expect(r.scope).toMatchObject({ max_chars: 60_000, upstream_calls: 1 });
    expect(r.scope.note).toMatch(/hide_results/);
  });

  it("max_chars cuts from the end and reports the full length", async () => {
    mockFetch(200, { markdown: THREAD_MARKDOWN });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    const r = await getThreadMarkdown({ topic_id: 701, max_chars: 120 });
    expect(r.markdown).toBe(THREAD_MARKDOWN.slice(0, 120));
    expect(r.truncated).toBe(true);
    expect(r.chars).toBe(THREAD_MARKDOWN.length);
    expect(r.heading).toBe("Discussion: Budget planning for 2027 · Grace Sample 2026-05-29 11:25");
    expect(r.scope.max_chars).toBe(120);
  });

  it("max_chars -1 returns the whole document", async () => {
    mockFetch(200, { markdown: THREAD_MARKDOWN });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    const r = await getThreadMarkdown({ topic_id: 701, max_chars: -1 });
    expect(r.markdown).toBe(THREAD_MARKDOWN);
    expect(r.truncated).toBe(false);
  });

  it("discussion_id: resolves first (2 calls) and names the thread from the record", async () => {
    mockFetch(200, discussionShowBody());
    mockFetch(200, { markdown: THREAD_MARKDOWN });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    const r = await getThreadMarkdown({ discussion_id: "dscKEY01" });
    expect(requestOf(0).url.pathname).toBe("/api/b2/discussions/dscKEY01");
    expect(requestOf(0).url.searchParams.get("compact")).toBe("1");
    expect(requestOf(1).url.pathname).toBe("/api/b2/threads/701/markdown");
    expect(r).toMatchObject({
      topic_id: 701,
      type: "Discussion",
      id: 601,
      key: "dscKEY01",
      title: "Budget planning for 2027",
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    expect(r.scope.upstream_calls).toBe(2);
  });

  it("a 404 is 'thread not found or not visible'", async () => {
    mockFetch(404, { error: "Not found" });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    await expect(getThreadMarkdown({ topic_id: 4040 })).rejects.toThrow(/not found or not visible/);
  });

  it("a body without a markdown string is a shape error", async () => {
    mockFetch(200, { nope: true });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    await expect(getThreadMarkdown({ topic_id: 701 })).rejects.toThrow(/without a markdown string/);
  });

  it("heading is null when the document has no H1", async () => {
    mockFetch(200, { markdown: '---\ngroup: "x"\n---\n\n_No activity._' });
    const { getThreadMarkdown } = await import("../src/tools/threads.js");
    const r = await getThreadMarkdown({ topic_id: 701 });
    expect(r.heading).toBeNull();
  });

  it("schema: exactly one reference; max_chars 0 rejected, -1 and positive accepted", async () => {
    const { getThreadMarkdownSchema } = await import("../src/tools/threads.js");
    expect(getThreadMarkdownSchema.safeParse({}).success).toBe(false);
    expect(getThreadMarkdownSchema.safeParse({ topic_id: 1, poll_id: 2 }).success).toBe(false);
    expect(getThreadMarkdownSchema.safeParse({ topic_id: 1 }).success).toBe(true);
    expect(getThreadMarkdownSchema.safeParse({ topic_id: 1, max_chars: 0 }).success).toBe(false);
    expect(getThreadMarkdownSchema.safeParse({ topic_id: 1, max_chars: -1 }).success).toBe(true);
    expect(getThreadMarkdownSchema.safeParse({ topic_id: 1, max_chars: 500 }).success).toBe(true);
  });
});
