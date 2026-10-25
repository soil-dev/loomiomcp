import { z } from "zod";
import { csvParam, loomioGet, readParams } from "../loomio/client.js";
import { discussionUrl, highlightToMarkdown, indexById, pollUrl } from "../loomio/shape.js";
import type { LoomioPoll, LoomioSearchResult, SearchResponse } from "../loomio/types.js";
import {
  type HiddenReason,
  ownStanceFor,
  pollResultsVisible,
  type ResultsVisibility,
} from "../loomio/visibility.js";
import { assertGroupAllowed, hasGroupAllowlist, isGroupAllowed } from "../loomio/group-scope.js";
import { positiveId, TEXT_MAX } from "./_common.js";

// ── GET /b2/search (Loomio 3.8.1) ───────────────────────────────────────────
//
// Api::B2::SearchController is Api::V1::SearchController with API-key
// authentication and a wider group scope: v1 searched the user's
// member groups, b2 searches `GroupQuery.visible_to(user, show_public:
// true)` — member groups AND publicly visible groups — and the shared
// correlated `TopicQuery.visible_to` then removes every private topic
// the user may not read (test "searches public content without group
// membership and excludes private content"). Instance `is_admin` widens
// nothing ("instance admin status does not expose private search
// results"). Visibility is a FILTER: nothing here ever 403s for it.
//
// Parameters the controller reads:
//   query      full-text over PgSearch documents (Discussion, Comment,
//              Poll, Stance, Outcome bodies + titles). Exact matches
//              first (`PgSearch.multisearch`, prefix matching, `!term`
//              negation), then — when the query has no `! " ( )` and at
//              most 8 terms — trigram "did you mean" alternatives fill
//              the remaining slots from the instance's `pg_search_words`
//              vocabulary (SearchQuery#fuzzy_results; typo tolerance is
//              only as good as that table's last rebuild).
//   author_id  restrict to one author. WITHOUT `query` the controller
//              skips full-text entirely and returns that author's newest
//              visible items (`order(authored_at: :desc)`), still capped.
//   group_id   one group (intersected with the visible set; an invisible
//              id yields nothing, not an error). org_id (a group and its
//              subgroups) exists too; the tool exposes group_id.
//   type / types   one `SEARCHABLE_TYPES` value, or a comma-separated
//              list (`types=Poll,Outcome`; unknown names are dropped).
//   tag        Loomio ≥ 3.13.0 (5934ab182) matches
//              `pg_search_documents.tags @> [tag]` (v1
//              search_controller.rb:21-23): only CONTRIBUTIONS explicitly
//              tagged with that name — the opening post, a comment, a
//              poll, an outcome. It no longer selects every item of a
//              tagged thread, and a vote (Stance) never carries tags.
//              Before 3.13 it selected whole threads: every document in
//              a topic of the user's groups whose tags contain it. Same
//              parameter, different answer — a silent behaviour change
//              the scope note states when `tag` is used.
//   order      `authored_at_desc` / `authored_at_asc` reorder the exact
//              AND the fuzzy matches by date (SearchQuery#sort_by_
//              authored_at, so a recent fuzzy match can outrank an older
//              exact one); anything else = relevance (exact first).
//
// Hard limits: `SearchQuery::RESULT_LIMIT = 20`, no offset, and
// `meta.total` is never set (test "omits an undefined total"). The
// controller overrides `exclude_types` with its own fixed list, so a
// caller's `exclude_types` is ignored — but `compact=1` still applies
// through Api::B2::ResponseOptions and is sent. What arrives: the
// `search_results` root (SearchResultSerializer — denormalised rows with
// the group's FULL name ("Parent - Subgroup": the controller fills
// `group_name` from `group.full_name`), handle and key, the author's
// name, the discussion's or poll's key/title, a `sequence_id` for items
// inside a thread, and `highlight`) plus `users` (authors) and `polls`
// (+ `poll_options`, + the API user's `my_stance` under `stances`) for
// results that are or belong to polls. The rows' `tags` attribute is
// gated by `include_type?('tag')` and `compact` excludes `tag`, so it
// never arrives; list_threads / get_discussion carry a thread's tags.
//
// VOTE REASONS. Loomio indexes every cast, unredacted stance (reason +
// voter name — app/models/stance.rb `pg_search_insert_statement`)
// EXCEPT those of an open `until_closed` poll, which are indexed only
// once the poll closes (`ReindexPollWorker`). Open `until_vote` polls
// ARE indexed (re-checked at 3.13.1: stance.rb:47-50 excludes only
// `hide_results = 2`, until_closed, while open), so `search_content({types: ['Stance']})` would hand a
// caller whose user has not voted exactly the reasons the poll's author
// said nobody sees before voting — the same content list_thread_items
// strips (src/loomio/visibility.ts). Loomio's own web search shows a
// logged-in member the same hits, so this widens nothing beyond the web
// UI; but the connector promises one visibility rule everywhere, and the
// response already carries what is needed to apply it for free: the
// `polls` root (hide_results, closed_at) for every poll-related row
// (`SearchResultSerializer has_one :poll`) and `my_stance` when the
// user voted. So a Stance hit whose poll's results are hidden for this
// user keeps its author (Loomio's thread view names the voter and hides
// the choice) but loses its snippet, and says why. The polls root is
// not relayed otherwise — get_poll gates full results properly.
//
// A withheld snippet is not enough when a `query` is present: the hit's
// EXISTENCE then says that the query term occurs in that voter's
// reason (or name). With `types: ['Stance']`, `author_id` and prefix
// matching (`!` negation, and a `"` or `!` in the query switches the
// fuzzy step off, making every hit an exact prefix confirmation) that is
// a word-by-word oracle over exactly the text list_thread_items strips.
// Loomio's own web search has the same property — it shows the member
// the full reason — so nothing is widened; but SECURITY.md promises that
// no tool reads what another withholds, so in query mode such hits are
// DROPPED from the results — silently. v0.0.16 counted them in
// `scope.hidden_stance_hits_dropped` and computed `capped` BEFORE the
// drop, and either number answered the same yes/no per prefix (security
// review F-03: the reason prefix "reserve" was recovered in 74 calls
// without ever seeing a snippet). So there is no count, and `capped`
// is computed from what is RETURNED. One more step closes the single-drop
// case at Loomio's 20-result cap (review round 1): when a drop is
// possible (query mode, or a group allow-list) the reply holds at most
// 19 rows and `capped` means "19 rows returned". Otherwise 20 visible
// matches gave 20 rows and capped:true while 19 visible + 1 withheld gave
// 19 rows and capped:false — a caller who knew of 20 visible matches
// learned that a withheld item matched. Now both read 19 / true, and a
// result made only of withheld hits still reads like an empty one. The
// residual: TWO or more withheld hits in Loomio's first 20 shorten the
// page visibly to a caller who knows of 20+ visible matches (SECURITY.md
// "Accepted risks"). The price: one row less on a capped query, and
// `capped` reads true for exactly 19 matches, false when Loomio had more
// behind 2+ dropped hits; the scope note says so.
// Author-only mode has no probe term: there the hit stays, snippet
// withheld, so "what did X vote on recently" still lists the vote.
//
// Group allow-list (LOOMIO_MCP_GROUP_IDS, src/loomio/group-scope.ts):
// a `group_id` outside it is refused before the request; without one,
// hits in unlisted groups (and hits with no group) are dropped the same
// silent way — Loomio's search takes one group or none, so the filter
// can only be client-side, and a count would be an oracle over the
// unlisted groups' content.

