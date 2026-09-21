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
import { positiveId } from "./_common.js";

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
//   tag        a topic tag; Loomio intersects with `group_ids`.
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
// ARE indexed, so `search_content({types: ['Stance']})` would hand a
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
// DROPPED from the results and counted in `scope.hidden_stance_hits_dropped`.
// Author-only mode has no probe term: there the hit stays, snippet
// withheld, so "what did X vote on recently" still lists the vote.

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
    tag: z.string().min(1).optional().describe("Only threads carrying this tag (exact name)."),
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
  /** Position of the item in its thread, when the hit is an item inside a discussion. */
  sequence_id: number | null;
  url?: string;
}

export interface SearchContentResult {
  results: SearchHit[];
  returned: number;
  /** True when Loomio's 20-result cap was reached: there may be more matches than shown — narrow the search. */
  capped: boolean;
  mode: "query" | "author" | "query+author";
  scope: {
    /** `query` mode only: Stance hits removed because their poll hides results from the connector's user (see the note). */
    hidden_stance_hits_dropped: number;
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
  "Loomio returns at most 20 results and has no paging or total: `capped: true` means the match set " +
  "is larger than shown — add types/group_id/author_id or a sharper query. Scope is everything the " +
  "connector's user can see (member groups plus public threads of public groups); private content in " +
  "other groups is silently absent. Query terms match as prefixes, `!term` excludes; close-spelling " +
  "matches depend on the instance's search vocabulary. `id` is the record id of the hit; open it with " +
  "get_discussion / get_poll, or the thread with list_thread_items(topic_id) via the discussion. A " +
  "Stance hit on a poll whose results are hidden from the connector's user (hide_results until_vote " +
  "and it has not voted; until_closed and still open) is DROPPED from a query search — its presence " +
  "alone would confirm the term occurs in the withheld reason — and counted in " +
  "hidden_stance_hits_dropped; in author-only mode it stays with `snippet: null` and " +
  "`snippet_hidden_reason`. Never use search to probe hidden vote reasons. `group." +
  "full_name` is Loomio's 'Parent - Subgroup' form; join on `group.id`, not on the name.";

/**
 * Where the hit lives on the web: an item inside a discussion opens the
 * thread scrolled to it (`?sequence_id=`, or `?comment_id=` for a
 * comment — the controller gives comments no sequence_id), a discussion
 * opens itself, a standalone poll (or its votes / outcomes) opens the
 * poll page. `undefined` when the row names no key.
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
  // the module note), so the row goes, not just its snippet. Author mode
  // keeps it with the snippet withheld.
  const results = hasQuery ? hits.filter((h) => h.snippet_hidden_reason === undefined) : hits;
  return {
    results,
    returned: results.length,
    capped: hits.length >= SEARCH_RESULT_CAP,
    mode: hasQuery ? (input.author_id !== undefined ? "query+author" : "query") : "author",
    scope: {
      hidden_stance_hits_dropped: hits.length - results.length,
      query: input.query ?? null,
      author_id: input.author_id ?? null,
      group_id: input.group_id ?? null,
      types: input.types ?? null,
      tag: input.tag ?? null,
      order,
      note: SEARCH_SCOPE_NOTE,
    },
  };
}
