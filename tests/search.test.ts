/**
 * search_content against anonymised Loomio 3.8.1 search shapes
 * (tests/fixtures.ts): request shape (compact=1, query / author_id /
 * group_id / types csv / tag / order), result mapping (record id, thread
 * title, `**match**` snippets with entities decoded, group / author,
 * deep-link urls per type), the 20-result cap flag, author mode, and the
 * snippet helpers themselves.
 */

import { describe, it, expect, vi } from "vitest";
import { fetch } from "undici";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import {
  ownStanceRow,
  pollRow,
  searchAuthorBody,
  searchBody,
  searchResultRow,
  SEARCH_ROWS,
} from "./fixtures.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  return {
    url: new URL(String(url)),
    method: ((opts as RequestInit | undefined)?.method ?? "GET").toUpperCase(),
  };
}

describe("searchContent — request shape", () => {
  it("GETs /b2/search with compact=1, the query and the default authored_at_desc order", async () => {
    mockFetch(200, searchBody());
    const { searchContent } = await import("../src/tools/search.js");
    await searchContent({ query: "budget" });
    const { url, method } = requestOf();
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/b2/search");
    expect(url.searchParams.get("compact")).toBe("1");
    expect(url.searchParams.get("query")).toBe("budget");
    expect(url.searchParams.get("order")).toBe("authored_at_desc");
    expect(url.searchParams.has("exclude_types")).toBe(false);
    expect(url.searchParams.has("author_id")).toBe(false);
    expect(url.searchParams.has("group_id")).toBe(false);
    expect(url.searchParams.has("types")).toBe(false);
    expect(url.searchParams.has("tag")).toBe(false);
    expectBearerAuth(0, "test-key");
  });

  it("sends group_id, types as a comma-separated list, tag and an explicit order", async () => {
    mockFetch(200, searchBody());
    const { searchContent } = await import("../src/tools/search.js");
    await searchContent({
      query: "budget",
      group_id: 7,
      types: ["Poll", "Outcome"],
      tag: "guide",
      order: "authored_at_asc",
    });
    const { url } = requestOf();
    expect(url.searchParams.get("group_id")).toBe("7");
    expect(url.searchParams.get("types")).toBe("Poll,Outcome");
    expect(url.searchParams.has("type")).toBe(false);
    expect(url.searchParams.get("tag")).toBe("guide");
    expect(url.searchParams.get("order")).toBe("authored_at_asc");
  });

  it("order 'relevance' sends NO order parameter (Loomio's default ranking)", async () => {
    mockFetch(200, searchBody());
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget", order: "relevance" });
    expect(requestOf().url.searchParams.has("order")).toBe(false);
    expect(r.scope.order).toBe("relevance");
  });

  it("author mode: author_id without query, no order parameter, mode 'author'", async () => {
    mockFetch(200, searchAuthorBody());
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ author_id: 502, order: "relevance" });
    const { url } = requestOf();
    expect(url.searchParams.get("author_id")).toBe("502");
    expect(url.searchParams.has("query")).toBe(false);
    expect(url.searchParams.has("order")).toBe(false);
    expect(r.mode).toBe("author");
    // Author-only results are always newest first, whatever was asked.
    expect(r.scope.order).toBe("authored_at_desc");
    expect(r.scope.author_id).toBe(502);
    expect(r.scope.query).toBeNull();
  });

  it("query + author_id together: both sent, mode 'query+author'", async () => {
    mockFetch(200, searchBody());
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget", author_id: 502 });
    const { url } = requestOf();
    expect(url.searchParams.get("query")).toBe("budget");
    expect(url.searchParams.get("author_id")).toBe("502");
    expect(r.mode).toBe("query+author");
  });
});