export const SEARCHABLE_TYPES = ["Discussion", "Comment", "Poll", "Stance", "Outcome"] as const;
export type SearchableType = (typeof SEARCHABLE_TYPES)[number];

/** Loomio's `SearchQuery::RESULT_LIMIT`. */
export const SEARCH_RESULT_CAP = 20;
/** Cap on each snippet, in characters. */
export const SNIPPET_MAX_CHARS = 400;

const SEARCH_ORDERS = ["authored_at_desc", "authored_at_asc", "relevance"] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];
export const DEFAULT_SEARCH_ORDER: SearchOrder = "authored_at_desc";

export const searchContentSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(TEXT_MAX.query)
      .optional()
      .describe("Full-text query (prefix match; `!word` excludes)."),
    author_id: positiveId
      .optional()
      .describe("Restrict to one author; alone = their 20 newest items."),
    group_id: positiveId.optional().describe("Restrict to one group (not its subgroups)."),
    types: z
      .array(z.enum(SEARCHABLE_TYPES))
      .min(1)
      .optional()
      .describe("Record types to include; default all (e.g. ['Outcome'])."),
    tag: z
      .string()
      .min(1)
      .max(TEXT_MAX.tag)
      .optional()
      .describe(
        "Only items tagged with this exact name (Loomio < 3.13: every item of a tagged thread).",
      ),
    order: z
      .enum(SEARCH_ORDERS)
      .optional()
      .describe("authored_at_desc (default), authored_at_asc, relevance."),
  })
  .superRefine((input, ctx) => {
    if (input.query === undefined && input.author_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["query"],
        message: "Pass `query`, `author_id`, or both.",
      });
    }
  });

