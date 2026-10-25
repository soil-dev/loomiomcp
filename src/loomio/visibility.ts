/**
 * Poll result visibility, applied CLIENT-SIDE because Loomio's b2 API
 * does not fully apply it for an API user.
 *
 * Loomio's rule (app/models/poll.rb, unchanged 3.8.1 → 3.13.1, :681-688):
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
 * Anonymous polls (`anonymous: true`) never expose voter identities on
 * any path: their ballots are separate records the b2 API does not
 * serialize, so such a poll has no stances at all, and
 * `include_my_stance?` is false (Loomio ≤ 3.9 marked them
 * `voting_system: anonymous_ballot`; 3.10 removed that field,
 * 917b2c2e4). Nothing here needs to — or can — de-anonymise them, and
 * callers must not try to infer voters from anything else in the
 * payload.
 *
 * Loomio's own Markdown export is the one b2 read the connector cannot
 * gate field by field: since 3.10 (df28cf845) ThreadMarkdownService
 * decides with `poll.results_available?` alone
 * (thread_markdown_service.rb:213-215, test "until vote exports include
 * votes and replies for non-voters and voters"), so an open `until_vote`
 * poll's every vote and results table are in the document whoever reads
 * it. get_thread_markdown therefore REFUSES such a thread
 * (`VisibilityRefusalError`, `hiddenUntilVote`) rather than hand out
 * what list_thread_items and get_poll withhold.
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
 *
 * Re-checked at 3.13.1: PollSerializer still gates exactly these four
 * on `results_visible?` = `results_available?`
 * (poll_serializer.rb:112-114, 197-215). The 3.10–3.13 additions are not
 * results: `quorum_count` / `quorum_votes_required` / `quorum_reached`
 * and the participation counts are gated by `participation_visible?`
 * (`!anonymous? || closed?`, :116-118) — hidden on an open anonymous
 * poll whatever `hide_results` says — and `weighted_voting` /
 * `result_heading_keys` describe the poll, not its votes. So the list is
 * unchanged.
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

/**
 * True when Loomio's Markdown export (≥ 3.10) would print what this
 * poll hides from the connector's user: the poll is OPEN — opened (a
 * draft or scheduled poll, `opened_at: null`, has no votes to leak;
 * an absent field counts as opened) and not closed — and hides its
 * results until the user votes, and `ownStance` says the user has not
 * voted. `until_closed` is not included: the export hides those itself
 * (`results_available?`). get_thread_markdown refuses a thread holding
 * such a poll.
 */
export function hiddenUntilVote(
  poll: Pick<LoomioPoll, "hide_results" | "closed_at" | "opened_at">,
  ownStance?: OwnStance,
): boolean {
  return poll.opened_at !== null && pollResultsVisible(poll, ownStance).reason === "until_vote";
}

/** What a refusal names about each poll it was refused for. */
export interface RefusedPoll {
  id: number;
  key?: string | null;
  title?: string | null;
}

/**
 * get_thread_markdown's refusal: the thread holds an open `until_vote`
 * poll the connector's user has not voted in (or the connector could not
 * check every poll), and Loomio's export would print its votes. Thrown
 * BEFORE the `/markdown` request, so no such document is ever fetched.
 * Not a LoomioApiError: Loomio answered fine; the connector declines.
 */
export class VisibilityRefusalError extends Error {
  constructor(
    message: string,
    /** The polls the refusal names; empty when the check itself could not finish. */
    public readonly polls: readonly RefusedPoll[] = [],
  ) {
    super(message);
    this.name = "VisibilityRefusalError";
  }

  /** Refused for `polls`: open, results hidden until the user votes, user has not voted. */
  static untilVote(topicId: number, polls: readonly RefusedPoll[]): VisibilityRefusalError {
    const named = polls
      .map((p) => {
        const key = p.key ? ` (key ${p.key})` : "";
        const title = p.title ? ` "${p.title}"` : "";
        return `poll ${p.id}${key}${title}`;
      })
      .join("; ");
    return new VisibilityRefusalError(
      `get_thread_markdown refused for topic_id ${topicId}: the thread holds an open poll that hides ` +
        `its results until the connector's user votes, and that user has not voted — ${named}. ` +
        "From Loomio 3.10 on, the Markdown export ignores 'hide results until vote' and would print " +
        "every vote and the results table (the check is skipped only when a recent health probe " +
        "reports Loomio 3.8 / 3.9, whose export still applies the rule). list_thread_items (same " +
        "topic_id) and get_poll apply the rule: read the thread there. The block lifts when the " +
        "poll closes or the connector's user votes.",
      polls,
    );
  }

  /** Refused because the guard's scan stopped at its page cap before reading every item. */
  static unverified(
    topicId: number,
    scanned: number,
    total: number | null,
  ): VisibilityRefusalError {
    const of = total !== null ? ` of ${total}` : "";
    return new VisibilityRefusalError(
      `get_thread_markdown refused for topic_id ${topicId}: could not verify that the thread holds no ` +
        "open poll hiding its results until the connector's user votes — it is too long to check " +
        `(${scanned}${of} items read). From Loomio 3.10 on, the Markdown export ignores 'hide ` +
        "results until vote', so an unchecked thread is not exported. Read it with list_thread_items " +
        "(same topic_id), which applies the rule to every poll.",
    );
  }
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