describe("searchContent — result shaping", () => {
  it("maps rows to hits: record id, thread title, snippet, group, author, keys, url", async () => {
    mockFetch(200, searchBody());
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget" });
    expect(r.returned).toBe(4);
    expect(r.capped).toBe(false);
    expect(r.mode).toBe("query");

    const [discussion, comment, stance, poll] = r.results;
    expect(discussion).toEqual({
      type: "Discussion",
      id: 601,
      title: "Budget planning for 2027",
      snippet:
        "the **budget** for next year & the **budget** reserve * [**budget** notes](https://example.org/notes)",
      group: { id: 7, full_name: "Example Org", handle: "example-org" },
      author: { id: 502, name: "Grace Sample" },
      authored_at: "2026-05-29T11:25:57.740Z",
      discussion_key: "dscKEY01",
      poll_key: null,
      poll_id: null,
      sequence_id: null,
      url: "https://www.loomio.com/d/dscKEY01/budget-planning-for-2027",
    });
    // A comment deep-links with ?comment_id= (Loomio's comment_url form);
    // its `id` is the comment's id, its title the thread's.
    expect(comment).toMatchObject({
      type: "Comment",
      id: 1701,
      title: "Budget planning for 2027",
      snippet: "I read the **budget** draft 'twice'",
      author: { id: 503, name: "Linus Placeholder" },
      url: "https://www.loomio.com/d/dscKEY01?comment_id=1701",
    });
    // A row's `tags` never arrives under compact=1 (the attribute is
    // gated on include_type?('tag')), and the hit does not pretend to.
    expect(comment).not.toHaveProperty("tags");
    // An item inside a discussion opens the thread at its sequence_id;
    // its poll (301, hide_results off) is in the polls root, so the
    // vote reason is shown.
    expect(stance).toMatchObject({
      type: "Stance",
      id: 902,
      title: "Budget planning for 2027",
      snippet: "**Budget** reserve figure",
      poll_key: "polKEY01",
      poll_id: 301,
      sequence_id: 2,
      url: "https://www.loomio.com/d/dscKEY01?sequence_id=2",
    });
    expect(stance).not.toHaveProperty("snippet_hidden_reason");
    // A standalone poll opens its own page. `group.full_name` is the
    // controller's `group.full_name` ("Parent - Subgroup"), which is why
    // the field is not called `name`.
    expect(poll).toMatchObject({
      type: "Poll",
      id: 302,
      title: "Pick a date for the budget meeting",
      group: { id: 12, full_name: "Example Org - Finance Team", handle: "example-org-finance" },
      discussion_key: null,
      poll_key: "polKEY02",
      url: "https://www.loomio.com/p/polKEY02/pick-a-date-for-the-budget-meeting",
    });
    expect(poll!.group).not.toHaveProperty("name");
    // No pg_search row ids, no raw highlight, no polls / users roots.
    for (const hit of r.results) {
      expect(hit).not.toHaveProperty("highlight");
      expect(hit).not.toHaveProperty("searchable_id");
    }
    expect(r).not.toHaveProperty("polls");
    expect(r).not.toHaveProperty("users");
    expect(discussion).not.toHaveProperty("tags");
  });

  // Loomio indexes the stances of open `until_vote` polls (only open
  // `until_closed` ones are skipped at index time — stance.rb), so search
  // would hand a non-voting API user the reasons list_thread_items
  // strips. The response's own polls root (+ my_stance) is enough to
  // apply the same rule. In QUERY mode a withheld snippet is not enough:
  // the hit's existence would confirm the term occurs in the hidden
  // reason (a word-by-word oracle with types: ['Stance'] + author_id), so
  // the row is dropped and counted; author-only mode has no probe term
  // and keeps the row with the snippet withheld.
  describe("vote reasons follow the poll's visibility rule for the connector's user", () => {
    type Result = Awaited<ReturnType<typeof import("../src/tools/search.js")["searchContent"]>>;
    const stanceHit = (results: Result) => results.results.find((h) => h.type === "Stance");

    it("QUERY mode, open until_vote poll, user has not voted: the Stance hit is DROPPED and counted, nothing of it reaches the caller", async () => {
      mockFetch(200, searchBody({ polls: [pollRow({ hide_results: "until_vote" })] }));
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ query: "budget" });
      expect(stanceHit(r)).toBeUndefined();
      expect(r.results.map((h) => h.type)).toEqual(["Discussion", "Comment", "Poll"]);
      expect(r.returned).toBe(3);
      expect(r.scope.hidden_stance_hits_dropped).toBe(1);
      const text = JSON.stringify(r);
      expect(text).not.toContain("reserve figure");
      // Not even the voter, the poll or the vote id: the row's presence is the leak.
      expect(text).not.toContain("polKEY01");
      expect(text).not.toContain('"id":902');
      // Every other type is untouched.
      for (const other of r.results) {
        expect(other.snippet).not.toBeNull();
        expect(other).not.toHaveProperty("snippet_hidden_reason");
      }
      expect(r.scope.note).toMatch(/DROPPED from a query search/);
      expect(r.scope.note).toMatch(/hidden_stance_hits_dropped/);
    });

    it("query + author_id (the sharpest probe) drops the hit too", async () => {
      mockFetch(200, searchBody({ polls: [pollRow({ hide_results: "until_vote" })] }));
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ query: "reserve", author_id: 503, types: ["Stance"] });
      expect(r.mode).toBe("query+author");
      expect(stanceHit(r)).toBeUndefined();
      expect(r.scope.hidden_stance_hits_dropped).toBe(1);
    });

    it("`capped` reflects Loomio's row count, not the rows left after the drop", async () => {
      const stance = SEARCH_ROWS[2]!;
      const rows = Array.from({ length: 20 }, (_, i) =>
        searchResultRow({ ...stance, id: 300000 + i, searchable_id: 1000 + i }),
      );
      mockFetch(
        200,
        searchBody({ polls: [pollRow({ hide_results: "until_vote" })], search_results: rows }),
      );
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ query: "budget", types: ["Stance"] });
      expect(r.results).toEqual([]);
      expect(r.returned).toBe(0);
      expect(r.capped).toBe(true);
      expect(r.scope.hidden_stance_hits_dropped).toBe(20);
    });

    it("open until_vote poll, the user HAS voted (my_stance in the stances root): reason shown", async () => {
      mockFetch(
        200,
        searchBody({
          polls: [pollRow({ hide_results: "until_vote" })],
          stances: [ownStanceRow()],
        }),
      );
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ query: "budget" });
      expect(stanceHit(r)!.snippet).toBe("**Budget** reserve figure");
      expect(stanceHit(r)).not.toHaveProperty("snippet_hidden_reason");
      expect(r.scope.hidden_stance_hits_dropped).toBe(0);
    });

    it("an uncast or revoked own stance does not count as voted (query mode: dropped)", async () => {
      const { searchContent } = await import("../src/tools/search.js");
      mockFetch(
        200,
        searchBody({
          polls: [pollRow({ hide_results: "until_vote" })],
          stances: [ownStanceRow({ cast_at: null })],
        }),
      );
      expect(stanceHit(await searchContent({ query: "budget" }))).toBeUndefined();
      mockFetch(
        200,
        searchBody({
          polls: [pollRow({ hide_results: "until_vote" })],
          stances: [ownStanceRow({ revoked_at: "2026-09-06T00:00:00Z" })],
        }),
      );
      expect(stanceHit(await searchContent({ query: "budget" }))).toBeUndefined();
    });

    it("until_closed and still open (index lag): dropped; closed: shown", async () => {
      const { searchContent } = await import("../src/tools/search.js");
      mockFetch(200, searchBody({ polls: [pollRow({ hide_results: "until_closed" })] }));
      const open = await searchContent({ query: "budget" });
      expect(stanceHit(open)).toBeUndefined();
      expect(open.scope.hidden_stance_hits_dropped).toBe(1);
      mockFetch(
        200,
        searchBody({
          polls: [pollRow({ hide_results: "until_closed", closed_at: "2026-10-01T12:00:00Z" })],
        }),
      );
      expect(stanceHit(await searchContent({ query: "budget" }))!.snippet).toBe(
        "**Budget** reserve figure",
      );
    });

    it("a stance whose poll is absent from the polls root cannot be judged and is treated as hidden (dropped)", async () => {
      mockFetch(200, searchBody({ polls: [] }));
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ query: "budget" });
      expect(stanceHit(r)).toBeUndefined();
      expect(r.scope.hidden_stance_hits_dropped).toBe(1);
    });

    it("AUTHOR mode (no query to probe with) keeps the hit with the snippet withheld and says why", async () => {
      mockFetch(
        200,
        searchBody({
          polls: [pollRow({ hide_results: "until_vote" })],
          search_results: [SEARCH_ROWS[2]!],
        }),
      );
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ author_id: 503, types: ["Stance"] });
      expect(r.mode).toBe("author");
      expect(r.results[0]).toMatchObject({
        type: "Stance",
        id: 902,
        author: { id: 503, name: "Linus Placeholder" },
        snippet: null,
        snippet_hidden_reason: "until_vote",
        poll_id: 301,
      });
      expect(JSON.stringify(r)).not.toContain("reserve figure");
      expect(r.scope.hidden_stance_hits_dropped).toBe(0);
      expect(r.returned).toBe(1);
    });

    it("author mode with a visible poll shows the excerpt", async () => {
      mockFetch(200, searchBody({ polls: [pollRow()], search_results: [SEARCH_ROWS[2]!] }));
      const { searchContent } = await import("../src/tools/search.js");
      const r = await searchContent({ author_id: 503, types: ["Stance"] });
      expect(r.results[0]!.snippet).toBe("**Budget** reserve figure");
    });
  });

  it("author mode decodes the html-escaped excerpt into plain text", async () => {
    mockFetch(200, searchAuthorBody());
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ author_id: 502 });
    expect(r.results[0]!.snippet).toBe(
      "Below are the minutes from the meeting. That's one of the opportunities to engage & ...",
    );
    expect(r.results[0]!.url).toBe("https://www.loomio.com/d/dscKEY02/how-to-nominate-a-candidate");
  });

  it("flags Loomio's 20-result cap", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      searchResultRow({ id: 300000 + i, searchable_id: 1000 + i }),
    );
    mockFetch(200, searchBody({ search_results: rows }));
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget" });
    expect(r.returned).toBe(20);
    expect(r.capped).toBe(true);
    expect(r.scope.note).toMatch(/at most 20/);
  });

  it("an empty result set is empty, not an error", async () => {
    mockFetch(200, searchBody({ search_results: [], users: [], polls: [] }));
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "zzzz" });
    expect(r.results).toEqual([]);
    expect(r.returned).toBe(0);
    expect(r.capped).toBe(false);
  });

  it("caps snippets at 400 characters", async () => {
    const long = `<b>budget</b> ${"x".repeat(1000)}`;
    mockFetch(200, searchBody({ search_results: [searchResultRow({ highlight: long })] }));
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget" });
    expect(r.results[0]!.snippet).toHaveLength(400);
    expect(r.results[0]!.snippet!.startsWith("**budget** xxx")).toBe(true);
  });

  it("a row with no group or author yields null objects, no url without keys", async () => {
    mockFetch(
      200,
      searchBody({
        search_results: [
          searchResultRow({
            group_id: null,
            group_name: null,
            group_handle: null,
            author_id: null,
            author_name: null,
            discussion_key: null,
            poll_key: null,
            highlight: null,
          }),
        ],
      }),
    );
    const { searchContent } = await import("../src/tools/search.js");
    const r = await searchContent({ query: "budget" });
    expect(r.results[0]).toMatchObject({ group: null, author: null, snippet: null });
    expect(r.results[0]).not.toHaveProperty("url");
  });
});