export type SearchContentInput = z.infer<typeof searchContentSchema>;

export interface SearchHit {
  type: SearchableType | string;
  /** The Loomio record id of the hit (`searchable_id`) — a discussion, comment, poll, stance or outcome id. */
  id: number;
  /** The thread's title (discussion title, or poll title for a standalone poll and its votes / outcomes). */
  title: string | null;
  /** Markdown snippet: `**match**` around query terms; a plain excerpt in author mode. `null` when hidden (see `snippet_hidden_reason`). */
  snippet: string | null;
  /** Set on a Stance hit whose poll hides results from the connector's user: the reason was withheld. */
  snippet_hidden_reason?: HiddenReason;
  /** `full_name` is Loomio's "Parent - Subgroup" form (what the search controller emits), not the short `name` list_groups shows. */
  group: { id: number; full_name: string | null; handle: string | null } | null;
  author: { id: number; name: string | null } | null;
  authored_at: string | null;
  discussion_key: string | null;
  poll_key: string | null;
  poll_id: number | null;
  /**
   * The hit's position in its thread (list_thread_items' `sequence_id`;
   * Loomio 3.13.1 search_controller.rb:93-110): 0 on a Discussion hit;
   * the item's own sequence on a comment or outcome (also in a
   * standalone poll's thread, where the hit has a `poll_key` and no
   * `discussion_key`) and on a poll or vote inside a discussion; null
   * on a standalone poll's own hit and on a vote in a standalone poll's
   * thread. WHY the vote gap: the first lookup is `TopicItem.tags_visible`,
   * built on `taggable` — the new_discussion / poll_created /
   * outcome_created / new_comment kinds only (has_item_tags.rb:4-24), so
   * never a `stance_created` item — and the stance lookup runs only
   * `elsif discussion`, which is nil for a standalone poll's vote
   * (stance.rb:34 indexes `discussion_id` NULL there).
   */
  sequence_id: number | null;
  url?: string;
}

export interface SearchContentResult {
  results: SearchHit[];
  returned: number;
  /**
   * True when 20 hits are RETURNED (Loomio's cap): there are probably
   * more — narrow the search. Computed after the connector's own
   * filters, so it can also read false when Loomio had more matches.
   */
  capped: boolean;
  mode: "query" | "author" | "query+author";
  scope: {
    query: string | null;
    author_id: number | null;
    group_id: number | null;
    types: SearchableType[] | null;
    tag: string | null;
    /** The order Loomio applied: the requested one for `query` searches, always newest-first for author-only. */
    order: SearchOrder;
    note: string;
  };
}

