/**
 * Poll result visibility, applied CLIENT-SIDE because Loomio's b2 API
 * does not fully apply it for an API user.
 *
 * Loomio's rule (app/models/poll.rb, 3.8.1):
 *
 *   results_available?          = hide_results != 'until_closed' || closed_at.present?
 *   results_visible?(voted:)    = results_available? &&
 *                                 (hide_results != 'until_vote' || closed_at.present? || voted)
 *
 * with `hide_results` one of `off`, `until_vote`, `until_closed`
 * (`enum :hide_results`). The browser client honours the second rule:
 * a member who has not voted on an `until_vote` poll sees no tallies.
 * The API does NOT: `PollSerializer#results_visible?` is
 * `poll.results_available?` alone, so `results`, `stance_counts`,
 * `total_score` (and `stv_results`) are serialised for every open
 * `until_vote` poll, and `StanceSerializer#include_results?` likewise
 * emits every voter's `option_scores` and `reason` once
 * `results_available?` holds. A connector that relayed those verbatim
 * would show a caller what the poll's author decided nobody should see
 * before voting — and a bot user never votes.
 *
 * So the tools compute `pollResultsVisible` with Loomio's exact
 * predicate, treating "voted" as "the API user's own latest stance is
 * cast" (`my_stance` side-load: `cast_at` set, not revoked), and strip
 * the result fields when it says no. `until_closed` is enforced by
 * Loomio itself (the fields are simply absent); it is re-checked here
 * only so the output carries a uniform `results_visible` /
 * `results_hidden_reason` pair whichever setting hid them.
 *
 * Anonymous polls (`anonymous: true`, voting_system `anonymous_ballot`)
 * never expose voter identities on any path: stances carry
 * `participant_id: null` and `include_my_stance?` is false. Nothing
 * here needs to — or can — de-anonymise them, and callers must not try
 * to infer voters from anything else in the payload.
 */

import type { LoomioPoll, LoomioStance } from "./types.js";

export type HiddenReason = "until_closed" | "until_vote";

export interface ResultsVisibility {
  visible: boolean;
  /** Set only when `visible` is false: which setting hid the results. */
  reason?: HiddenReason;
}

/** The API user's own stance, as far as visibility cares: cast and not revoked. */
export type OwnStance = Pick<LoomioStance, "cast_at" | "revoked_at"> | null | undefined;

/**
 * Loomio's `results_visible?(voted:)` for the connector's user. `ownStance`
 * is the poll's `my_stance` side-load (the `stances` root on a poll
 * show) — `undefined` / `null` means the API user has not voted.
 */
export function pollResultsVisible(
  poll: Pick<LoomioPoll, "hide_results" | "closed_at">,
  ownStance?: OwnStance,
): ResultsVisibility {
  const closed = Boolean(poll.closed_at);
  const hide = poll.hide_results ?? "off";
  if (hide === "until_closed" && !closed) return { visible: false, reason: "until_closed" };
  const voted = Boolean(ownStance?.cast_at) && !ownStance?.revoked_at;
  if (hide === "until_vote" && !closed && !voted) return { visible: false, reason: "until_vote" };
  return { visible: true };
}

/**
 * The PollSerializer fields that ARE the results (all gated by its
 * `results_visible?`). `results[]` carries per-option scores, voter ids
 * and voter scores; `stance_counts` per-option tallies; `total_score`
 * the sum; `stv_results` the transfer rounds of an STV poll.
 * Participation counts (`voters_count`, `decided_voters_count`,
 * `undecided_voters_count`, `cast_stances_pct`) are not results — Loomio
 * shows them under every setting — and stay.
 */
export const HIDDEN_RESULT_FIELDS = [
  "results",
  "stance_counts",
  "total_score",
  "stv_results",
] as const;

export type GatedPoll<T extends LoomioPoll> = Omit<T, (typeof HIDDEN_RESULT_FIELDS)[number]> &
  Partial<Pick<T, (typeof HIDDEN_RESULT_FIELDS)[number]>> & {
    results_visible: boolean;
    results_hidden_reason?: HiddenReason;
  };

/**
 * A shallow copy of `poll` with the result fields removed when
 * `visibility.visible` is false, and the uniform `results_visible` /
 * `results_hidden_reason` pair added either way. Pure: the input is not
 * mutated.
 */
export function stripHiddenResults<T extends LoomioPoll>(
  poll: T,
  visibility: ResultsVisibility,
): GatedPoll<T> {
  if (visibility.visible) return { ...poll, results_visible: true };
  const copy: Record<string, unknown> = { ...poll };
  for (const field of HIDDEN_RESULT_FIELDS) delete copy[field];
  return {
    ...(copy as Omit<T, (typeof HIDDEN_RESULT_FIELDS)[number]>),
    results_visible: false,
    ...(visibility.reason ? { results_hidden_reason: visibility.reason } : {}),
  };
}

/** `pollResultsVisible` + `stripHiddenResults` in one step — what the poll tools call. */
export function gatePollResults<T extends LoomioPoll>(
  poll: T,
  ownStance?: OwnStance,
): GatedPoll<T> {
  return stripHiddenResults(poll, pollResultsVisible(poll, ownStance));
}

/**
 * Find the API user's own stance for `poll` in a `stances[]` root. On a
 * poll SHOW the root holds only `my_stance`, so any stance for the poll
 * is the user's; in a thread's items the root holds every voter's
 * stance and the caller must pass `ownUserId` (from the health probe's
 * groups body: the membership rows' `user_id`) to pick theirs — with no
 * id, none is assumed, which errs towards hiding.
 */
export function ownStanceFor(
  pollId: number,
  stances: readonly LoomioStance[] | undefined,
  opts: { ownUserId?: number; showRoot?: boolean } = {},
): LoomioStance | undefined {
  const forPoll = (stances ?? []).filter((s) => s.poll_id === pollId && s.latest !== false);
  if (opts.showRoot) return forPoll[0];
  if (opts.ownUserId === undefined) return undefined;
  return forPoll.find((s) => s.participant_id === opts.ownUserId);
}

/** StanceSerializer fields gated by its `include_results?`. */
export const HIDDEN_STANCE_FIELDS = ["option_scores", "none_of_the_above", "reason"] as const;

/**
 * Apply the poll's visibility to one stance: when results are hidden,
 * every stance that is not the API user's own loses `option_scores`,
 * `none_of_the_above` and `reason` — the fields Loomio's browser client
 * would not show either. The user's own stance keeps them (Loomio
 * always shows a voter their own vote). Pure.
 */
export function stripHiddenStanceResults<T extends LoomioStance>(
  stance: T,
  visibility: ResultsVisibility,
  opts: { ownUserId?: number } = {},
): Omit<T, (typeof HIDDEN_STANCE_FIELDS)[number]> &
  Partial<Pick<T, (typeof HIDDEN_STANCE_FIELDS)[number]>> {
  const own = opts.ownUserId !== undefined && stance.participant_id === opts.ownUserId;
  if (visibility.visible || own) return { ...stance };
  const copy: Record<string, unknown> = { ...stance };
  for (const field of HIDDEN_STANCE_FIELDS) delete copy[field];
  return copy as Omit<T, (typeof HIDDEN_STANCE_FIELDS)[number]>;
}