describe("searchContent — schema", () => {
  it("requires query or author_id (or both) and a non-blank query", async () => {
    const { searchContentSchema } = await import("../src/tools/search.js");
    expect(searchContentSchema.safeParse({}).success).toBe(false);
    expect(searchContentSchema.safeParse({ query: "   " }).success).toBe(false);
    expect(searchContentSchema.safeParse({ query: "budget" }).success).toBe(true);
    expect(searchContentSchema.safeParse({ author_id: 5 }).success).toBe(true);
    expect(searchContentSchema.safeParse({ query: "budget", author_id: 5 }).success).toBe(true);
    expect(searchContentSchema.safeParse({ query: "budget", types: [] }).success).toBe(false);
    expect(searchContentSchema.safeParse({ query: "budget", types: ["Reaction"] }).success).toBe(
      false,
    );
    expect(searchContentSchema.safeParse({ query: "budget", order: "newest" }).success).toBe(false);
  });
});

describe("snippet helpers", () => {
  it("decodeHtmlEntities handles named, decimal and hex references and leaves unknowns alone", async () => {
    const { decodeHtmlEntities } = await import("../src/loomio/shape.js");
    expect(
      decodeHtmlEntities("That&#39;s &amp; &lt;b&gt; &quot;x&quot; &#x27;y&#x27; &nbsp;z"),
    ).toBe("That's & <b> \"x\" 'y'  z");
    expect(decodeHtmlEntities("&bogus; &#99999999;")).toBe("&bogus; &#99999999;");
    expect(decodeHtmlEntities("plain")).toBe("plain");
  });

  it("highlightToMarkdown turns <b> into **, strips other tags, collapses whitespace, caps, and passes null", async () => {
    const { highlightToMarkdown } = await import("../src/loomio/shape.js");
    expect(
      highlightToMarkdown("a <b>match</b>\n\n<em>here</em> &amp; <strong>there</strong>"),
    ).toBe("a **match** here & **there**");
    expect(highlightToMarkdown(null)).toBeNull();
    expect(highlightToMarkdown(undefined)).toBeNull();
    expect(highlightToMarkdown("")).toBe("");
    expect(highlightToMarkdown("x".repeat(50), 10)).toBe("x".repeat(10));
  });
});