const SEARCH_SCOPE_NOTE =
  "Loomio returns at most 20 results and has no paging or total; a query search shows at most 19. " +
  "`capped: true` means the match set may be larger than shown — add types/group_id/author_id or a " +
  "sharper query. Scope is everything the " +
  "connector's user can see (member groups plus public threads of public groups); private content in " +
  "other groups is silently absent. Query terms match as prefixes, `!term` excludes; close-spelling " +
  "matches depend on the instance's search vocabulary. `id` is the record id of the hit; open it with " +
  "get_discussion / get_poll, or the thread with list_thread_items(topic_id) via the discussion. A " +
  "vote whose poll hides results from the connector's user (hide_results until_vote and it has not " +
  "voted; until_closed and still open) is silently absent from a query search, uncounted, so " +
  "`capped` may read false although Loomio had more; in author-only mode it is listed with " +
  "`snippet: null` and `snippet_hidden_reason`. `group.full_name` is Loomio's 'Parent - Subgroup' " +
  "form; join on `group.id`, not on the name.";

/** Appended when the operator's group allow-list (LOOMIO_MCP_GROUP_IDS) filtered the hits. */
const SEARCH_ALLOWLIST_NOTE =
  " This deployment serves only its listed groups: hits elsewhere are silently absent, uncounted.";

/** Appended when `tag` was given: Loomio 3.13 changed what it matches (see the module note). */
const SEARCH_TAG_NOTE =
  " tag: on Loomio 3.13+ only contributions explicitly tagged with that name match (votes never do); " +
  "older Loomio matched every item of a thread carrying the tag.";

/**
 * Where the hit lives on the web: an item inside a discussion opens the
 * thread scrolled to it (`?comment_id=` for a comment, which Loomio's
 * thread page resolves; `?sequence_id=` for a vote or outcome), a
 * discussion opens itself, a standalone poll (or its comments, votes,
 * outcomes) opens the poll page. `undefined` when the row names no key.
 */
export function searchHitUrl(row: LoomioSearchResult): string | undefined {
  if (row.discussion_key) {
    if (row.searchable_type === "Comment" && row.searchable_id != null) {
      return discussionUrl(row.discussion_key, { comment_id: row.searchable_id });
    }
    if (row.searchable_type !== "Discussion" && row.sequence_id != null) {
      return discussionUrl(row.discussion_key, { sequence_id: row.sequence_id });
    }
    return discussionUrl(row.discussion_key, { title: row.discussion_title });
  }
  if (row.poll_key) return pollUrl(row.poll_key, { title: row.poll_title });
  return undefined;
}

/**
 * One SearchResultSerializer row as the tool presents it. Pure.
 * `stanceVisibility` is the results-visibility verdict for the row's
 * poll (see `shapeSearchHits`); a Stance hit whose verdict is "hidden"
 * loses its snippet — the vote reason — and says why.
 */
export function shapeSearchHit(
  row: LoomioSearchResult,
  stanceVisibility?: ResultsVisibility,
): SearchHit {
  const hidden = row.searchable_type === "Stance" && stanceVisibility?.visible === false;
  const hit: SearchHit = {
    type: row.searchable_type ?? "unknown",
    id: row.searchable_id ?? row.id,
    title: row.discussion_title ?? row.poll_title ?? null,
    snippet: hidden ? null : highlightToMarkdown(row.highlight, SNIPPET_MAX_CHARS),
    ...(hidden && stanceVisibility?.reason
      ? { snippet_hidden_reason: stanceVisibility.reason }
      : {}),
    group:
      row.group_id != null
        ? { id: row.group_id, full_name: row.group_name ?? null, handle: row.group_handle ?? null }
        : null,
    author: row.author_id != null ? { id: row.author_id, name: row.author_name ?? null } : null,
    authored_at: row.authored_at ?? null,
    discussion_key: row.discussion_key ?? null,
    poll_key: row.poll_key ?? null,
    poll_id: row.poll_id ?? null,
    sequence_id: row.sequence_id ?? null,
  };
  const url = searchHitUrl(row);
  return url ? { ...hit, url } : hit;
}

