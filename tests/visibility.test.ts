/**
 * Client-side poll result gating (src/loomio/visibility.ts). Loomio's
 * b2 API serialises `results` / `stance_counts` / `total_score` for
 * every poll whose `hide_results` is not `until_closed` — including an
 * OPEN `until_vote` poll the API user has not voted on, which the
 * browser client would hide. These tests pin Loomio's predicate
 * (poll.rb `results_visible?(voted:)`) and the strip.
 */

import { describe, expect, it } from "vitest";
import {
  gatePollResults,
  HIDDEN_RESULT_FIELDS,
  hiddenUntilVote,
  HIDDEN_STANCE_FIELDS,
  ownStanceFor,
  pollResultsVisible,
  stripHiddenResults,
  stripHiddenStanceResults,
} from "../src/loomio/visibility.js";
import type { LoomioPoll, LoomioStance } from "../src/loomio/types.js";

/** An open proposal as PollSerializer emits it under `hide_results: off` (results included). */
function poll(overrides: Partial<LoomioPoll> = {}): LoomioPoll {
  return {
    id: 301,
    key: "pollKEY9",
    title: "Adopt the budget?",
    poll_type: "proposal",
    hide_results: "off",
    closed_at: null,
    closing_at: "2026-10-01T12:00:00Z",
    anonymous: false,
    topic_id: 601,
    group_id: 7,
    results: [
      { id: 1, name: "agree", score: 3, voter_ids: [11, 12, 13] },
      { id: 2, name: "disagree", score: 1, voter_ids: [14] },
    ],
    stance_counts: [3, 1],
    total_score: 4,
    voters_count: 10,
    decided_voters_count: 4,
    undecided_voters_count: 6,
    cast_stances_pct: 40,
    ...overrides,
  };
}

const castStance: LoomioStance = {
  id: 9001,
  poll_id: 301,
  participant_id: 55,
  cast_at: "2026-09-19T10:00:00Z",
  revoked_at: null,
  latest: true,
  option_scores: { "1": 1 },
  reason: "Looks right",
};

describe("pollResultsVisible (Loomio's results_visible?(voted:))", () => {
  it("off → visible, voted or not", () => {
    expect(pollResultsVisible(poll())).toEqual({ visible: true });
    expect(pollResultsVisible(poll(), castStance)).toEqual({ visible: true });
  });

  it("until_closed → hidden while open, visible once closed", () => {
    expect(pollResultsVisible(poll({ hide_results: "until_closed" }))).toEqual({
      visible: false,
      reason: "until_closed",
    });
    expect(
      pollResultsVisible(poll({ hide_results: "until_closed" }), castStance),
      "voting does not lift until_closed",
    ).toEqual({ visible: false, reason: "until_closed" });
    expect(
      pollResultsVisible(poll({ hide_results: "until_closed", closed_at: "2026-09-20T00:00:00Z" })),
    ).toEqual({ visible: true });
  });

  it("until_vote → hidden without an own cast stance, visible with one, visible when closed", () => {
    const p = poll({ hide_results: "until_vote" });
    expect(pollResultsVisible(p)).toEqual({ visible: false, reason: "until_vote" });
    expect(pollResultsVisible(p, null)).toEqual({ visible: false, reason: "until_vote" });
    expect(pollResultsVisible(p, castStance)).toEqual({ visible: true });
    expect(pollResultsVisible(p, { cast_at: null }), "an uncast stance is not a vote").toEqual({
      visible: false,
      reason: "until_vote",
    });
    expect(
      pollResultsVisible(p, { ...castStance, revoked_at: "2026-09-19T11:00:00Z" }),
      "a revoked stance is not a vote",
    ).toEqual({ visible: false, reason: "until_vote" });
    expect(
      pollResultsVisible(poll({ hide_results: "until_vote", closed_at: "2026-09-20T00:00:00Z" })),
    ).toEqual({ visible: true });
  });

  // Security review nit 8. PollSerializer hides `hide_results` only on a
  // DISCARDED poll (hide_when_discarded); v0.0.16 read any absence as
  // "off" and showed the results. Absent on a kept poll is now unknown,
  // and unknown is hidden while the poll is open.
  it("a missing hide_results on a DISCARDED poll is treated as off (the serializer hides it there)", () => {
    expect(pollResultsVisible({ closed_at: null, discarded_at: "2026-10-01T00:00:00Z" })).toEqual({
      visible: true,
    });
  });

  it("a missing hide_results on a kept OPEN poll is hidden: until_vote unvoted, until_closed voted (v0.0.16: visible)", () => {
    expect(pollResultsVisible({ closed_at: null })).toEqual({
      visible: false,
      reason: "until_vote",
    });
    expect(pollResultsVisible({ closed_at: null, hide_results: undefined }, castStance)).toEqual({
      visible: false,
      reason: "until_closed",
    });
    // So get_thread_markdown refuses a thread holding such a poll.
    expect(hiddenUntilVote({ closed_at: null, opened_at: "2026-09-01T00:00:00Z" })).toBe(true);
  });

  it("a missing hide_results on a CLOSED poll is visible: every setting shows results once closed", () => {
    expect(pollResultsVisible({ closed_at: "2026-10-01T00:00:00Z" })).toEqual({ visible: true });
  });
});

