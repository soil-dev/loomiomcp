/**
 * The poll field vocabulary, and the translation between Loomio's two
 * generations of it.
 *
 * Loomio 3.14.0 (af2dfa22a, 44bb45208, 81fbad246) renamed the poll
 * participation and scoring fields — in the database, in PollSerializer,
 * in `PermittedParams#poll_attributes` and in the CSV exports — and the
 * `notify_on_closing_soon` / audience value `undecided_voters` became
 * `voters_uncast`. The new names are what `/api/user0` speaks. The
 * compatibility path `/api/b2` keeps the OLD names in both directions
 * (`Api::User0::LegacyB2Fields`: a before_action renames the five
 * settings a client may send, an after_action renames the response's
 * `polls[]` rows and their `results[]`), and Loomio before 3.14 knows
 * only the old names. The mapping below is Loomio's own
 * (deploy/UPGRADING.md "User and Server API paths").
 *
 * This connector speaks the CURRENT names everywhere a caller sees them
 * — tool inputs, tool outputs, documentation — whichever Loomio it
 * talks to:
 *
 *   - Every response body answered on `/b2` passes through
 *     `modernizePollsIn` in the HTTP client: a `polls[]` row that carries
 *     an old name is rewritten to the current one. (A `/user0` answer
 *     never carries one, so the client skips the walk there.)
 *   - A poll write on the legacy dialect sends `legacyPollParams(attrs)`,
 *     the old names for the settings `PermittedParams` lists — Loomio
 *     < 3.14 answers 400 to the new ones (`:raise` mode). On 3.14+ the
 *     `/b2` filter would accept either, but the connector only uses
 *     `/b2` there before the version is known.
 *
 * Nothing here depends on the network or on the health cache; the
 * dialect is an argument. Every function returns its input object
 * unchanged when nothing applies and a single shallow copy otherwise —
 * never a mutation of what Loomio sent (a fixture or a cached body).
 */

import type { LoomioPoll } from "./types.js";

/** PollSerializer attributes: pre-3.14 name → current name (Loomio's table, `LegacyB2Fields::POLL_FIELDS` inverted). */
export const POLL_FIELD_RENAMES = {
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
} as const;

/** Keys of one `results[]` row: pre-3.14 name → current name (`LegacyB2Fields::RESULT_FIELDS` inverted). */
export const POLL_RESULT_FIELD_RENAMES = {
  voter_count: "vote_count",
  voter_scores: "scores_by_voter",
} as const;

/**
 * The renamed settings a client may SEND (`PermittedParams#poll_attributes`
 * on 3.14+; `LegacyB2Fields::POLL_PARAMS` is exactly this set). Current
 * name → pre-3.14 name. The participation counters are read-only and
 * never travel in a request.
 */
export const POLL_PARAM_LEGACY_NAMES = {
  score_min: "min_score",
  score_max: "max_score",
  choice_count_min: "minimum_stance_choices",
  choice_count_max: "maximum_stance_choices",
  points_per_voter: "dots_per_person",
} as const;

/** `Poll.notify_on_closing_soon` (poll.rb enum): the one value that changed. */
export const CLOSING_SOON_LEGACY_VALUE = "undecided_voters";
export const CLOSING_SOON_CURRENT_VALUE = "voters_uncast";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rename `renames`' keys on `row`, copying it once on the first change
 * and mutating that private copy afterwards. A row carrying both
 * spellings (never seen on the wire) keeps the current one: it is what a
 * 3.14+ serializer produced.
 */
function renameKeys(row: Row, renames: Record<string, string>): Row {
  let out: Row | undefined;
  for (const [legacy, current] of Object.entries(renames)) {
    if (!(legacy in row)) continue;
    out ??= { ...row };
    if (!(current in out)) out[current] = out[legacy];
    delete out[legacy];
  }
  return out ?? row;
}

/**
 * One poll row in the current vocabulary. Returns the SAME object when
 * nothing needed renaming (the common case), a single shallow copy
 * otherwise.
 */
export function modernizePoll<T extends LoomioPoll>(poll: T): T {
  const row = poll as Row;
  let out = renameKeys(row, POLL_FIELD_RENAMES);
  // From here on `out` is either `row` itself (untouched so far) or the
  // one private copy; `own()` makes sure a further change lands in a copy.
  const own = (): Row => (out === row ? (out = { ...row }) : out);
  const results = out["results"];
  if (Array.isArray(results)) {
    let changed = false;
    const renamed = results.map((r) => {
      if (!isRow(r)) return r;
      const next = renameKeys(r, POLL_RESULT_FIELD_RENAMES);
      if (next !== r) changed = true;
      return next;
    });
    if (changed) own()["results"] = renamed;
  }
  if (out["notify_on_closing_soon"] === CLOSING_SOON_LEGACY_VALUE) {
    own()["notify_on_closing_soon"] = CLOSING_SOON_CURRENT_VALUE;
  }
  return out as T;
}

/**
 * A response body with its `polls[]` root in the current vocabulary.
 * Applied by the HTTP client to every body answered on the `/b2`
 * compatibility path. Bodies without a `polls` array — most of them —
 * are returned as is.
 */
export function modernizePollsIn<T>(body: T): T {
  if (!isRow(body)) return body;
  const polls = body["polls"];
  if (!Array.isArray(polls)) return body;
  let changed = false;
  const rows = polls.map((p) => {
    if (!isRow(p)) return p;
    const next = modernizePoll(p as LoomioPoll);
    if (next !== p) changed = true;
    return next;
  });
  return changed ? ({ ...body, polls: rows } as T) : body;
}

/**
 * Poll write attributes for the legacy dialect: the renamed settings
 * under their pre-3.14 names and `notify_on_closing_soon:
 * 'voters_uncast'` as `'undecided_voters'`. Everything else is passed
 * through. Returns the same object when nothing applies.
 */
export function legacyPollParams<T extends Row>(attrs: T): T {
  let out: Row | undefined;
  for (const [current, legacy] of Object.entries(POLL_PARAM_LEGACY_NAMES)) {
    if (!(current in attrs) || attrs[current] === undefined) continue;
    out ??= { ...attrs };
    out[legacy] = out[current];
    delete out[current];
  }
  if (attrs["notify_on_closing_soon"] === CLOSING_SOON_CURRENT_VALUE) {
    out ??= { ...attrs };
    out["notify_on_closing_soon"] = CLOSING_SOON_LEGACY_VALUE;
  }
  return (out ?? attrs) as T;
}