/**
 * Loomio's `results_visible?(voted:)` for the poll a Stance row belongs
 * to, from the response's own `polls` root (hide_results, closed_at) and
 * the API user's `my_stance` in `stances` (on this endpoint that root
 * holds only the user's own rows, as on a poll show). A row whose poll
 * is absent from the root cannot be judged and is treated as hidden
 * (`until_vote`) — erring towards withholding, as the thread tools do.
 */
export function stanceVisibilityFor(
  row: LoomioSearchResult,
  polls: Map<number, LoomioPoll>,
  body: SearchResponse,
): ResultsVisibility | undefined {
  if (row.searchable_type !== "Stance") return undefined;
  const poll = row.poll_id != null ? polls.get(row.poll_id) : undefined;
  if (!poll) return { visible: false, reason: "until_vote" };
  return pollResultsVisible(poll, ownStanceFor(poll.id, body.stances, { showRoot: true }));
}

/** Every row of a search response as hits, with the stance gate applied. Pure. */
export function shapeSearchHits(body: SearchResponse): SearchHit[] {
  const rows = Array.isArray(body.search_results) ? body.search_results : [];
  const polls = indexById(body.polls);
  return rows.map((row) => shapeSearchHit(row, stanceVisibilityFor(row, polls, body)));
}

export async function searchContent(input: SearchContentInput): Promise<SearchContentResult> {
  // F-17: an unlisted group is refused before the request.
  if (input.group_id !== undefined) assertGroupAllowed(input.group_id);
  const hasQuery = input.query !== undefined;
  const order: SearchOrder = hasQuery ? (input.order ?? DEFAULT_SEARCH_ORDER) : "authored_at_desc";
  const body = await loomioGet<SearchResponse>("/b2/search", {
    ...(hasQuery ? { query: input.query } : {}),
    ...(input.author_id !== undefined ? { author_id: input.author_id } : {}),
    ...(input.group_id !== undefined ? { group_id: input.group_id } : {}),
    ...(input.types ? { types: csvParam(input.types) } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    // `relevance` is Loomio's behaviour when `order` is absent; the two
    // date orders are sent verbatim. Author-only searches ignore it.
    ...(hasQuery && order !== "relevance" ? { order } : {}),
    ...readParams("compact"),
  });
  const hits = shapeSearchHits(body);
  // Query mode: a hidden Stance hit's existence is itself the leak (see
  // the module note), so the row goes, not just its snippet — and
  // nothing in the reply may count it. Author mode keeps it with the
  // snippet withheld. Hits outside the group allow-list go the same
  // silent way (F-17); `isGroupAllowed` passes everything without one.
  const kept = hits.filter(
    (h) =>
      (!hasQuery || h.snippet_hidden_reason === undefined) && isGroupAllowed(h.group?.id ?? null),
  );
  // Where a drop is possible, one slot of Loomio's 20 is held back so a
  // single dropped hit cannot be told from a 20th visible one (module
  // note). Decided from the INPUT and the deployment, never the data.
  const cap = hasQuery || hasGroupAllowlist() ? SEARCH_RESULT_CAP - 1 : SEARCH_RESULT_CAP;
  const results = kept.slice(0, cap);
  return {
    results,
    returned: results.length,
    // From what is returned, never from what Loomio sent (module note).
    capped: results.length >= cap,
    mode: hasQuery ? (input.author_id !== undefined ? "query+author" : "query") : "author",
    scope: {
      query: input.query ?? null,
      author_id: input.author_id ?? null,
      group_id: input.group_id ?? null,
      types: input.types ?? null,
      tag: input.tag ?? null,
      order,
      note:
        SEARCH_SCOPE_NOTE +
        (input.tag !== undefined ? SEARCH_TAG_NOTE : "") +
        (hasGroupAllowlist() ? SEARCH_ALLOWLIST_NOTE : ""),
    },
  };
}