describe("stripHiddenResults / gatePollResults", () => {
  it("visible: adds results_visible: true and keeps everything", () => {
    const out = stripHiddenResults(poll(), { visible: true });
    expect(out.results_visible).toBe(true);
    expect(out).not.toHaveProperty("results_hidden_reason");
    expect(out.results).toHaveLength(2);
    expect(out.stance_counts).toEqual([3, 1]);
    expect(out.total_score).toBe(4);
  });

  it("hidden: removes exactly the result fields, keeps participation counts, names the reason", () => {
    const p = poll({ hide_results: "until_vote", stv_results: { rounds: [] } });
    const out = gatePollResults(p);
    expect(out.results_visible).toBe(false);
    expect(out.results_hidden_reason).toBe("until_vote");
    for (const f of HIDDEN_RESULT_FIELDS) expect(out).not.toHaveProperty(f);
    // Voter ids lived inside `results[]`; they must be gone with it.
    expect(JSON.stringify(out)).not.toContain("voter_ids");
    expect(out).toMatchObject({
      id: 301,
      title: "Adopt the budget?",
      voters_count: 10,
      decided_voters_count: 4,
      undecided_voters_count: 6,
      cast_stances_pct: 40,
    });
    // Pure.
    expect(p.results).toHaveLength(2);
  });

  it("gatePollResults with the own stance lifts until_vote", () => {
    const out = gatePollResults(poll({ hide_results: "until_vote" }), castStance);
    expect(out.results_visible).toBe(true);
    expect(out.results).toHaveLength(2);
  });
});

describe("ownStanceFor", () => {
  const stances: LoomioStance[] = [
    { id: 1, poll_id: 301, participant_id: 11, cast_at: "2026-09-01T00:00:00Z", latest: true },
    { id: 2, poll_id: 301, participant_id: 55, cast_at: "2026-09-02T00:00:00Z", latest: true },
    { id: 3, poll_id: 302, participant_id: 55, cast_at: "2026-09-03T00:00:00Z", latest: true },
    { id: 4, poll_id: 301, participant_id: 55, cast_at: "2026-08-01T00:00:00Z", latest: false },
  ];

  it("on a poll show root any stance for the poll is the user's own (my_stance)", () => {
    expect(ownStanceFor(301, [stances[0]!], { showRoot: true })?.id).toBe(1);
    expect(ownStanceFor(301, [], { showRoot: true })).toBeUndefined();
  });

  it("in a thread's stances it needs ownUserId and picks the latest for that poll", () => {
    expect(ownStanceFor(301, stances, { ownUserId: 55 })?.id).toBe(2);
    expect(ownStanceFor(302, stances, { ownUserId: 55 })?.id).toBe(3);
    expect(ownStanceFor(301, stances, { ownUserId: 99 })).toBeUndefined();
    expect(ownStanceFor(301, stances), "no id → nothing assumed").toBeUndefined();
    expect(ownStanceFor(301, undefined, { ownUserId: 55 })).toBeUndefined();
  });
});

