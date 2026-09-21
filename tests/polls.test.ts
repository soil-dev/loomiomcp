/**
 * Poll tools (src/tools/polls.ts) on Loomio 3.8.1: read profiles, topics
 * join, client-side result gating (`hide_results` off / until_closed /
 * until_vote with and without the API user's own stance), side-load
 * folding (poll_options, current_outcome, my_stance), `details`
 * truncation, canonical urls and `meta.total`; and the writes — the
 * NESTED create body with recipient keys in both places, `discussion_id`
 * → `topic_id` resolution, the pre-write group/thread mismatch guard,
 * the post-write misdirection guards, the per-type option rules, and
 * update / delete.
 */

import { describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { htmlToText } from "../src/loomio/shape.js";
import { HIDDEN_RESULT_FIELDS } from "../src/loomio/visibility.js";
import {
  discussionRow,
  EXAMPLE_ORG,
  GRACE,
  outcomeRow,
  ownStanceRow,
  POLL_OPTIONS,
  pollOptionRow,
  pollRow,
  pollShowBody,
  pollsListBody,
  topicRow,
} from "./fixtures.js";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

function requestUrl(index = 0): URL {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  return new URL(String(call![0]));
}

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

const PRESENTATION_FIELDS = [
  "result_columns",
  "chart_type",
  "chart_column",
  "poll_option_name_format",
  "limit_reason_length",
  "legacy_anonymous_vote_reasons_count",
  "attachments",
  "link_previews",
  "mentioned_usernames",
  "content_locale",
];

describe("getPoll", () => {
  it("GETs /b2/polls/{id} with the show profile and folds topic, options, outcome, url onto the poll", async () => {
    mockFetch(
      200,
      pollShowBody({ outcomes: [outcomeRow()], polls: [pollRow({ current_outcome_id: 801 })] }),
    );
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });

    const url = requestUrl();
    expect(url.pathname).toBe("/api/b2/polls/301");
    expect(url.searchParams.get("exclude_types")).toBe("parent membership reaction translation");
    expect(url.searchParams.has("compact")).toBe(false);
    expectBearerAuth(0, "test-key");

    expect(r.poll).toMatchObject({
      id: 301,
      key: "polKEY01",
      title: "Adopt the 2027 budget?",
      poll_type: "proposal",
      hide_results: "off",
      closed_at: null,
      group_id: 7,
      topic_id: 711,
      // topic join
      items_count: 3,
      replies_count: 2,
      active_polls_count: 1,
      tags: ["budget"],
      members_count: 12,
      // gating
      results_visible: true,
      stance_counts: [3, 1, 0],
      total_score: 4,
      url: "https://www.loomio.com/p/polKEY01/adopt-the-2027-budget",
    });
    expect(r.poll).not.toHaveProperty("results_hidden_reason");
    expect(Array.isArray(r.poll.results)).toBe(true);
    // Options sorted by priority, slimmed.
    expect(r.poll.poll_options).toEqual([
      { id: 1, name: "agree", priority: 0, meaning: "I support this", prompt: null },
      { id: 2, name: "disagree", priority: 1, meaning: "I object", prompt: null },
      { id: 3, name: "abstain", priority: 2, meaning: null, prompt: null },
    ]);
    expect(r.poll.current_outcome).toEqual({
      id: 801,
      poll_id: 301,
      poll_option_id: 1,
      statement: "<p>Adopted with three votes in favour.</p>",
      statement_format: "html",
      author_id: 502,
      created_at: "2026-10-01T13:00:00Z",
      review_on: null,
      latest: true,
    });
    expect(r.poll.my_stance).toBeNull();
    for (const f of PRESENTATION_FIELDS) expect(r.poll).not.toHaveProperty(f);
    expect(r.poll).not.toHaveProperty("reader_volume_email");
    // The show returns the full details text.
    expect(r.poll.details).toBe("<p>Shall we adopt the proposed budget?</p>");
    expect(r.group).toMatchObject({ id: 7, name: "Example Org", handle: "example-org" });
    expect(r.users).toEqual([{ id: 502, name: "Grace Sample", username: "grace" }]);
  });

  it("strip_html: true converts the HTML details to plain text (details_format 'text'), whole; the default keeps the stored HTML", async () => {
    const { getPoll } = await import("../src/tools/polls.js");
    mockFetch(200, pollShowBody());
    const r = await getPoll({ id_or_key: 301, strip_html: true });
    expect(r.poll.details).toBe("Shall we adopt the proposed budget?");
    expect(r.poll.details_format).toBe("text");
    expect(r.poll).not.toHaveProperty("details_truncated");
    expect(r.poll).not.toHaveProperty("details_chars");
    // Only the body is touched: the outcome statement stays as stored.
    mockFetch(200, pollShowBody({ outcomes: [outcomeRow()] }));
    const withOutcome = await getPoll({ id_or_key: 301, strip_html: true });
    expect(withOutcome.poll.current_outcome?.statement).toBe(
      "<p>Adopted with three votes in favour.</p>",
    );
    mockFetch(200, pollShowBody());
    const kept = await getPoll({ id_or_key: 301, strip_html: false });
    expect(kept.poll.details).toBe("<p>Shall we adopt the proposed budget?</p>");
    expect(kept.poll.details_format).toBe("html");
  });

  it("hide_results until_closed on an OPEN poll: results stripped, reason until_closed", async () => {
    // Loomio itself omits these fields here; the connector still emits
    // the uniform pair so callers can tell hidden from absent.
    mockFetch(200, pollShowBody({ polls: [pollRow({ hide_results: "until_closed" })] }));
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(r.poll.results_visible).toBe(false);
    expect(r.poll.results_hidden_reason).toBe("until_closed");
    for (const f of HIDDEN_RESULT_FIELDS) expect(r.poll).not.toHaveProperty(f);
    // Participation counts are not results and stay.
    expect(r.poll.voters_count).toBe(6);
    expect(r.poll.undecided_voters_count).toBe(2);
    expect(r.poll.poll_option_names).toEqual(["agree", "disagree", "abstain"]);
  });

  it("hide_results until_vote, OPEN, API user has NOT voted: Loomio sent the results, the connector strips them", async () => {
    mockFetch(200, pollShowBody({ polls: [pollRow({ hide_results: "until_vote" })] }));
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(r.poll.results_visible).toBe(false);
    expect(r.poll.results_hidden_reason).toBe("until_vote");
    for (const f of HIDDEN_RESULT_FIELDS) expect(r.poll).not.toHaveProperty(f);
    expect(JSON.stringify(r)).not.toContain("voter_ids");
    expect(r.poll.my_stance).toBeNull();
  });

  it("hide_results until_vote, OPEN, API user HAS voted (my_stance cast): results visible, own stance attached", async () => {
    mockFetch(
      200,
      pollShowBody({ polls: [pollRow({ hide_results: "until_vote" })], stances: [ownStanceRow()] }),
    );
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(r.poll.results_visible).toBe(true);
    expect(r.poll.stance_counts).toEqual([3, 1, 0]);
    expect(r.poll.my_stance).toEqual({
      id: 901,
      cast_at: "2026-09-05T10:00:00Z",
      revoked_at: null,
      option_scores: { "1": 1 },
      none_of_the_above: false,
      reason: "Looks sound.",
      reason_format: "md",
    });
  });

  it("hide_results until_vote with an UNCAST or REVOKED own stance still hides", async () => {
    const { getPoll } = await import("../src/tools/polls.js");
    mockFetch(
      200,
      pollShowBody({
        polls: [pollRow({ hide_results: "until_vote" })],
        stances: [ownStanceRow({ cast_at: null })],
      }),
    );
    expect((await getPoll({ id_or_key: 301 })).poll.results_visible).toBe(false);
    mockFetch(
      200,
      pollShowBody({
        polls: [pollRow({ hide_results: "until_vote" })],
        stances: [ownStanceRow({ revoked_at: "2026-09-06T00:00:00Z" })],
      }),
    );
    expect((await getPoll({ id_or_key: 301 })).poll.results_visible).toBe(false);
  });

  it("a CLOSED poll shows results under every hide_results setting", async () => {
    const { getPoll } = await import("../src/tools/polls.js");
    for (const hide of ["off", "until_vote", "until_closed"] as const) {
      mockFetch(
        200,
        pollShowBody({
          polls: [pollRow({ hide_results: hide, closed_at: "2026-10-01T12:00:00Z" })],
        }),
      );
      const r = await getPoll({ id_or_key: 301 });
      expect(r.poll.results_visible).toBe(true);
      expect(r.poll.total_score).toBe(4);
    }
  });

  it("an anonymous poll carries anonymous:true and never a my_stance (Loomio sends none)", async () => {
    mockFetch(
      200,
      pollShowBody({
        polls: [
          pollRow({
            anonymous: true,
            voting_system: "anonymous_ballot",
            hide_results: "until_closed",
            closed_at: "2026-10-01T12:00:00Z",
          }),
        ],
      }),
    );
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(r.poll.anonymous).toBe(true);
    expect(r.poll.my_stance).toBeNull();
    expect(r.poll.results_visible).toBe(true);
  });

  it("falls back to the poll's latest outcome when current_outcome_id is absent", async () => {
    mockFetch(200, pollShowBody({ outcomes: [outcomeRow({ id: 802 })] }));
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(r.poll.current_outcome?.id).toBe(802);
  });

  it("a 200 without a poll record is a shape error", async () => {
    mockFetch(200, { polls: [], meta: { root: "polls" } });
    const { getPoll } = await import("../src/tools/polls.js");
    await expect(getPoll({ id_or_key: 301 })).rejects.toThrow(/without a poll record/);
  });

  it("encodes string keys as a single path segment", async () => {
    mockFetch(200, pollShowBody());
    const { getPoll } = await import("../src/tools/polls.js");
    await getPoll({ id_or_key: "../memberships?group_id=7" });
    expect(requestUrl().pathname).toBe("/api/b2/polls/..%2Fmemberships%3Fgroup_id%3D7");
  });

  it("rejects path-like string keys at schema layer and dot-only keys before any request", async () => {
    const { getPoll, getPollSchema } = await import("../src/tools/polls.js");
    expect(getPollSchema.safeParse({ id_or_key: "abcDEF12" }).success).toBe(true);
    expect(getPollSchema.safeParse({ id_or_key: "../memberships?group_id=7" }).success).toBe(false);
    expect(getPollSchema.safeParse({ id_or_key: "abc/def" }).success).toBe(false);
    await expect(getPoll({ id_or_key: ".." })).rejects.toThrow(/id_or_key/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("listPolls", () => {
  it("GETs /b2/polls with group_id, status, pagination and the list profile", async () => {
    mockFetch(200, pollsListBody());
    const { listPolls } = await import("../src/tools/polls.js");
    await listPolls({ group_id: 7, status: "closed", limit: 25, offset: 100 });

    const url = requestUrl();
    expect(url.pathname).toBe("/api/b2/polls");
    expect(url.searchParams.get("group_id")).toBe("7");
    expect(url.searchParams.get("status")).toBe("closed");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("100");
    expect(url.searchParams.get("exclude_types")).toBe(
      "group parent membership reaction translation",
    );
    expect(url.searchParams.has("compact")).toBe(false);
    expectBearerAuth(0, "test-key");
  });

  it("sends status=active explicitly by default (Loomio's own fall-through) and omits limit/offset", async () => {
    mockFetch(200, pollsListBody());
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7 });
    const url = requestUrl();
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
    expect(r.scope).toEqual({
      group_id: 7,
      status: "active",
      offset: 0,
      description_max_chars: 1500,
      strip_html: true,
    });
  });

  it("shapes each poll (join, gate, options, url), slims users, surfaces total/returned", async () => {
    mockFetch(200, pollsListBody());
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7 });
    expect(r.total).toBe(1);
    expect(r.returned).toBe(1);
    expect(r.polls[0]).toMatchObject({
      id: 301,
      items_count: 3,
      results_visible: true,
      url: "https://www.loomio.com/p/polKEY01/adopt-the-2027-budget",
    });
    expect(r.polls[0]!.poll_options.map((o) => o.name)).toEqual(["agree", "disagree", "abstain"]);
    expect(r.polls[0]!.current_outcome).toBeNull();
    for (const f of PRESENTATION_FIELDS) expect(r.polls[0]).not.toHaveProperty(f);
    expect(r.users).toEqual([{ id: 502, name: "Grace Sample", username: "grace" }]);
    expect(r).not.toHaveProperty("groups");
    expect(r).not.toHaveProperty("poll_options");
  });

  it("a LIST row is slim: no results[] / stv_results even when visible (stance_counts + total_score stay), no poll_option_names beside poll_options[], no null type knobs", async () => {
    mockFetch(200, pollsListBody({ polls: [pollRow({ stv_results: { rounds: [] } })] }));
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7 });
    const row = r.polls[0]!;
    expect(row.results_visible).toBe(true);
    // The per-option tallies survive, aligned with poll_options[] order.
    expect(row.stance_counts).toEqual([3, 1, 0]);
    expect(row.total_score).toBe(4);
    expect(row.poll_options.map((o) => o.name)).toEqual(["agree", "disagree", "abstain"]);
    // The voter-id breakdown does not: that is get_poll's.
    expect(row).not.toHaveProperty("results");
    expect(row).not.toHaveProperty("stv_results");
    expect(JSON.stringify(row)).not.toContain("voter_ids");
    // Names are already on poll_options[].
    expect(row).not.toHaveProperty("poll_option_names");
    // Type-specific knobs Loomio nulled for a proposal are gone; set ones stay.
    for (const k of [
      "agree_target",
      "meeting_duration",
      "stv_seats",
      "stv_method",
      "stv_quota",
      "quorum_pct",
      "poll_template_id",
      "reason_prompt",
      "opening_at",
      "discarded_by",
    ]) {
      expect(row, k).not.toHaveProperty(k);
    }
    expect(row.max_score).toBe(1);
    expect(row.opened_at).toBe("2026-09-01T12:00:00Z");
    // Identity, schedule, participation and the gate flags are all there.
    expect(row).toMatchObject({
      id: 301,
      key: "polKEY01",
      poll_type: "proposal",
      hide_results: "off",
      voters_count: 6,
      decided_voters_count: 4,
      undecided_voters_count: 2,
      items_count: 3,
    });
  });

  it("a LIST row keeps poll_option_names when the poll_options root is missing (nothing else names the options)", async () => {
    mockFetch(200, pollsListBody({ poll_options: undefined }));
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7 });
    expect(r.polls[0]!.poll_options).toEqual([]);
    expect(r.polls[0]!.poll_option_names).toEqual(["agree", "disagree", "abstain"]);
  });

  it("the SHOW keeps results[] and poll_option_names (the full record)", async () => {
    mockFetch(200, pollShowBody());
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(Array.isArray(r.poll.results)).toBe(true);
    expect(r.poll.poll_option_names).toEqual(["agree", "disagree", "abstain"]);
    expect(r.poll).toHaveProperty("stv_seats", null);
  });

  it("gates each poll independently and picks each poll's own stance from the shared stances root", async () => {
    const open = pollRow({ id: 301, key: "polKEY01", hide_results: "until_vote", topic_id: 711 });
    const voted = pollRow({
      id: 302,
      key: "polKEY02",
      title: "Meeting time",
      hide_results: "until_vote",
      topic_id: 712,
      stance_counts: [2],
      results: [{ id: 4, poll_id: 302, name: "Monday", score: 2, voter_ids: [501, 502] }],
      total_score: 2,
      poll_option_names: ["Monday"],
    });
    mockFetch(
      200,
      pollsListBody({
        polls: [open, voted],
        stances: [ownStanceRow({ id: 902, poll_id: 302, option_scores: { "4": 1 } })],
        poll_options: [...POLL_OPTIONS, { id: 4, poll_id: 302, name: "Monday", priority: 0 }],
        meta: { root: "polls", total: 2 },
      }),
    );
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7 });
    expect(r.polls[0]).toMatchObject({
      id: 301,
      results_visible: false,
      results_hidden_reason: "until_vote",
    });
    expect(r.polls[0]!.my_stance).toBeNull();
    expect(r.polls[0]).not.toHaveProperty("results");
    expect(r.polls[1]).toMatchObject({ id: 302, results_visible: true, total_score: 2 });
    expect(r.polls[1]!.my_stance?.id).toBe(902);
    expect(r.polls[1]!.poll_options).toEqual([{ id: 4, name: "Monday", priority: 0 }]);
  });

  it("by default (strip_html true) a LIST row's HTML details is plain text BEFORE the cap: details_format 'text', the flags describe the text", async () => {
    const { listPolls } = await import("../src/tools/polls.js");
    mockFetch(200, pollsListBody());
    const plain = await listPolls({ group_id: 7 });
    expect(plain.polls[0]!.details).toBe("Shall we adopt the proposed budget?");
    expect(plain.polls[0]!.details_format).toBe("text");
    expect(plain.polls[0]).not.toHaveProperty("details_truncated");

    const long = `<p>${"Context. ".repeat(300)}</p>`;
    const text = htmlToText(long);
    mockFetch(200, pollsListBody({ polls: [pollRow({ details: long })] }));
    const r = await listPolls({ group_id: 7, description_max_chars: 100 });
    expect(r.polls[0]!.details).toBe(text.slice(0, 100));
    expect(r.polls[0]!.details_format).toBe("text");
    expect(r.polls[0]!.details_truncated).toBe(true);
    expect(r.polls[0]!.details_chars).toBe(text.length);

    mockFetch(200, pollsListBody({ polls: [pollRow({ details: long })] }));
    const omitted = await listPolls({ group_id: 7, description_max_chars: 0 });
    expect(omitted.polls[0]).not.toHaveProperty("details");
    expect(omitted.polls[0]!.details_omitted).toBe(true);
    expect(omitted.polls[0]!.details_chars).toBe(text.length);
  });

  it("strip_html: false — an HTML `details` longer than the cap is stripped of tag attributes before the cut; details_chars is the stored length; Markdown is never rewritten either way", async () => {
    const anchor =
      '<a target="_blank" href="https://example.org/budget" rel="nofollow ugc noreferrer noopener">the budget</a>';
    const long = `<p>Read ${anchor} ${"and decide. ".repeat(40)}</p>`;
    mockFetch(200, pollsListBody({ polls: [pollRow({ details: long, details_format: "html" })] }));
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7, description_max_chars: 120, strip_html: false });
    const details = r.polls[0]!.details as string;
    expect(details).toHaveLength(120);
    expect(
      details.startsWith('<p>Read <a href="https://example.org/budget">the budget</a> and decide.'),
    ).toBe(true);
    expect(details).not.toContain("rel=");
    expect(r.polls[0]!.details_format).toBe("html");
    expect(r.polls[0]!.details_truncated).toBe(true);
    expect(r.polls[0]!.details_chars).toBe(long.length);
    expect(r.scope.strip_html).toBe(false);
    // Markdown details are never rewritten — with the default strip_html too.
    const md = `[the budget](https://example.org/budget) ${"and decide. ".repeat(40)}`;
    mockFetch(200, pollsListBody({ polls: [pollRow({ details: md, details_format: "md" })] }));
    const m = await listPolls({ group_id: 7, description_max_chars: 50 });
    expect(m.polls[0]!.details).toBe(md.slice(0, 50));
    expect(m.polls[0]!.details_format).toBe("md");
  });

  it("an empty page keeps meta.total", async () => {
    mockFetch(200, { polls: [], meta: { root: "polls", total: 0 } });
    const { listPolls } = await import("../src/tools/polls.js");
    const r = await listPolls({ group_id: 7, status: "closed" });
    expect(r.polls).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.returned).toBe(0);
  });

  it("schema: rejects invalid status, limit > 200 and description_max_chars < -1; strip_html is a boolean", async () => {
    const { getPollSchema, listPollsSchema } = await import("../src/tools/polls.js");
    expect(listPollsSchema.safeParse({ group_id: 1, status: "bogus" }).success).toBe(false);
    expect(listPollsSchema.safeParse({ group_id: 1, limit: 500 }).success).toBe(false);
    expect(listPollsSchema.safeParse({ group_id: 1, description_max_chars: -2 }).success).toBe(
      false,
    );
    for (const s of ["active", "closed", "all"]) {
      expect(listPollsSchema.safeParse({ group_id: 1, status: s }).success).toBe(true);
    }
    expect(listPollsSchema.safeParse({ group_id: 1, strip_html: false }).success).toBe(true);
    expect(listPollsSchema.safeParse({ group_id: 1, strip_html: "no" }).success).toBe(false);
    expect(getPollSchema.safeParse({ id_or_key: 1, strip_html: true }).success).toBe(true);
    expect(getPollSchema.safeParse({ id_or_key: 1, strip_html: 1 }).success).toBe(false);
  });

  // The tools/list catalogue is paid for by every session before its
  // first question, so each field's text is capped at 120 characters.
  it("every field description in the poll schemas is at most 120 characters", async () => {
    const m = await import("../src/tools/polls.js");
    const schemas = {
      getPollSchema: m.getPollSchema,
      listPollsSchema: m.listPollsSchema,
      createPollSchema: m.createPollSchema,
      updatePollSchema: m.updatePollSchema,
      deletePollSchema: m.deletePollSchema,
    };
    // Text owned by src/tools/_common.ts (maxCharsSchema, formatFieldDescription) is checked where it lives.
    const SHARED = new Set(["description_max_chars", "details_format"]);
    for (const [name, schema] of Object.entries(schemas)) {
      const shape = schema.def.shape as Record<string, { description?: string }>;
      for (const [field, def] of Object.entries(shape)) {
        if (SHARED.has(field)) continue;
        // A self-naming field (title, group_id, details) carries no describe
        // at all: the key costs ~25 bytes per session and adds nothing.
        if (def.description === undefined) continue;
        expect(def.description.length, `${name}.${field}: ${def.description}`).toBeLessThanOrEqual(
          120,
        );
      }
    }
  });
});

