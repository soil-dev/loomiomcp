/**
 * src/loomio/poll-fields.ts: Loomio's 3.14 poll vocabulary and the
 * translation from (and, for writes, to) the pre-3.14 one that the
 * `/api/b2` compatibility path and Loomio < 3.14 speak. The mapping is
 * Loomio's own (deploy/UPGRADING.md "User and Server API paths").
 */

import { describe, expect, it } from "vitest";
import {
  CLOSING_SOON_CURRENT_VALUE,
  CLOSING_SOON_LEGACY_VALUE,
  legacyPollParams,
  modernizePoll,
  modernizePollsIn,
  POLL_FIELD_RENAMES,
  POLL_PARAM_LEGACY_NAMES,
  POLL_RESULT_FIELD_RENAMES,
} from "../src/loomio/poll-fields.js";
import type { LoomioPoll } from "../src/loomio/types.js";

describe("the mapping", () => {
  it("is Loomio's table from deploy/UPGRADING.md, both directions consistent", () => {
    expect(POLL_FIELD_RENAMES).toEqual({
      voters_count: "vote_count_eligible",
      decided_voters_count: "vote_count_cast",
      undecided_voters_count: "vote_count_uncast",
      cast_stances_pct: "participation_pct",
      stance_counts: "scores_by_option",
      quorum_count: "quorum_threshold",
      quorum_votes_required: "quorum_shortfall",
      min_score: "score_min",
      max_score: "score_max",
      minimum_stance_choices: "choice_count_min",
      maximum_stance_choices: "choice_count_max",
      dots_per_person: "points_per_voter",
    });
    expect(POLL_RESULT_FIELD_RENAMES).toEqual({
      voter_count: "vote_count",
      voter_scores: "scores_by_voter",
    });
    // The writable settings are a subset of the field renames, inverted.
    for (const [current, legacy] of Object.entries(POLL_PARAM_LEGACY_NAMES)) {
      expect(POLL_FIELD_RENAMES[legacy as keyof typeof POLL_FIELD_RENAMES]).toBe(current);
    }
    expect(CLOSING_SOON_LEGACY_VALUE).toBe("undecided_voters");
    expect(CLOSING_SOON_CURRENT_VALUE).toBe("voters_uncast");
  });
});

describe("modernizePoll", () => {
  const legacy = {
    id: 1,
    voters_count: 6,
    decided_voters_count: 4,
    undecided_voters_count: 2,
    cast_stances_pct: "66.7",
    stance_counts: [3, 1],
    quorum_count: "3.0",
    quorum_votes_required: "0.0",
    min_score: 0,
    max_score: 5,
    minimum_stance_choices: 1,
    maximum_stance_choices: 2,
    dots_per_person: 8,
    notify_on_closing_soon: "undecided_voters",
    results: [
      { id: 10, voter_count: 3, voter_scores: { "55": 1 }, score: 3 },
      { id: -1, voter_count: 2, voter_scores: {}, name: "poll_receipts_page.not_voted" },
    ],
    title: "kept as is",
  } as unknown as LoomioPoll;

  it("renames every pre-3.14 field and result key and the reminder value, keeping everything else", () => {
    const out = modernizePoll(legacy) as Record<string, unknown>;
    expect(out).toEqual({
      id: 1,
      vote_count_eligible: 6,
      vote_count_cast: 4,
      vote_count_uncast: 2,
      participation_pct: "66.7",
      scores_by_option: [3, 1],
      quorum_threshold: "3.0",
      quorum_shortfall: "0.0",
      score_min: 0,
      score_max: 5,
      choice_count_min: 1,
      choice_count_max: 2,
      points_per_voter: 8,
      notify_on_closing_soon: "voters_uncast",
      results: [
        { id: 10, vote_count: 3, scores_by_voter: { "55": 1 }, score: 3 },
        { id: -1, vote_count: 2, scores_by_voter: {}, name: "poll_receipts_page.not_voted" },
      ],
      title: "kept as is",
    });
  });

  it("never mutates its input", () => {
    const before = JSON.stringify(legacy);
    modernizePoll(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it("returns the SAME object for a row already in the current vocabulary (the /user0 case)", () => {
    const current = {
      id: 2,
      vote_count_eligible: 6,
      scores_by_option: [1],
      notify_on_closing_soon: "voters_uncast",
      results: [{ id: 10, vote_count: 1, scores_by_voter: {} }],
    } as unknown as LoomioPoll;
    expect(modernizePoll(current)).toBe(current);
  });

  it("a row carrying both spellings keeps the current one and drops the old", () => {
    const both = { id: 3, voters_count: 99, vote_count_eligible: 6 } as unknown as LoomioPoll;
    expect(modernizePoll(both)).toEqual({ id: 3, vote_count_eligible: 6 });
  });

  it("tolerates results that are not rows", () => {
    const odd = { id: 4, results: [null, 7, "x"] } as unknown as LoomioPoll;
    expect(modernizePoll(odd)).toBe(odd);
  });
});

describe("modernizePollsIn", () => {
  it("rewrites the polls root of a response body and leaves the rest alone", () => {
    const body = {
      polls: [
        { id: 1, stance_counts: [1] },
        { id: 2, scores_by_option: [2] },
      ],
      topics: [{ id: 9, stance_counts: "not a poll field here" }],
      meta: { total: 2 },
    };
    const out = modernizePollsIn(body) as typeof body;
    expect(out.polls).toEqual([
      { id: 1, scores_by_option: [1] },
      { id: 2, scores_by_option: [2] },
    ]);
    expect(out.topics).toBe(body.topics);
    expect(out.meta).toBe(body.meta);
    expect(body.polls[0]).toEqual({ id: 1, stance_counts: [1] });
  });

  it("returns the same value when there is nothing to do", () => {
    const noPolls = { discussions: [{ id: 1 }] };
    expect(modernizePollsIn(noPolls)).toBe(noPolls);
    const current = { polls: [{ id: 1, scores_by_option: [1] }] };
    expect(modernizePollsIn(current)).toBe(current);
    expect(modernizePollsIn(null)).toBeNull();
    expect(modernizePollsIn("text")).toBe("text");
    const arr = [1];
    expect(modernizePollsIn(arr)).toBe(arr);
    const notArray = { polls: "nope" };
    expect(modernizePollsIn(notArray)).toBe(notArray);
  });
});

describe("legacyPollParams", () => {
  it("renames the five writable settings and the reminder value to the pre-3.14 names", () => {
    expect(
      legacyPollParams({
        title: "t",
        score_min: 1,
        score_max: 5,
        choice_count_min: 2,
        choice_count_max: 3,
        points_per_voter: 8,
        notify_on_closing_soon: "voters_uncast",
      }),
    ).toEqual({
      title: "t",
      min_score: 1,
      max_score: 5,
      minimum_stance_choices: 2,
      maximum_stance_choices: 3,
      dots_per_person: 8,
      notify_on_closing_soon: "undecided_voters",
    });
  });

  it("returns the same object when nothing applies, and skips undefined values", () => {
    const plain = { title: "t", notify_on_closing_soon: "author", score_min: undefined };
    expect(legacyPollParams(plain)).toBe(plain);
  });
});