describe("stripHiddenStanceResults", () => {
  const other: LoomioStance = { ...castStance, id: 9002, participant_id: 77 };

  it("visible results: every stance keeps its vote", () => {
    expect(stripHiddenStanceResults(other, { visible: true })).toEqual(other);
  });

  it("hidden results: another voter's option_scores / none_of_the_above / reason go; the rest stays", () => {
    const out = stripHiddenStanceResults(
      { ...other, none_of_the_above: false },
      { visible: false, reason: "until_vote" },
      { ownUserId: 55 },
    );
    for (const f of HIDDEN_STANCE_FIELDS) expect(out).not.toHaveProperty(f);
    expect(out).toMatchObject({
      id: 9002,
      poll_id: 301,
      participant_id: 77,
      cast_at: other.cast_at,
    });
  });

  it("hidden results: the user's own stance keeps its vote", () => {
    const out = stripHiddenStanceResults(
      castStance,
      { visible: false, reason: "until_vote" },
      {
        ownUserId: 55,
      },
    );
    expect(out.option_scores).toEqual({ "1": 1 });
    expect(out.reason).toBe("Looks right");
  });

  it("with no ownUserId nothing is assumed to be own (errs towards hiding)", () => {
    const out = stripHiddenStanceResults(castStance, { visible: false, reason: "until_closed" });
    expect(out).not.toHaveProperty("option_scores");
    expect(out).not.toHaveProperty("reason");
  });
});

// get_thread_markdown's guard predicate and refusal (Loomio ≥ 3.10's
// Markdown export ignores until_vote: thread_markdown_service.rb:213-215).
describe("hiddenUntilVote", () => {
  it("true only for an OPEN until_vote poll the user has not voted in", async () => {
    const { hiddenUntilVote } = await import("../src/loomio/visibility.js");
    const open = poll({ hide_results: "until_vote", opened_at: "2026-09-01T12:00:00Z" });
    expect(hiddenUntilVote(open)).toBe(true);
    expect(hiddenUntilVote(open, castStance)).toBe(false);
    expect(hiddenUntilVote(open, { ...castStance, cast_at: null })).toBe(true);
    expect(hiddenUntilVote(open, { ...castStance, revoked_at: "2026-09-20T00:00:00Z" })).toBe(true);
    // Closed: results are public. until_closed / off: the export is right.
    expect(hiddenUntilVote({ ...open, closed_at: "2026-10-01T12:00:00Z" })).toBe(false);
    expect(hiddenUntilVote({ ...open, hide_results: "until_closed" })).toBe(false);
    expect(hiddenUntilVote({ ...open, hide_results: "off" })).toBe(false);
  });

  it("a draft or scheduled poll (opened_at null) has no votes to leak; an absent opened_at counts as opened (fail closed)", async () => {
    const { hiddenUntilVote } = await import("../src/loomio/visibility.js");
    expect(hiddenUntilVote(poll({ hide_results: "until_vote", opened_at: null }))).toBe(false);
    const noField = poll({ hide_results: "until_vote" });
    expect("opened_at" in noField).toBe(false);
    expect(hiddenUntilVote(noField)).toBe(true);
  });
});

describe("VisibilityRefusalError", () => {
  it("untilVote names every poll (id, key, title) and says why, where to read instead, and when it lifts", async () => {
    const { VisibilityRefusalError } = await import("../src/loomio/visibility.js");
    const err = VisibilityRefusalError.untilVote(701, [
      { id: 301, key: "pollKEY9", title: "Adopt the budget?" },
      { id: 302, key: null, title: null },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("VisibilityRefusalError");
    expect(err.polls.map((p) => p.id)).toEqual([301, 302]);
    expect(err.message).toMatch(/topic_id 701/);
    expect(err.message).toMatch(/poll 301 \(key pollKEY9\) "Adopt the budget\?"; poll 302\./);
    // Dated, not asserted of the instance: Loomio 3.8 / 3.9 still apply the rule.
    expect(err.message).toMatch(
      /From Loomio 3\.10 on, the Markdown export ignores 'hide results until vote'/,
    );
    expect(err.message).toMatch(/Loomio 3\.8 \/ 3\.9, whose export still applies the rule/);
    expect(err.message).toMatch(/list_thread_items \(same topic_id\) and get_poll apply the rule/);
    expect(err.message).toMatch(/lifts when the poll closes or the connector's user votes/);
  });

  it("unverified says the check could not finish and how far it got", async () => {
    const { VisibilityRefusalError } = await import("../src/loomio/visibility.js");
    const err = VisibilityRefusalError.unverified(701, 5000, 6200);
    expect(err.polls).toEqual([]);
    expect(err.message).toMatch(/could not verify/);
    expect(err.message).toMatch(/5000 of 6200 items read/);
    expect(VisibilityRefusalError.unverified(701, 5000, null).message).toMatch(
      /\(5000 items read\)/,
    );
  });
});