/** The echo Loomio gives a successful poll write: `respond_with_resource` roots. */
function pollWriteBody(overrides: Partial<ReturnType<typeof pollRow>> = {}) {
  const poll = pollRow({
    id: 11,
    key: "newPOLL11",
    group_id: 3,
    topic_id: 5,
    poll_option_names: ["A", "B"],
    poll_option_ids: [41, 42],
    ...overrides,
  });
  return {
    polls: [poll],
    poll_options: [
      pollOptionRow({ id: 41, poll_id: poll.id, name: "A", priority: 0 }),
      pollOptionRow({ id: 42, poll_id: poll.id, name: "B", priority: 1 }),
    ],
    topics: [topicRow({ id: poll.topic_id ?? 5, topicable_type: "Poll", topicable_id: poll.id })],
    groups: [EXAMPLE_ORG],
    users: [GRACE],
    meta: { root: "polls" },
  };
}

describe("createPoll — standalone (group_id)", () => {
  it("POSTs ONE NESTED {poll: {…}} body; recipient keys travel nested AND top-level (PollService.invite reads the top level)", async () => {
    mockFetch(200, pollWriteBody());
    const { createPoll } = await import("../src/tools/polls.js");
    const r = await createPoll({
      title: "Choose",
      poll_type: "poll",
      group_id: 3,
      options: ["A", "B"],
      closing_at: "2026-12-01T12:00:00Z",
      recipient_audience: "group",
      notify_recipients: true,
      recipient_message: "Please vote",
    });

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/polls");
    expect(req.url.search).toBe("");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({
      recipient_audience: "group",
      notify_recipients: true,
      recipient_message: "Please vote",
      poll: {
        title: "Choose",
        poll_type: "poll",
        group_id: 3,
        options: ["A", "B"],
        closing_at: "2026-12-01T12:00:00Z",
        recipient_audience: "group",
        notify_recipients: true,
        recipient_message: "Please vote",
      },
    });
    // Neither of the thread keys leaks into a standalone body.
    expect(req.body!["poll"]).not.toHaveProperty("topic_id");
    expect(req.body!["poll"]).not.toHaveProperty("discussion_id");
    expectBearerAuth(0, "test-key");

    // Shaped like get_poll, not Loomio's raw roots, plus `opened`.
    expect(Object.keys(r).sort()).toEqual(["group", "opened", "poll", "users"]);
    expect(r.opened).toBe(true);
    expect(r).not.toHaveProperty("warning");
    expect(r.poll.id).toBe(11);
    expect(r.poll.url).toMatch(/\/p\/newPOLL11\//);
    expect(r.poll.poll_options.map((o) => o.name)).toEqual(["A", "B"]);
    expect(r.poll.items_count).toBe(topicRow().items_count);
    expect(r.group?.id).toBe(7);
    expect(r.users).toEqual([{ id: 502, name: "Grace Sample", username: "grace" }]);
  });

  it("sends only the keys the caller set (no undefined placeholders reach PermittedParams' :raise mode)", async () => {
    mockFetch(200, pollWriteBody({ poll_option_names: ["agree", "disagree"] }));
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({
      title: "P",
      poll_type: "proposal",
      group_id: 3,
      options: ["agree", "disagree"],
    });
    expect(requestOf().body).toEqual({
      poll: { title: "P", poll_type: "proposal", group_id: 3, options: ["agree", "disagree"] },
    });
  });

  it("THROWS naming the created id when the echo has group_id null (the orphan a flat body produces)", async () => {
    mockFetch(200, pollWriteBody({ group_id: null }));
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createPoll } = await import("../src/tools/polls.js");
    const err = await createPoll({
      title: "P",
      poll_type: "poll",
      group_id: 3,
      options: ["A"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.message).toMatch(/poll 11 but in group null, not the requested group 3/);
    expect(err.message).toMatch(/get_poll 11/);
    expect(err.message).toMatch(/delete_poll/);
  });

  it("THROWS when the echo shows NO options although options were sent (the other flat-body symptom)", async () => {
    mockFetch(200, pollWriteBody({ poll_option_names: [] }));
    const { createPoll } = await import("../src/tools/polls.js");
    await expect(
      createPoll({ title: "P", poll_type: "poll", group_id: 3, options: ["A", "B"] }),
    ).rejects.toThrow(/poll 11 but with NO options although options were sent/);
  });

  it("does not trip the options guard for a 'question' (no options were sent)", async () => {
    mockFetch(200, pollWriteBody({ poll_type: "question", poll_option_names: [] }));
    const { createPoll } = await import("../src/tools/polls.js");
    const r = await createPoll({ title: "Q?", poll_type: "question", group_id: 3 });
    expect(r.poll.poll_type).toBe("question");
  });

  // PollService.build sets opened_at only when closing_at is present;
  // without it Loomio saves a draft (200, opened_at null) that nobody can
  // vote on and Poll.active — list_polls' default — does not list.
  it("an echo with opened_at null (no closing_at) is reported as a draft: opened false plus a warning naming update_poll", async () => {
    mockFetch(200, pollWriteBody({ opened_at: null, closing_at: null }));
    const { createPoll } = await import("../src/tools/polls.js");
    const r = await createPoll({ title: "P", poll_type: "poll", group_id: 3, options: ["A", "B"] });
    expect(r.opened).toBe(false);
    expect(r.warning).toMatch(/NOT open for voting/);
    expect(r.warning).toMatch(/no closing_at/);
    expect(r.warning).toMatch(/list_polls \(status 'active'\) will not show it/);
    expect(r.warning).toMatch(/update_poll with a future closing_at/);
    expect(r.poll.opened_at).toBeNull();
  });

  // notify_on_open is a Poll column (DB default TRUE) in
  // PermittedParams#poll_attributes; PollService.create runs
  // announce_poll_opened when the poll opens and it is true. The connector
  // sends it nested like every other poll attribute, and never invents it.
  it("notify_on_open travels nested only, and is absent unless the caller set it", async () => {
    mockFetch(200, pollWriteBody());
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({
      title: "Quiet",
      poll_type: "poll",
      group_id: 3,
      options: ["A"],
      closing_at: "2026-12-01T12:00:00Z",
      notify_on_open: false,
    });
    const body = requestOf().body!;
    expect(body["poll"]).toMatchObject({ notify_on_open: false });
    expect(body).not.toHaveProperty("notify_on_open");

    mockFetch(200, pollWriteBody());
    await createPoll({ title: "Loud", poll_type: "poll", group_id: 3, options: ["A"] });
    expect(requestOf(1).body!["poll"]).not.toHaveProperty("notify_on_open");
  });

  // details_format defaults to "md" on Loomio's side (db/schema.rb); HTML
  // sent without it would be stored as Markdown.
  it("refuses HTML `details` without details_format at the schema (Loomio would store it as Markdown); Markdown and explicit formats pass", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const base = { title: "P", poll_type: "poll", group_id: 3, options: ["A"] };
    const html = createPollSchema.safeParse({ ...base, details: "<p>Context</p>" });
    expect(html.success).toBe(false);
    expect(JSON.stringify(html.error?.issues)).toMatch(/details_format/);
    // The refusal text is _common.ts's shared wording; only the fact (omitted = 'md') is pinned.
    expect(JSON.stringify(html.error?.issues)).toMatch(/'md'/);
    expect(
      createPollSchema.safeParse({ ...base, details: "<p>Context</p>", details_format: "html" })
        .success,
    ).toBe(true);
    expect(createPollSchema.safeParse({ ...base, details: "Plain **md** text" }).success).toBe(
      true,
    );
    expect(
      createPollSchema.safeParse({ ...base, details: "Inline <br> is still Markdown" }).success,
    ).toBe(true);
  });
});

describe("createPoll — inside a discussion", () => {
  it("discussion_id: ONE compact GET to resolve the thread, then POST with topic_id and NO group_id", async () => {
    mockFetch(200, { discussions: [discussionRow({ id: 601, topic_id: 701, group_id: 7 })] });
    mockFetch(200, pollWriteBody({ topic_id: 701, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    const r = await createPoll({
      title: "P",
      poll_type: "poll",
      discussion_id: 601,
      options: ["A", "B"],
    });

    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    const get = requestOf(0);
    expect(get.method).toBe("GET");
    expect(get.url.pathname).toBe("/api/b2/discussions/601");
    expect(get.url.searchParams.get("compact")).toBe("1");
    const post = requestOf(1);
    expect(post.method).toBe("POST");
    expect(post.url.pathname).toBe("/api/b2/polls");
    expect(post.body).toEqual({
      poll: { title: "P", poll_type: "poll", options: ["A", "B"], topic_id: 701 },
    });
    expect(post.body!["poll"]).not.toHaveProperty("group_id");
    expect(post.body!["poll"]).not.toHaveProperty("discussion_id");
    expect(r.poll.topic_id).toBe(701);
  });

  it("accepts the discussion's short key for the resolution GET", async () => {
    mockFetch(200, { discussions: [discussionRow({ id: 601, topic_id: 701, group_id: 7 })] });
    mockFetch(200, pollWriteBody({ topic_id: 701, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({ title: "P", poll_type: "poll", discussion_id: "dscKEY01", options: ["A"] });
    expect(requestOf(0).url.pathname).toBe("/api/b2/discussions/dscKEY01");
  });

  it("topic_id: no resolution call at all", async () => {
    mockFetch(200, pollWriteBody({ topic_id: 701, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({ title: "P", poll_type: "poll", topic_id: 701, options: ["A"] });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(requestOf().body).toEqual({
      poll: { title: "P", poll_type: "poll", options: ["A"], topic_id: 701 },
    });
  });

  it("REFUSES before writing when discussion_id and group_id disagree (409, one GET, no POST)", async () => {
    mockFetch(200, { discussions: [discussionRow({ id: 601, topic_id: 701, group_id: 7 })] });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createPoll } = await import("../src/tools/polls.js");
    const err = await createPoll({
      title: "P",
      poll_type: "poll",
      discussion_id: 601,
      group_id: 3,
      options: ["A"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/discussion 601 belongs to group 7, not the requested group 3/);
    expect(err.message).toMatch(/Nothing was created/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("a matching group_id is only a cross-check: the body still carries topic_id alone", async () => {
    mockFetch(200, { discussions: [discussionRow({ id: 601, topic_id: 701, group_id: 7 })] });
    mockFetch(200, pollWriteBody({ topic_id: 701, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({
      title: "P",
      poll_type: "poll",
      discussion_id: 601,
      group_id: 7,
      options: ["A"],
    });
    expect(requestOf(1).body).toEqual({
      poll: { title: "P", poll_type: "poll", options: ["A"], topic_id: 701 },
    });
  });

  it("THROWS when the echo landed in a different thread than requested", async () => {
    mockFetch(200, pollWriteBody({ topic_id: 999, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    await expect(
      createPoll({ title: "P", poll_type: "poll", topic_id: 701, options: ["A"] }),
    ).rejects.toThrow(/poll 11 but in thread 999, not the requested thread 701/);
  });

  it("an unknown discussion_id is Loomio's 404 — 'no such id or key', NOT 'not visible' (an invisible one is 403) — before any POST", async () => {
    mockFetch(404, { error: 404 });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createPoll } = await import("../src/tools/polls.js");
    const err = await createPoll({
      title: "P",
      poll_type: "poll",
      discussion_id: 601,
      options: ["A"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/no discussion with id or key "601"/);
    expect(err.message).toMatch(/answers 403 'Not authorized to show/);
    expect(err.message).toMatch(/identifier is wrong, not restricted/);
    expect(err.message).not.toMatch(/not a member/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});

describe("createPoll — topic_id together with group_id (cross-check BEFORE writing)", () => {
  const threadRow = (groupId: number) =>
    topicRow({ id: 701, group_id: groupId, topicable_type: "Discussion", topicable_id: 601 });

  it("reads GET /b2/threads/{topic_id}?compact=1 first and REFUSES with 409 on a group mismatch — no POST, nothing created", async () => {
    mockFetch(200, { threads: [threadRow(7)], discussions: [discussionRow()], users: [GRACE] });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { createPoll } = await import("../src/tools/polls.js");
    const err = await createPoll({
      title: "P",
      poll_type: "poll",
      topic_id: 701,
      group_id: 3,
      options: ["A"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/thread 701 belongs to group 7, not the requested group 3/);
    expect(err.message).toMatch(/Nothing was created/);
    expect(err.message).not.toMatch(/write body was not read/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const get = requestOf(0);
    expect(get.method).toBe("GET");
    expect(get.url.pathname).toBe("/api/b2/threads/701");
    expect(get.url.searchParams.get("compact")).toBe("1");
  });

  it("a matching group_id: one GET, then the POST carries topic_id alone", async () => {
    mockFetch(200, { threads: [threadRow(7)], discussions: [discussionRow()], users: [GRACE] });
    mockFetch(200, pollWriteBody({ topic_id: 701, group_id: 7 }));
    const { createPoll } = await import("../src/tools/polls.js");
    const r = await createPoll({
      title: "P",
      poll_type: "poll",
      topic_id: 701,
      group_id: 7,
      options: ["A"],
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    expect(requestOf(1).method).toBe("POST");
    expect(requestOf(1).body).toEqual({
      poll: { title: "P", poll_type: "poll", options: ["A"], topic_id: 701 },
    });
    expect(r.poll.topic_id).toBe(701);
  });

  it("an unknown or invisible topic_id is the thread route's 404 wording (there Loomio does collapse the two)", async () => {
    mockFetch(404, { error: 404 });
    const { createPoll } = await import("../src/tools/polls.js");
    const err = await createPoll({
      title: "P",
      poll_type: "poll",
      topic_id: 4040,
      group_id: 7,
      options: ["A"],
    }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/topic_id 4040/);
    expect(err.message).toMatch(/not found or not visible/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});

describe("createPollSchema — Loomio 3.8.1's poll types and their rules", () => {
  const base = { title: "x", group_id: 1 };

  it("accepts every poll_type in config/poll_types.yml, including the 3.8 additions check / question / stv", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const withOptions = ["proposal", "poll", "count", "score", "meeting", "dot_vote", "check"];
    for (const t of withOptions) {
      expect(createPollSchema.safeParse({ ...base, poll_type: t, options: ["A"] }).success).toBe(
        true,
      );
    }
    for (const t of ["ranked_choice", "stv"]) {
      expect(
        createPollSchema.safeParse({ ...base, poll_type: t, options: ["A", "B"] }).success,
      ).toBe(true);
    }
    expect(createPollSchema.safeParse({ ...base, poll_type: "question" }).success).toBe(true);
    expect(
      createPollSchema.safeParse({ ...base, poll_type: "made_up", options: ["A"] }).success,
    ).toBe(false);
  });

  it("REQUIRES options for every type with options — proposals included (Loomio has no built-in defaults over the API)", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const r = createPollSchema.safeParse({ ...base, poll_type: "proposal" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/needs at least 1 option/);
    expect(createPollSchema.safeParse({ ...base, poll_type: "poll" }).success).toBe(false);
  });

  it("ranked_choice and stv need at least 2 options (min_options: 2)", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    for (const t of ["ranked_choice", "stv"]) {
      expect(createPollSchema.safeParse({ ...base, poll_type: t, options: ["A"] }).success).toBe(
        false,
      );
    }
  });

  it("question takes NO options", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const r = createPollSchema.safeParse({ ...base, poll_type: "question", options: ["A"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/takes no options/);
  });

  it("requires a thread or a group, and refuses discussion_id together with topic_id", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "poll", options: ["A"] }).success,
    ).toBe(false);
    expect(
      createPollSchema.safeParse({
        title: "x",
        poll_type: "poll",
        options: ["A"],
        discussion_id: 1,
      }).success,
    ).toBe(true);
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "poll", options: ["A"], topic_id: 5 })
        .success,
    ).toBe(true);
    expect(
      createPollSchema.safeParse({
        title: "x",
        poll_type: "poll",
        options: ["A"],
        discussion_id: 1,
        topic_id: 5,
      }).success,
    ).toBe(false);
  });

  it("anonymous needs closing_at (PollService.invite 403s on an inactive anonymous poll AFTER saving it)", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const r = createPollSchema.safeParse({
      ...base,
      poll_type: "poll",
      options: ["A"],
      anonymous: true,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/closing_at/);
    expect(
      createPollSchema.safeParse({
        ...base,
        poll_type: "poll",
        options: ["A"],
        anonymous: true,
        closing_at: "2026-12-01T12:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("anonymous refuses a hide_results other than until_closed, and the prevent_anonymous types", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    const anon = { ...base, options: ["A"], anonymous: true, closing_at: "2026-12-01T12:00:00Z" };
    expect(
      createPollSchema.safeParse({ ...anon, poll_type: "poll", hide_results: "off" }).success,
    ).toBe(false);
    expect(
      createPollSchema.safeParse({ ...anon, poll_type: "poll", hide_results: "until_closed" })
        .success,
    ).toBe(true);
    for (const t of ["count", "meeting"]) {
      expect(createPollSchema.safeParse({ ...anon, poll_type: t }).success).toBe(false);
    }
    expect(
      createPollSchema.safeParse({
        ...base,
        poll_type: "question",
        anonymous: true,
        closing_at: anon.closing_at,
      }).success,
    ).toBe(false);
  });

  it("notify_on_closing_soon is Loomio's enum — 'all_members' (the 0.0.11 value) does not exist", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    for (const v of ["nobody", "author", "undecided_voters", "voters"]) {
      expect(
        createPollSchema.safeParse({
          ...base,
          poll_type: "poll",
          options: ["A"],
          notify_on_closing_soon: v,
        }).success,
      ).toBe(true);
    }
    expect(
      createPollSchema.safeParse({
        ...base,
        poll_type: "poll",
        options: ["A"],
        notify_on_closing_soon: "all_members",
      }).success,
    ).toBe(false);
  });

  it("closing_at must parse as a timestamp", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(
      createPollSchema.safeParse({
        ...base,
        poll_type: "poll",
        options: ["A"],
        closing_at: "next week",
      }).success,
    ).toBe(false);
  });

  // The `.describe()` texts are what the AI caller reads; these pin the
  // facts checked against Loomio 3.8.1 (schema defaults, poll_service.rb).
  it("field descriptions state Loomio's API-side defaults: md format, notify_on_open TRUE, closing_soon 'nobody', meeting_duration / can_respond_maybe unset", async () => {
    const { createPollSchema, updatePollSchema } = await import("../src/tools/polls.js");
    for (const schema of [createPollSchema, updatePollSchema]) {
      const shape = schema.def.shape as Record<string, { description?: string }>;
      // details_format carries _common.ts's shared wording; only the fact is pinned here.
      expect(shape["details_format"]!.description).toMatch(/'md'/);
      expect(shape["details_format"]!.description).not.toMatch(/defaults to html|group default/i);
      expect(shape["notify_on_open"]!.description).toMatch(/default is TRUE/);
      expect(shape["notify_on_open"]!.description).toMatch(/poll_announced/);
      expect(shape["notify_on_closing_soon"]!.description).toMatch(/default is 'nobody'/);
      expect(shape["notify_on_closing_soon"]!.description).not.toMatch(
        /own default is 'undecided_voters'/,
      );
      expect(shape["meeting_duration"]!.description).toMatch(/No default through the API/);
      expect(shape["can_respond_maybe"]!.description).toMatch(/default is false/);
      expect(shape["notify_recipients"]!.description).toMatch(/SEPARATE from notify_on_open/);
      expect(shape["notify_recipients"]!.description).not.toMatch(/nobody is told/);
    }
    // closing_at differs per tool: a poll CREATED without one is an
    // unopened draft, but on update an omitted closing_at leaves the
    // deadline alone. With the create text copied onto update_poll a
    // model asked to rename a poll invented a new deadline.
    const createShape = createPollSchema.def.shape as Record<string, { description?: string }>;
    const updateShape = updatePollSchema.def.shape as Record<string, { description?: string }>;
    expect(createShape["closing_at"]!.description).toMatch(/Effectively REQUIRED/);
    expect(updateShape["closing_at"]!.description).not.toMatch(/REQUIRED|draft/);
    expect(updateShape["closing_at"]!.description).toMatch(/omitted = unchanged/);
    expect(updateShape["closing_at"]!.description).toMatch(/next full hour/);
    // hide_results on update states the one PATCH rule, not the create default.
    expect(createShape["hide_results"]!.description).toMatch(/Default 'off'/);
    expect(updateShape["hide_results"]!.description).toMatch(/Cannot leave 'until_closed'/);
    expect(updateShape["hide_results"]!.description).not.toMatch(/Default/);
    const options = (updatePollSchema.def.shape as Record<string, { description?: string }>)[
      "options"
    ]!.description!;
    expect(options).toMatch(/never removes an option it saw/);
    expect(options).toMatch(/Not atomic/);
    expect(options).not.toMatch(/cannot be removed through this tool/);
  });
});

describe("updatePoll", () => {
  it("PATCHes /b2/polls/{id} with a NESTED body; recipients nested ONLY (PollService.update reads the permitted hash); ONE call without `options`", async () => {
    mockFetch(200, pollWriteBody({ title: "Renamed" }));
    const { updatePoll } = await import("../src/tools/polls.js");
    const r = await updatePoll({
      id_or_key: 11,
      title: "Renamed",
      closing_at: "2026-12-24T12:00:00Z",
      recipient_user_ids: [502],
      recipient_message: "Extended",
      notify_recipients: true,
    });

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/polls/11");
    expect(req.url.search).toBe("");
    expect(req.method).toBe("PATCH");
    expect(req.body).toEqual({
      poll: {
        title: "Renamed",
        closing_at: "2026-12-24T12:00:00Z",
        recipient_user_ids: [502],
        recipient_message: "Extended",
        notify_recipients: true,
      },
    });
    expect(Object.keys(req.body!)).toEqual(["poll"]);
    expect(r.poll.title).toBe("Renamed");
    expect(r.poll.poll_options.length).toBe(2);
    expect(r).not.toHaveProperty("options_sent");
  });

  // Loomio's `Poll#options=` (alias of `poll_option_names=`) REPLACES the
  // option set: every existing option missing from the array is marked
  // for destruction and saved away together with its stance_choices
  // (poll.rb / poll_option.rb, 3.8.1). The tool's ADD contract is kept
  // honest by reading the stored names first and sending the union.
  it("notify_on_open on update travels nested (open_poll_if_ready announces when a closing_at first opens a draft)", async () => {
    mockFetch(200, pollWriteBody());
    const { updatePoll } = await import("../src/tools/polls.js");
    await updatePoll({ id_or_key: 11, closing_at: "2026-12-24T12:00:00Z", notify_on_open: false });
    expect(requestOf().body).toEqual({
      poll: { closing_at: "2026-12-24T12:00:00Z", notify_on_open: false },
    });
  });

  it("refuses HTML `details` without details_format on update too", async () => {
    const { updatePollSchema } = await import("../src/tools/polls.js");
    expect(updatePollSchema.safeParse({ id_or_key: 1, details: "<p>x</p>" }).success).toBe(false);
    expect(
      updatePollSchema.safeParse({ id_or_key: 1, details: "<p>x</p>", details_format: "html" })
        .success,
    ).toBe(true);
  });

  it("`options` ADDS: one compact GET reads the STORED poll_option_names, the PATCH carries existing ∪ new (existing first, exact spelling), and options_sent echoes it", async () => {
    mockFetch(200, pollWriteBody({ poll_option_names: ["Agree", "Disagree"] }));
    mockFetch(200, pollWriteBody({ poll_option_names: ["Agree", "Disagree", "C"] }));
    const { updatePoll } = await import("../src/tools/polls.js");
    const r = await updatePoll({ id_or_key: 11, options: ["C", "Disagree"] });

    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    const get = requestOf(0);
    expect(get.method).toBe("GET");
    expect(get.url.pathname).toBe("/api/b2/polls/11");
    expect(get.url.searchParams.get("compact")).toBe("1");
    const patch = requestOf(1);
    expect(patch.method).toBe("PATCH");
    expect(patch.url.pathname).toBe("/api/b2/polls/11");
    // Never the bare ["C"] that would wipe Agree / Disagree and their votes.
    expect(patch.body).toEqual({ poll: { options: ["Agree", "Disagree", "C"] } });
    expect(r.options_sent).toEqual(["Agree", "Disagree", "C"]);
  });

  it("refuses to PATCH `options` blind when the poll read carries no poll_option_names (nothing is changed)", async () => {
    mockFetch(200, { polls: [{ id: 11, key: "newPOLL11" }], meta: { root: "polls" } });
    const { updatePoll } = await import("../src/tools/polls.js");
    await expect(updatePoll({ id_or_key: 11, options: ["C"] })).rejects.toThrow(
      /cannot tell which options exist.*Nothing was changed/,
    );
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("read-only mode refuses before the option lookup spends a call", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    try {
      const { LoomioReadOnlyError } = await import("../src/loomio/client.js");
      const { updatePoll } = await import("../src/tools/polls.js");
      await expect(updatePoll({ id_or_key: 11, options: ["C"] })).rejects.toBeInstanceOf(
        LoomioReadOnlyError,
      );
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      delete process.env["LOOMIO_MCP_READONLY"];
    }
  });

  it("mergePollOptions: existing names first in their order, new ones appended, exact duplicates dropped, case differences kept (Loomio would create a second option)", async () => {
    const { mergePollOptions } = await import("../src/tools/polls.js");
    expect(mergePollOptions(["Agree", "Disagree"], ["C"])).toEqual(["Agree", "Disagree", "C"]);
    expect(mergePollOptions(["Agree", "Disagree"], ["Disagree", "C", "C"])).toEqual([
      "Agree",
      "Disagree",
      "C",
    ]);
    expect(mergePollOptions([], ["A", "B"])).toEqual(["A", "B"]);
    expect(mergePollOptions(["Agree"], ["agree"])).toEqual(["Agree", "agree"]);
  });

  it("schema: an empty options array is refused (it would say 'add nothing' but Loomio would read it as 'keep nothing')", async () => {
    const { updatePollSchema } = await import("../src/tools/polls.js");
    expect(updatePollSchema.safeParse({ id_or_key: 1, options: [] }).success).toBe(false);
    expect(updatePollSchema.safeParse({ id_or_key: 1, options: ["A"] }).success).toBe(true);
  });

  it("accepts the short key; never offers poll_type, anonymous, group_id or tags (dropped or frozen upstream)", async () => {
    mockFetch(200, pollWriteBody());
    const { updatePoll, updatePollSchema } = await import("../src/tools/polls.js");
    await updatePoll({ id_or_key: "newPOLL11", hide_results: "until_closed" });
    expect(requestOf().url.pathname).toBe("/api/b2/polls/newPOLL11");
    const shape = updatePollSchema.def.shape as Record<string, unknown>;
    for (const k of ["poll_type", "anonymous", "group_id", "tags", "topic_id", "discussion_id"]) {
      expect(shape).not.toHaveProperty(k);
    }
    expect(updatePollSchema.safeParse({ id_or_key: 1 }).success).toBe(false);
  });

  it("a 403 'Not authorized to update Poll.' (e.g. a closed poll) is a permission refusal", async () => {
    mockFetch(403, { error: "Not authorized to update Poll." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { updatePoll } = await import("../src/tools/polls.js");
    const err = await updatePoll({ id_or_key: 11, title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
    expect(err.message).toContain("/b2/polls/:id");
  });

  it("a 422 from the model (hide_results cannot be relaxed) is passed through verbatim", async () => {
    mockFetch(422, { errors: { hide_results: ["cannot show results early"] } });
    const { updatePoll } = await import("../src/tools/polls.js");
    await expect(updatePoll({ id_or_key: 11, hide_results: "off" })).rejects.toThrow(
      /hide_results: cannot show results early/,
    );
  });
});

describe("deletePoll", () => {
  it("DELETEs /b2/polls/{id} and reports the soft discard", async () => {
    mockFetch(
      200,
      pollWriteBody({ title: null, details: null, discarded_at: "2026-09-20T10:00:00Z" }),
    );
    const { deletePoll } = await import("../src/tools/polls.js");
    const r = await deletePoll({ id_or_key: 11 });
    const req = requestOf();
    expect(req.url.pathname).toBe("/api/b2/polls/11");
    expect(req.method).toBe("DELETE");
    expect(req.body).toEqual({});
    expect(r.discarded).toBe(true);
    expect(r.poll.discarded_at).toBe("2026-09-20T10:00:00Z");
    expect(r.note).toMatch(/Soft-discarded/);
  });

  it("a 403 'Not authorized to destroy Poll.' is a permission refusal", async () => {
    mockFetch(403, { error: "Not authorized to destroy Poll." });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { deletePoll } = await import("../src/tools/polls.js");
    const err = await deletePoll({ id_or_key: "newPOLL11" }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("not_authorized");
  });
});
