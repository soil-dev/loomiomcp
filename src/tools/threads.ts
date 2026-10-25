import { z } from "zod";
import {
  B2_PAGE_MAX,
  LoomioApiError,
  loomioGet,
  loomioGetAllPages,
  loomioPager,
  type PagerState,
  readParams,
} from "../loomio/client.js";
import {
  cachedHealthAgeMs,
  cachedOwnUserId,
  checkLoomioHealth,
  getCachedHealth,
  HEALTH_CACHE_TTL_MS,
} from "../loomio/health.js";
import {
  assertGroupAllowed,
  assertRecordGroupAllowed,
  hasGroupAllowlist,
  isGroupAllowed,
} from "../loomio/group-scope.js";
import {
  indexById,
  pick,
  type SlimUser,
  slimUsers,
  stripBodyHtml,
  threadUrl,
  truncateBody,
  truncateField,
  truncateText,
} from "../loomio/shape.js";
import type {
  DiscussionsResponse,
  LoomioComment,
  LoomioOutcome,
  LoomioPoll,
  LoomioPollOption,
  LoomioSideLoads,
  LoomioStance,
  LoomioTopic,
  LoomioTopicItem,
  LoomioUser,
  PollsResponse,
  ThreadItemsResponse,
  ThreadsResponse,
} from "../loomio/types.js";
import {
  type GatedPoll,
  hiddenUntilVote,
  ownStanceFor,
  pollResultsVisible,
  type ResultsVisibility,
  stripHiddenResults,
  stripHiddenStanceResults,
  VisibilityRefusalError,
} from "../loomio/visibility.js";
import {
  encodePathSegment,
  idOrKey,
  isoTimestamp,
  maxCharsSchema,
  maybeCollapseNotVisible,
  positiveId,
  TEXT_MAX,
} from "./_common.js";

// ── Loomio 3.8's thread routes ──────────────────────────────────────────────
//
// Loomio 3.4 replaced the Event model (and the v1 `events` endpoint the
// 0.0.11 `list_events` read) with TopicItem, and 3.1+ exposes threads to
// API keys under `/b2/threads` (Api::B2::ThreadsController, 3.8.1):
//
//   GET /b2/threads                  TopicQuery.visible_to(user), ordered
//                                    last_activity_at desc, `limit` (default
//                                    50) / `offset`, `meta.total` = every
//                                    visible thread. No group filter — the
//                                    controller reads none — so `group_id`
//                                    below is applied to the fetched page.
//   GET /b2/threads/{topic_id}       one TopicSerializer row (`threads` root).
//   GET /b2/threads/{topic_id}/items the thread's items ordered by
//                                    `sequence_id, id`. Loomio ≥ 3.11.1
//                                    (bc1a6cc02) pages them with
//                                    `page_collection_bounded`: `limit`
//                                    default 50, clamped to 1..500,
//                                    `offset`; `meta.total` = the whole
//                                    thread on every page. The connector
//                                    requests the caller's window (at most
//                                    two pages of 500); `kinds`, a filter
//                                    Loomio does not have, reads the thread
//                                    page by page from the start. Older
//                                    Loomio returns every item whatever
//                                    was asked, and that reply is sliced
//                                    here (src/loomio/client.ts
//                                    `loomioPager`).
//   GET /b2/threads/{topic_id}/markdown  {markdown} from
//                                    ThreadMarkdownService behind
//                                    `authorize!(:export, thread)` (= can
//                                    show, ability/topic.rb:9-11). The
//                                    ≥ 3.10 document: front matter (key,
//                                    url, group, created, last_activity,
//                                    tags, 3.13+ root_tags), a `# <Type>:
//                                    <title> · <author> · <UTC time>`
//                                    title, the opening body, then the
//                                    activity as a reply tree of nested
//                                    blockquotes — polls as `##` sections
//                                    with their votes and replies, each
//                                    item headed `**Author** · <time> ·
//                                    #<seq>`, reactions inline, `Tags:`
//                                    lines, removed items as `_Removed_`
//                                    placeholders. Since 3.10 (df28cf845)
//                                    it decides poll visibility with
//                                    `results_available?` alone
//                                    (thread_markdown_service.rb:213-215):
//                                    an open `until_vote` poll's votes and
//                                    results table are printed for a
//                                    reader who has not voted. The
//                                    connector refuses that case (see
//                                    "get_thread_markdown" below); every
//                                    other document passes through.
//
// The `{topic_id}` is the THREAD id (`discussion.topic_id` /
// `poll.topic_id`), not the discussion's or poll's own id. It is
// resolved through `TopicQuery.visible_to(user).find`, so an unknown id
// and a thread the user cannot see both answer 404 (Loomio's own test
// "does not expose an inaccessible thread") — never 403 for visibility.
//
// Side-loads. TopicItemSerializer emits each item's `itemable` into the
// root for its type (`discussions`, `polls`, `comments`, `stances`,
// `outcomes`) and its actor into `users`; PollSerializer adds
// `poll_options`, the poll's `current_outcome` and the API user's
// `my_stance` (into the same `stances` root every voter's stance lands
// in). `compact=1` drops the `topics`, `groups`, `memberships`,
// `reactions`, `tags` and `translations` roots and the parent copies
// under `parent_topic_items` — none of which the items read needs (the
// counters live on the topic the caller already has, and `parent_id`
// describes the tree; the few `reply_parent` rows Loomio ≥ 3.11 still
// puts there are ignored, see `EXCLUDE_TYPES.items_with_reactions`).
// Each PAGE side-loads only what its own items reference, so the pages
// of one call are merged before anything is looked up. Two variations on
// it (src/loomio/client.ts `EXCLUDE_TYPES`): when the thread's own
// record is already in hand — a `discussion_id` was just resolved, or
// get_discussion passed its record through — `items_known_thread` also
// excludes `discussion`, so the opening post (full HTML body) is not
// serialised a second time under `discussions`; and `include_reactions`
// swaps `compact` for the equivalent explicit list minus `reaction`
// (keeping `discussion`, because the opening post's reactions arrive
// only through DiscussionSerializer). The bare `topic_id` path keeps
// plain `compact`: it needs the `discussions` / `polls` root to learn
// what the thread is (`completeHeader`).
//
// The `threads` index (list_threads) sends `compact` minus `tag`
// instead: the rows ARE TopicSerializer rows and their `tags` FIELD is
// gated by `include_tags?` = `include_type?('tag')`, so compact would
// strip it from every row.
//
// Kinds. `TopicItem#kind` is the item subclass name underscored
// (app/models/topic_items/*.rb) or set by the creating service: the
// 3.8.1 catalogue is `THREAD_ITEM_KINDS`. `stance_updated` is written by
// StanceService for a changed vote (no subclass, same shape).
//
// Poll results inside a thread go through src/loomio/visibility.ts:
// Loomio's serializers emit `results` / `stance_counts` / voters'
// `option_scores` whenever `results_available?` (the `until_closed`
// gate) and leave `until_vote` to the client — which for an API user
// that never votes would mean every voter's choice on a poll whose
// author said "vote first". The connector applies Loomio's full rule
// (`results_visible?(voted:)`), recognising the user's own stance via
// the id the health probe learned (`cachedOwnUserId`); with no cached
// identity it assumes "not voted", which hides more, never less.

/** `TopicItem#kind` values Loomio 3.8.1 writes (app/models/topic_items/*.rb + StanceService). */
export const THREAD_ITEM_KINDS = [
  "new_discussion",
  "new_comment",
  "poll_created",
  "stance_created",
  "stance_updated",
  "outcome_created",
  "poll_closed_by_user",
  "poll_edited",
  "poll_reopened",
  "discussion_edited",
  "discussion_title_edited",
  "discussion_description_edited",
  "discussion_closed",
  "discussion_reopened",
  "discussion_moved",
] as const;

const KNOWN_KINDS: ReadonlySet<string> = new Set(THREAD_ITEM_KINDS);

/**
 * Default and ceiling for list_thread_items' window (`limit`). On
 * Loomio ≥ 3.11.1 the window is what the connector asks Loomio for, so
 * the ceiling is two pages of `B2_PAGE_MAX`: a call costs at most two
 * item requests without `kinds`, one per 500 items of the window.
 */
export const DEFAULT_ITEMS_LIMIT = 200;
export const MAX_ITEMS_LIMIT = 1000;
/**
 * Pages a WHOLE-thread read may spend: `kinds` filtering (a filter
 * Loomio does not have, so the thread is read from item 0) and
 * get_thread_markdown's vote-visibility scan. 10 × `B2_PAGE_MAX` = 5 000
 * items, far beyond any thread a person reads, and a hard bound on what
 * one tool call can cost Loomio (DEPLOY.md's rate-limit sizing counts
 * it). A walk the cap stops is flagged (`scope.scan_truncated`), never
 * returned as if complete.
 */
export const MAX_ITEM_SCAN_PAGES = 10;
/** Default cap on each comment / stance reason / outcome statement / poll details body. */
export const DEFAULT_BODY_MAX_CHARS = 4000;
/**
 * Default budget for ONE list_thread_items reply, in characters of the
 * shaped JSON (items plus the comments / polls / stances / outcomes they
 * reference; the header and `users` are not counted). `limit` and
 * `body_max_chars` bound each dimension but not their product: 200
 * comments at 4000 characters is ~900 KB in one reply, fifteen times the
 * sibling get_thread_markdown's whole-document cap. The slice stops
 * before the item that would overrun the budget and hands back
 * `next_offset`, so a long thread is read in pages of bounded size.
 */
export const DEFAULT_ITEMS_MAX_TOTAL_CHARS = 120_000;
/** Default cap on a thread's rendered Markdown. */
export const DEFAULT_MARKDOWN_MAX_CHARS = 60_000;
/** Default page size for `list_threads` (Loomio's own default is 50; 20 keeps a "what's new" scan cheap). */
export const DEFAULT_THREADS_LIMIT = 20;
export const MAX_THREADS_LIMIT = 100;

// ── Thread references ───────────────────────────────────────────────────────
//
// Every thread tool addresses a thread by exactly one of three ids. The
// `topic_id` is what Loomio's routes want and costs nothing to resolve;
// a `discussion_id` or `poll_id` costs one show of the record to read
// its `topic_id` (`resolveThread`). Callers that already hold a record
// (from list_discussions, list_threads, search_content) should pass its
// `topic_id` and skip that call; list_thread_items' field descriptions
// say so (`threadRefFields`). get_thread_markdown is the exception: its
// vote-visibility guard reads the thread once on EVERY reference
// (`loadThreadForGuard`), so there the three cost the same and its
// fields carry no cost hint (`markdownRefFields`) — a "+1 call" there
// would send a model on a wasted lookup for a `topic_id` it does not
// need.

const threadRefFields = {
  discussion_id: idOrKey
    .optional()
    .describe("Discussion id or short key (+1 call); prefer `topic_id`."),
  poll_id: idOrKey.optional().describe("Poll id or short key (+1 call)."),
  topic_id: positiveId
    .optional()
    .describe("Thread id (`topic_id` on any thread row, NOT `id`); no extra call."),
};

/** get_thread_markdown's references: the same three, every one costing the guard's single read. */
const markdownRefFields = {
  discussion_id: idOrKey.optional().describe("Discussion id or short key."),
  poll_id: idOrKey.optional().describe("Poll id or short key."),
  topic_id: positiveId.optional().describe("Thread id (`topic_id` on any thread row, NOT `id`)."),
};

export type ThreadRef = {
  discussion_id?: string | number;
  poll_id?: string | number;
  topic_id?: number;
};

function requireExactlyOneRef(input: ThreadRef, ctx: z.RefinementCtx): void {
  const given = [input.discussion_id, input.poll_id, input.topic_id].filter(
    (v) => v !== undefined,
  ).length;
  if (given !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["topic_id"],
      message: "Pass exactly one of discussion_id, poll_id or topic_id.",
    });
  }
}

export type ThreadType = "Discussion" | "Poll";

/** What is known about the thread after resolving the reference (and, later, from the items themselves). */
export interface ThreadHeader {
  topic_id: number;
  /** `null` until something in a response names it. */
  type: ThreadType | null;
  /** The discussion's or poll's own id (`topicable_id`). */
  id: number | null;
  key: string | null;
  title: string | null;
  group_id: number | null;
  url?: string;
}

function headerUrl(h: Omit<ThreadHeader, "url">): { url?: string } {
  const url = threadUrl(h.type, h.key, { title: h.title });
  return url ? { url } : {};
}

/**
 * A 404 from `GET /b2/discussions/{id}` or `GET /b2/polls/{id}`. Unlike
 * the `/b2/threads/*` routes (see `THREAD_NOT_VISIBLE`), these go
 * through `load_and_authorize`: ModelLocator finds the record first
 * (unknown id or key → 404) and only THEN checks `can?(:show)` (a record
 * the user may not see → 403 "Not authorized to show …", which the
 * client classifies). So a 404 here means exactly "no such id or key"
 * — most often a topic_id passed where a discussion or poll id belongs.
 */
function notFound(what: "discussion" | "poll", id: string | number): LoomioApiError {
  return new LoomioApiError(
    404,
    `Loomio has no ${what} with id or key "${id}" (HTTP 404 from GET /b2/${what}s/{id}). A ${what} that ` +
      `exists but is hidden from the connector's user answers 403 'Not authorized to show …' instead, ` +
      `so this identifier is wrong, not restricted — check that it is a ${what} id or key, not a ` +
      "topic_id (thread id): the two id sequences are independent.",
  );
}

/**
 * A failed `GET /b2/discussions/{id}` / `GET /b2/polls/{id}`, re-said:
 * in open-DCR mode a 404 and a "hidden" 403 become ONE message (nit 19,
 * `maybeCollapseNotVisible`); elsewhere a 404 gets the precise
 * `notFound` wording above and everything else passes through.
 */
function rethrowRecordNotFound(
  err: unknown,
  what: "discussion" | "poll",
  id: string | number,
): never {
  maybeCollapseNotVisible(err, what, id);
  if (err instanceof LoomioApiError && err.status === 404) throw notFound(what, id);
  throw err;
}

/**
 * Resolve a thread reference to its `topic_id`, spending one call for a
 * discussion or poll reference and none for a topic id. The record read
 * along the way fills the header (type, key, title, group) so the tool
 * output can name the thread without a second lookup — for a poll, from
 * its thread's topic row (`showPollThread`), so a poll inside a
 * discussion names that discussion. Exported for
 * `create_poll`, which needs a discussion's `topic_id` (Loomio's
 * PermittedParams has no `discussion_id` for polls) and its `group_id`
 * (to refuse a poll aimed at one group but attached to a thread of
 * another) — the same one GET, the same 404 wording.
 *
 * `opts.lookupTopic` makes the topic_id path spend one call too:
 * `GET /b2/threads/{topic_id}?compact=1` (TopicSerializer carries
 * `group_id`, `topicable_type` / `topicable_id`; the fronting record
 * still arrives under `discussions` / `polls` because `compact` does not
 * exclude those). `create_poll` uses it when a caller passes `topic_id`
 * AND `group_id`, so the cross-check happens BEFORE anything is
 * written on that path as well.
 */
export async function resolveThread(
  ref: ThreadRef,
  opts: { lookupTopic?: boolean } = {},
): Promise<{ header: ThreadHeader; calls: number }> {
  if (ref.topic_id !== undefined) {
    if (!opts.lookupTopic) {
      return {
        header: {
          topic_id: ref.topic_id,
          type: null,
          id: null,
          key: null,
          title: null,
          group_id: null,
        },
        calls: 0,
      };
    }
    const { body, topic } = await showThread(ref.topic_id);
    return { header: headerFromTopic(ref.topic_id, topic, body), calls: 1 };
  }
  if (ref.discussion_id !== undefined) {
    let body: DiscussionsResponse;
    try {
      body = await loomioGet<DiscussionsResponse>(
        `/b2/discussions/${encodePathSegment(ref.discussion_id)}`,
        readParams("compact"),
      );
    } catch (err) {
      rethrowRecordNotFound(err, "discussion", ref.discussion_id);
    }
    const d = body.discussions?.[0];
    if (!d || d.topic_id == null) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/discussions/${ref.discussion_id} without a discussion carrying a ` +
          "topic_id; the response shape is not the one Loomio 3.8.1 produces.",
      );
    }
    const base = {
      topic_id: d.topic_id,
      type: "Discussion" as const,
      id: d.id,
      key: d.key ?? null,
      title: d.title ?? null,
      group_id: d.group_id ?? null,
    };
    return { header: { ...base, ...headerUrl(base) }, calls: 1 };
  }
  if (ref.poll_id !== undefined) {
    const { header } = await showPollThread(ref.poll_id);
    return { header, calls: 1 };
  }
  // The schema's refinement makes this unreachable; keep the throw so a
  // direct caller gets a message rather than an undefined path segment.
  throw new Error("list_thread_items: pass exactly one of discussion_id, poll_id or topic_id.");
}

/**
 * GET /b2/polls/{id} with the `thread_guard` profile (`compact` minus
 * `topic`): the poll, the TopicSerializer row of the thread it sits in
 * and that row's fronting record (`discussions` / `polls`), plus the
 * user's `my_stance` under `stances`. The header names the THREAD
 * (`headerFromTopic`): for a poll inside a discussion that is the
 * discussion, not the poll asked for. `compact` would drop the topic
 * row, and before 0.0.16 list_thread_items built the header from the
 * poll alone — labelling a discussion thread a Poll thread with the
 * poll's `/p/` url, while get_thread_markdown named the discussion for
 * the same reference. Falls back to the poll when no topic row arrives
 * (a Loomio that sends none). Shared by `resolveThread` and the
 * Markdown guard's read, so both tools say the same thing for one
 * `poll_id`; one call either way.
 */
async function showPollThread(pollRef: string | number): Promise<{
  body: PollsResponse;
  topic: LoomioTopic | undefined;
  header: ThreadHeader;
}> {
  let body: PollsResponse;
  try {
    body = await loomioGet<PollsResponse>(
      `/b2/polls/${encodePathSegment(pollRef)}`,
      readParams("thread_guard"),
    );
  } catch (err) {
    rethrowRecordNotFound(err, "poll", pollRef);
  }
  const p = requestedPoll(body.polls ?? [], pollRef);
  if (!p || p.topic_id == null) {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/polls/${pollRef} without a poll carrying a topic_id; the response ` +
        "shape is not the one Loomio 3.8.1 produces.",
    );
  }
  const topic = (body.topics ?? []).find((t) => t.id === p.topic_id);
  const base = {
    topic_id: p.topic_id,
    type: "Poll" as const,
    id: p.id,
    key: p.key ?? null,
    title: p.title ?? null,
    group_id: p.group_id ?? null,
  };
  return {
    body,
    topic,
    header: topic ? headerFromTopic(p.topic_id, topic, body) : { ...base, ...headerUrl(base) },
  };
}

const THREAD_NOT_VISIBLE =
  "thread not found or not visible to the connector's user (HTTP 404 from GET /b2/threads/{topic_id}). " +
  "Loomio resolves a thread through TopicQuery.visible_to(user).find, so an unknown topic_id and a " +
  "private thread in a group the user has not joined look the same. Check the topic_id (it is the " +
  "thread id, not the discussion or poll id) and the user's membership.";

/**
 * Re-say a thread route's 404 in terms of what it means (see the module
 * note). In open-DCR mode first collapse it into the one "absent or not
 * served" text (nit 19): otherwise an unknown topic_id read "thread not
 * found" while one in an unlisted group or a direct thread read "No
 * thread … is visible", and the difference told an anonymous caller which
 * topic ids exist (review round 1).
 */
function rethrowThreadNotFound(err: unknown, topicId: number): never {
  maybeCollapseNotVisible(err, "thread", topicId);
  if (err instanceof LoomioApiError && err.status === 404) {
    throw new LoomioApiError(404, `topic_id ${topicId}: ${THREAD_NOT_VISIBLE}`);
  }
  throw err;
}

/**
 * The caller's OWN reference, for an allow-list refusal (F-17 / nit 19).
 * Refusing a `discussion_id` / `poll_id` with the RESOLVED topic_id ("No
 * thread "702"") both told an unlisted record apart from a missing one
 * (which reads "No discussion "999"") and disclosed the record's topic_id
 * (review round 1); naming what the caller passed makes the two replies
 * byte-identical.
 */
function callerThreadRef(
  ref: ThreadRef,
  topicId: number,
): { what: "discussion" | "poll" | "thread"; ref: string | number } {
  if (ref.discussion_id !== undefined) return { what: "discussion", ref: ref.discussion_id };
  if (ref.poll_id !== undefined) return { what: "poll", ref: ref.poll_id };
  return { what: "thread", ref: ref.topic_id ?? topicId };
}

// ── Item shaping ────────────────────────────────────────────────────────────

const ITEM_FIELDS = [
  "id",
  "sequence_id",
  "position",
  "depth",
  "kind",
  "actor_id",
  "created_at",
  "parent_id",
  "child_count",
  "pinned",
  "itemable_type",
  "itemable_id",
] as const;

export type ShapedThreadItem = Pick<LoomioTopicItem, (typeof ITEM_FIELDS)[number]> &
  Record<string, unknown> & {
    /** Only when the item is pinned with a title. */
    pinned_title?: string;
    /** Loomio 3.11+: the editor's note on a `discussion_edited` / `poll_edited` item, when one was written. */
    change_note?: string;
  };

/**
 * One item minus its internals (`position_key`, `topic_id`, the
 * redundant `itemable` pointer). `change_note` (Loomio 3.11+,
 * 56ca88d8e: the edit note an editor typed, plain text) rides along
 * when non-empty, capped by `body_max_chars` with the usual
 * `change_note_truncated` / `_chars` / `_omitted` flags. Not surfaced:
 * `reply_parent_id` (3.11+, a TopicItem id for a reply nested past the
 * thread's max depth) — the comment's own `parent_id` / `parent_type`
 * already name the real parent — and the per-item `tags` (3.13+).
 */
export function shapeThreadItem(
  item: LoomioTopicItem,
  bodyMaxChars = DEFAULT_BODY_MAX_CHARS,
): ShapedThreadItem {
  const out: ShapedThreadItem = pick(item, ITEM_FIELDS);
  if (item.pinned && typeof item.pinned_title === "string" && item.pinned_title !== "") {
    out.pinned_title = item.pinned_title;
  }
  if (typeof item.change_note === "string" && item.change_note !== "") {
    return truncateField({ ...out, change_note: item.change_note }, "change_note", bodyMaxChars);
  }
  return out;
}

const COMMENT_FIELDS = [
  "id",
  "body",
  "body_format",
  "author_id",
  "parent_id",
  "parent_type",
  "created_at",
  "updated_at",
  "discarded_at",
  "versions_count",
] as const;

export type ShapedComment = Pick<LoomioComment, (typeof COMMENT_FIELDS)[number]> &
  Record<string, unknown> & { attachments_count?: number };

/**
 * `stripHtml` runs `stripBodyHtml` (src/loomio/shape.ts: HTML → text,
 * `*_format: "text"`) BEFORE the cap, so the capped characters are
 * words. It is OFF here because the write tools echo a comment as
 * Loomio stored it (src/tools/comments.ts passes only the cap);
 * list_thread_items passes its caller's `strip_html`, default on. The
 * same three-way applies to `shapeStance` and `shapeOutcome`.
 */
export function shapeComment(
  comment: LoomioComment,
  bodyMaxChars: number,
  stripHtml = false,
): ShapedComment {
  const base: ShapedComment = pick(comment, COMMENT_FIELDS);
  if (Array.isArray(comment.attachments)) base.attachments_count = comment.attachments.length;
  const text: ShapedComment = stripHtml ? stripBodyHtml(base, "body", "body_format") : base;
  return truncateBody(text, "body", bodyMaxChars, "body_format");
}

/**
 * A poll as a thread item shows it: identity, type, schedule, the
 * visibility settings, participation counts, its options and — when the
 * results are visible to the connector's user — the per-option tallies
 * (`stance_counts`, aligned with `poll_options[]`, which Loomio orders
 * by priority on both). The full `results[]` (per-option voter ids and
 * scores) is left to get_poll: the thread already carries every stance,
 * so repeating the breakdown here would double the bytes for nothing a
 * caller cannot read off them.
 *
 * `poll_options[]` is what makes those stances READABLE: a stance's
 * `option_scores` is keyed by poll_option ID (Stance#build_option_scores:
 * `stance_choices.map { [poll_option_id.to_s, score] }`), so without the
 * id → name map `{"812": 1}` says nothing. The `poll_options` root
 * arrives under every items profile (Loomio's compact list has no
 * `poll_option`); when it is missing for a poll the map is rebuilt from
 * the record's own `poll_option_ids` / `poll_option_names`, which the
 * serializer emits from the same priority-ordered association.
 *
 * `weighted_voting` (3.10+) says the tallies and every stance's `weight`
 * are in vote-weight units; `voting_system` is gone (Loomio ≤ 3.9 only,
 * 917b2c2e4 removed it). `total_score` is a decimal string since 3.10.
 */
const ITEM_POLL_FIELDS = [
  "id",
  "key",
  "title",
  "poll_type",
  "author_id",
  "group_id",
  "topic_id",
  "created_at",
  "closing_at",
  "closed_at",
  "discarded_at",
  "hide_results",
  "anonymous",
  "weighted_voting",
  "specified_voters_only",
  "voters_count",
  "decided_voters_count",
  "undecided_voters_count",
  "cast_stances_pct",
  "current_outcome_id",
  "stance_counts",
  "total_score",
  "details",
  "details_format",
] as const;

/** One option of a poll inside a thread: the id `option_scores` keys refer to, its name, its display order. */
export interface ItemPollOption {
  id: number;
  name: string | null;
  priority: number;
}

export type ShapedItemPoll = Pick<GatedPoll<LoomioPoll>, (typeof ITEM_POLL_FIELDS)[number]> &
  Record<string, unknown> & {
    /** In display (priority) order; `stance_counts[i]` is the tally of `poll_options[i]`. */
    poll_options: ItemPollOption[];
    results_visible: boolean;
    results_hidden_reason?: ResultsVisibility["reason"];
    url?: string;
  };

/** The poll's options from the side-loaded root, else zipped from the record's own id / name arrays. */
export function itemPollOptions(
  poll: LoomioPoll,
  root: readonly LoomioPollOption[] | undefined,
): ItemPollOption[] {
  const fromRoot = (root ?? [])
    .filter((o) => o.poll_id === poll.id)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((o, i) => ({ id: o.id, name: o.name ?? null, priority: o.priority ?? i }));
  if (fromRoot.length > 0) return fromRoot;
  const ids = Array.isArray(poll.poll_option_ids) ? poll.poll_option_ids : [];
  const names = Array.isArray(poll.poll_option_names) ? poll.poll_option_names : [];
  return ids.map((id, i) => ({ id, name: names[i] ?? null, priority: i }));
}

export function shapeItemPoll(
  poll: LoomioPoll,
  visibility: ResultsVisibility,
  bodyMaxChars: number,
  options: readonly LoomioPollOption[] | undefined,
): ShapedItemPoll {
  const gated = stripHiddenResults(poll, visibility);
  const base: ShapedItemPoll = {
    ...pick(gated, ITEM_POLL_FIELDS),
    poll_options: itemPollOptions(poll, options),
    results_visible: gated.results_visible,
    ...(gated.results_hidden_reason ? { results_hidden_reason: gated.results_hidden_reason } : {}),
  };
  const url = threadUrl("Poll", poll.key, { title: poll.title });
  const withUrl = url ? { ...base, url } : base;
  return truncateBody(withUrl, "details", bodyMaxChars, "details_format") as ShapedItemPoll;
}

const STANCE_FIELDS = [
  "id",
  "poll_id",
  "participant_id",
  "cast_at",
  "revoked_at",
  "latest",
  "reason",
  "reason_format",
  "none_of_the_above",
  "option_scores",
] as const;

export type ShapedStance = Pick<LoomioStance, (typeof STANCE_FIELDS)[number]> &
  Record<string, unknown> & {
    /** The voter's vote weight (decimal string), on a `weighted_voting` poll only. */
    weight?: string;
  };

/**
 * `weighted` is the stance's poll's `weighted_voting`: StanceSerializer
 * sends `weight` on EVERY stance since 3.10 ("1" on an ordinary poll),
 * so it is kept only where it changes what a vote counts for and an
 * unweighted thread pays no bytes for it. It is the voter's weight, not
 * their choice, so the results gate does not touch it.
 */
export function shapeStance(
  stance: LoomioStance,
  visibility: ResultsVisibility,
  bodyMaxChars: number,
  ownUserId: number | undefined,
  stripHtml = false,
  weighted = false,
): ShapedStance {
  // `stripHiddenStanceResults` types its result with `Omit`, which over a
  // record carrying an index signature (every Loomio type does) collapses
  // to the index signature alone and loses `id: number`. The removed
  // fields are optional on LoomioStance, so reading it as one is exact.
  // A hidden stance has no `reason` left for `stripBodyHtml` to touch.
  const stripped = stripHiddenStanceResults(stance, visibility, { ownUserId }) as LoomioStance;
  const picked: ShapedStance = pick(stripped, STANCE_FIELDS);
  if (weighted && typeof stance.weight === "string") picked.weight = stance.weight;
  const text = stripHtml ? stripBodyHtml(picked, "reason", "reason_format") : picked;
  return truncateBody(text, "reason", bodyMaxChars, "reason_format");
}

const OUTCOME_FIELDS = [
  "id",
  "poll_id",
  "poll_option_id",
  "statement",
  "statement_format",
  "author_id",
  "created_at",
  "review_on",
  "latest",
] as const;

export type ShapedOutcome = Pick<LoomioOutcome, (typeof OUTCOME_FIELDS)[number]> &
  Record<string, unknown>;

export function shapeOutcome(
  outcome: LoomioOutcome,
  bodyMaxChars: number,
  stripHtml = false,
): ShapedOutcome {
  const picked: ShapedOutcome = pick(outcome, OUTCOME_FIELDS);
  const text = stripHtml ? stripBodyHtml(picked, "statement", "statement_format") : picked;
  return truncateBody(text, "statement", bodyMaxChars, "statement_format");
}

/** ReactionSerializer: `{ id, reaction, user_id, reactable_type, reactable_id }`; nothing to slim. */
export interface ShapedReaction {
  id: number;
  reaction: string;
  user_id: number | null;
  reactable_type: string;
  reactable_id: number;
}

function shapeReaction(raw: unknown): ShapedReaction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "number" || typeof r["reactable_id"] !== "number") return undefined;
  return {
    id: r["id"],
    reaction: typeof r["reaction"] === "string" ? r["reaction"] : "",
    user_id: typeof r["user_id"] === "number" ? r["user_id"] : null,
    reactable_type: typeof r["reactable_type"] === "string" ? r["reactable_type"] : "",
    reactable_id: r["reactable_id"],
  };
}

/**
 * Apply the `kinds` filter. `other` is a passthrough for kinds the
 * connector does not catalogue (`THREAD_ITEM_KINDS`), so a caller can
 * ask for "comments, polls and anything I have not heard of" without
 * naming a future Loomio kind.
 */
export function filterKinds(
  items: readonly LoomioTopicItem[],
  kinds?: string[],
): LoomioTopicItem[] {
  if (!kinds?.length) return [...items];
  const wanted = new Set(kinds);
  const passOther = wanted.has("other");
  return items.filter((item) => {
    const kind = item.kind ?? "";
    return wanted.has(kind) || (passOther && !KNOWN_KINDS.has(kind));
  });
}

/**
 * The thread's own record, from the items response: the item at
 * sequence 0 (`new_discussion`, or the `poll_created` of a standalone
 * poll) points at it. Fills whatever the header does not know yet.
 *
 * ONLY the sequence-0 item, never "the first item": on a page that
 * starts further in (an `offset` on Loomio ≥ 3.11.1, which pages this
 * route) the first item can be the `poll_created` of a poll INSIDE a
 * discussion, and taking it would label the discussion a Poll thread.
 * A continuation addressed by bare `topic_id` therefore keeps `type`,
 * `id`, `key` and `title` null — they were on the page at offset 0 —
 * rather than spend a call to learn them.
 */
function completeHeader(header: ThreadHeader, body: ThreadItemsResponse): ThreadHeader {
  if (header.type && header.id != null) return header;
  const items = body.items ?? [];
  const root = items.find((i) => i.sequence_id === 0);
  if (!root) return header;
  const type = root.itemable_type;
  const base = { ...header };
  if (type === "Discussion" && root.itemable_id != null) {
    const d = indexById(body.discussions).get(root.itemable_id);
    base.type = "Discussion";
    base.id = root.itemable_id;
    if (d) {
      base.key = d.key ?? base.key;
      base.title = d.title ?? base.title;
      base.group_id = d.group_id ?? base.group_id;
    }
  } else if (type === "Poll" && root.itemable_id != null) {
    const p = indexById(body.polls).get(root.itemable_id);
    base.type = "Poll";
    base.id = root.itemable_id;
    if (p) {
      base.key = p.key ?? base.key;
      base.title = p.title ?? base.title;
      base.group_id = p.group_id ?? base.group_id;
    }
  }
  return { ...base, ...headerUrl(base) };
}

// ── list_thread_items ───────────────────────────────────────────────────────

export const listThreadItemsSchema = z
  .object({
    ...threadRefFields,
    // The 15-kind catalogue (THREAD_ITEM_KINDS) is not repeated here: it
    // costs ~240 chars in every session's tools/list, every returned item
    // carries its `kind`, and HOWTO.md "Tool reference" lists them all.
    kinds: z
      .array(z.string().min(1).max(TEXT_MAX.kind))
      .max(32)
      .optional()
      .describe("Item kinds to keep (e.g. new_comment, stance_created); 'other' = unlisted kinds."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ITEMS_LIMIT)
      .optional()
      .describe(
        `Items after the kinds filter; default ${DEFAULT_ITEMS_LIMIT}, max ${MAX_ITEMS_LIMIT}.`,
      ),
    offset: z.number().int().min(0).optional().describe("Items to skip. Default 0."),
    include_reactions: z
      .boolean()
      .optional()
      .describe("Also return emoji `reactions`. Default false."),
    body_max_chars: maxCharsSchema("body", DEFAULT_BODY_MAX_CHARS),
    strip_html: z
      .boolean()
      .optional()
      .describe("Plain text instead of HTML bodies, reasons, outcomes; default true."),
    max_total_chars: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe(
        `Reply budget in chars; default ${DEFAULT_ITEMS_MAX_TOTAL_CHARS}, -1 = none. See next_offset.`,
      ),
  })
  .superRefine((input, ctx) => {
    requireExactlyOneRef(input, ctx);
    if (input.max_total_chars === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["max_total_chars"],
        message:
          "max_total_chars must be -1 (no budget) or a positive number; 0 would return nothing.",
      });
    }
  });

export type ListThreadItemsInput = z.infer<typeof listThreadItemsSchema>;

export interface ListThreadItemsResult extends ThreadHeader {
  items: ShapedThreadItem[];
  comments: ShapedComment[];
  polls: ShapedItemPoll[];
  stances: ShapedStance[];
  outcomes: ShapedOutcome[];
  users: SlimUser[];
  /** Present only when `include_reactions` was requested. */
  reactions?: ShapedReaction[];
  /** Loomio's `meta.total`: every item in the thread, before the kinds filter and the window. */
  total: number;
  /** Items that passed the kinds filter (= `total` without a filter; with one, counted over the items scanned). */
  matched: number;
  returned: number;
  /** True when `max_total_chars` stopped the slice before `limit` did. */
  truncated_by_budget: boolean;
  /** Offset of the next unreturned matched item; null when the slice reached the end. */
  next_offset: number | null;
  scope: {
    offset: number;
    limit: number;
    /** The reply budget applied (-1 = none). */
    max_total_chars: number;
    /** Shaped characters the returned items and their records occupy (what the budget counted). */
    chars: number;
    kinds: string[] | null;
    include_reactions: boolean;
    body_max_chars: number;
    /** True when HTML bodies / reasons / statements were converted to text (their `*_format` says "text"). */
    strip_html: boolean;
    /**
     * Upstream requests this call made: the reference's resolution (0 by
     * `topic_id`, 1 by `discussion_id` / `poll_id`) plus the item
     * requests — one per 500 items of the window without `kinds` (at
     * most 2), one per 500 items of the thread with it (at most
     * `MAX_ITEM_SCAN_PAGES`), and always exactly one when Loomio returned
     * the whole thread at once (`server_paged: false`).
     */
    upstream_calls: number;
    /**
     * False ONLY when the connector detected that Loomio ignored `limit`
     * / `offset` and returned the whole thread (Loomio < 3.11.1), which it
     * then sliced itself. A pre-3.11.1 reply that happens to fit the
     * window at offset 0 (say 120 items under `limit: 200`) cannot be told
     * from a bounded page and reports true; the items, `total` and
     * `next_offset` are right either way, only this flag cannot say which
     * server answered.
     */
    server_paged: boolean;
    /** With `kinds`: present (true) when the whole-thread scan hit `MAX_ITEM_SCAN_PAGES` — `matched` counts the scanned items only. */
    scan_truncated?: true;
    /** The `exclude_types` profile sent with the items request (see src/loomio/client.ts). */
    profile: "compact" | "items_known_thread" | "items_with_reactions";
    /** True when the connector could recognise its own stances (poll results gated exactly); false = it assumed "not voted". */
    own_user_known: boolean;
    note: string;
  };
}

const ITEMS_SCOPE_NOTE =
  "Loomio 3.11.1+ pages a thread's items (thread order, at most 500 per request, meta.total = the " +
  "whole thread): the connector asks for exactly the offset/limit window, and with kinds reads the " +
  "thread page by page from the start to filter it. Older Loomio returns the whole thread, which is " +
  "sliced here (server_paged: false when that was detected). Comments, polls, stances, outcomes and " +
  "users are those the returned items reference. The window also stops when the reply would exceed " +
  "max_total_chars (truncated_by_budget: true; continue at next_offset). Poll " +
  "results and other voters' choices are hidden where the poll's hide_results setting hides them " +
  "from a member who has not voted (results_visible / results_hidden_reason on each poll). A " +
  "stance's option_scores is keyed by poll_option ID — resolve the keys through the poll's " +
  "poll_options[] {id, name}; stance_counts[i] is the tally of poll_options[i]. Anonymous polls " +
  "have no stances here at all (Loomio's b2 API does not serialize their ballots) — do not try to " +
  "infer voters.";

const ITEMS_HEADER_UNKNOWN_NOTE =
  " The thread's type, id, key and title are null: they come from its opening item, which is not " +
  "in this window (they were on the page at offset 0).";

/**
 * What a caller that already holds the thread's fronting record can pass
 * so the items request excludes the opening post (`items_known_thread`)
 * and the header needs nothing from the response. Not part of the tool's
 * input schema: only get_discussion's `include_items` path supplies it.
 */
export interface KnownThread {
  type: ThreadType;
  id: number;
  key?: string | null;
  title?: string | null;
  group_id?: number | null;
}

function withKnownThread(header: ThreadHeader, known: KnownThread): ThreadHeader {
  const base = {
    topic_id: header.topic_id,
    type: known.type,
    id: known.id,
    key: known.key ?? null,
    title: known.title ?? null,
    group_id: known.group_id ?? null,
  };
  return { ...base, ...headerUrl(base) };
}

export async function listThreadItems(
  input: ListThreadItemsInput,
  known?: KnownThread,
): Promise<ListThreadItemsResult> {
  const limit = input.limit ?? DEFAULT_ITEMS_LIMIT;
  const offset = input.offset ?? 0;
  const bodyMax = input.body_max_chars ?? DEFAULT_BODY_MAX_CHARS;
  const budget = input.max_total_chars ?? DEFAULT_ITEMS_MAX_TOTAL_CHARS;
  const includeReactions = Boolean(input.include_reactions);
  const stripHtml = input.strip_html ?? true;

  // F-17: under a group allow-list the thread's group must be known
  // BEFORE its items are read, so a bare `topic_id` pays one GET of the
  // thread row (`lookupTopic`); a discussion / poll reference and a
  // `known` record already carry it.
  const { header: fromRef, calls } = await resolveThread(input, {
    lookupTopic: hasGroupAllowlist() && known === undefined,
  });
  const resolved = known && fromRef.type === null ? withKnownThread(fromRef, known) : fromRef;
  const own = callerThreadRef(input, resolved.topic_id);
  assertRecordGroupAllowed(resolved.group_id, own.what, own.ref);
  // Which side-loads to drop (see the module note): reactions need the
  // opening post's serializer; a known thread does not need the opening
  // post at all; the bare topic_id path needs it to fill the header.
  const headerKnown = resolved.type !== null && resolved.id !== null;
  const profile = includeReactions
    ? "items_with_reactions"
    : headerKnown
      ? "items_known_thread"
      : "compact";
  const path = `/b2/threads/${resolved.topic_id}/items`;
  const kinds = input.kinds?.length ? input.kinds : undefined;
  const fail = (err: unknown): never => rethrowThreadNotFound(err, resolved.topic_id);

  // Side-loads, merged page by page with the rule `mergePageBodies`
  // applies (first arrival wins): a bounded page carries only what its
  // OWN items reference, so the record a page-2 item points at is looked
  // up in everything read so far. Visibility per poll is decided when the
  // poll first arrives, over every stance read so far, with the identity
  // the health probe learned — PollSerializer side-loads the user's
  // `my_stance` beside the poll on every page that serialises it, so the
  // own stance is in by then even when its item sits outside the window.
  // Unknown identity ⇒ "not voted" ⇒ hide.
  const ownUserId = cachedOwnUserId();
  const roots = {
    comments: new Map<number, LoomioComment>(),
    polls: new Map<number, LoomioPoll>(),
    stances: new Map<number, LoomioStance>(),
    outcomes: new Map<number, LoomioOutcome>(),
  };
  const users = new Map<number, LoomioUser>();
  const pollOptions = new Map<number, LoomioPollOption>();
  const reactions = new Map<number, ShapedReaction>();
  const visibility = new Map<number, ResultsVisibility>();
  function absorb(page: ThreadItemsResponse): void {
    addNew(roots.comments, page.comments);
    addNew(roots.polls, page.polls);
    addNew(roots.stances, page.stances);
    addNew(roots.outcomes, page.outcomes);
    addNew(users, page.users);
    addNew(pollOptions, page.poll_options);
    for (const raw of Array.isArray(page.reactions) ? page.reactions : []) {
      const r = shapeReaction(raw);
      if (r && !reactions.has(r.id)) reactions.set(r.id, r);
    }
    const stances = [...roots.stances.values()];
    for (const p of page.polls ?? []) {
      if (visibility.has(p.id)) continue;
      const poll = roots.polls.get(p.id) ?? p;
      visibility.set(p.id, pollResultsVisible(poll, ownStanceFor(p.id, stances, { ownUserId })));
    }
  }
  // A stance whose poll is not in the response cannot be judged; Loomio
  // only emits its scores when results_available?, but until_vote is
  // unknown without the poll, so treat it as hidden.
  const visibilityOf = (pollId: number): ResultsVisibility =>
    visibility.get(pollId) ?? { visible: false, reason: "until_vote" };

  // Side-loads narrowed to what the returned items reference, shaped AS
  // THE WALK GOES so the reply budget can be applied per item: an item
  // costs its own row plus the record it points at and, for a stance or
  // outcome, the poll it belongs to when that poll is not in yet (the
  // vote must be readable even when the poll_created item is outside
  // the window). Each record enters once however many items point at it.
  // The walk stops BEFORE the item that would overrun `budget` — never
  // before the first, so a single oversized comment (already capped by
  // body_max_chars) is returned rather than nothing.
  const items: ShapedThreadItem[] = [];
  const shaped = {
    comments: [] as ShapedComment[],
    polls: [] as ShapedItemPoll[],
    stances: [] as ShapedStance[],
    outcomes: [] as ShapedOutcome[],
  };
  const included = {
    comments: new Map<number, LoomioComment>(),
    polls: new Map<number, LoomioPoll>(),
    stances: new Map<number, LoomioStance>(),
    outcomes: new Map<number, LoomioOutcome>(),
  };
  const size = (v: unknown): number => JSON.stringify(v).length + 1;
  type Pending = { cost: number; add: () => void };
  /** The record `id` of `root`, shaped, as a pending addition — undefined when absent or already in. */
  function pending<R extends { id: number }, S>(
    root: keyof typeof roots,
    id: number,
    shape: (raw: R) => S,
  ): Pending | undefined {
    if (included[root].has(id)) return undefined;
    const raw = roots[root].get(id) as R | undefined;
    if (!raw) return undefined;
    const out = shape(raw);
    return {
      cost: size(out),
      add: () => {
        (included[root] as Map<number, R>).set(id, raw);
        (shaped[root] as S[]).push(out);
      },
    };
  }
  const pendingPoll = (pollId: number): Pending | undefined =>
    pending<LoomioPoll, ShapedItemPoll>("polls", pollId, (p) =>
      shapeItemPoll(p, visibilityOf(p.id), bodyMax, [...pollOptions.values()]),
    );

  let used = 0;
  let cut = false;
  /** Shape `window`'s items in order under the reply budget; sets `cut` when the budget stops it. */
  function walk(window: readonly LoomioTopicItem[]): void {
    for (const item of window) {
      const row = shapeThreadItem(item, bodyMax);
      const adds: Pending[] = [];
      const id = item.itemable_id;
      if (id != null) {
        if (item.itemable_type === "Comment") {
          const c = pending<LoomioComment, ShapedComment>("comments", id, (raw) =>
            shapeComment(raw, bodyMax, stripHtml),
          );
          if (c) adds.push(c);
        } else if (item.itemable_type === "Poll") {
          const p = pendingPoll(id);
          if (p) adds.push(p);
        } else if (item.itemable_type === "Stance") {
          const st = roots.stances.get(id);
          const sp = pending<LoomioStance, ShapedStance>("stances", id, (raw) =>
            shapeStance(
              raw,
              visibilityOf(raw.poll_id),
              bodyMax,
              ownUserId,
              stripHtml,
              roots.polls.get(raw.poll_id)?.weighted_voting === true,
            ),
          );
          if (sp) adds.push(sp);
          const p = st ? pendingPoll(st.poll_id) : undefined;
          if (p) adds.push(p);
        } else if (item.itemable_type === "Outcome") {
          const o = roots.outcomes.get(id);
          const op = pending<LoomioOutcome, ShapedOutcome>("outcomes", id, (raw) =>
            shapeOutcome(raw, bodyMax, stripHtml),
          );
          if (op) adds.push(op);
          const p = o ? pendingPoll(o.poll_id) : undefined;
          if (p) adds.push(p);
        }
      }
      const cost = size(row) + adds.reduce((sum, a) => sum + a.cost, 0);
      if (budget >= 0 && items.length > 0 && used + cost > budget) {
        cut = true;
        return;
      }
      used += cost;
      items.push(row);
      for (const a of adds) a.add();
    }
  }

  let header = resolved;
  let state: PagerState;
  let total: number;
  let matched: number;
  let nextOffset: number | null;
  let scanned = 0;
  if (kinds) {
    // `kinds` is the connector's filter, not Loomio's, so `offset` /
    // `limit` are positions in the FILTERED list and no upstream window
    // can stand for them: the thread is read from item 0, page by page,
    // up to MAX_ITEM_SCAN_PAGES — and a scan the cap stopped says so.
    const all = await loomioGetAllPages<ThreadItemsResponse>(path, readParams(profile), {
      root: "items",
      maxPages: MAX_ITEM_SCAN_PAGES,
    }).catch(fail);
    state = all.state;
    absorb(all.body);
    header = completeHeader(header, all.body);
    const thread = Array.isArray(all.body.items) ? all.body.items : [];
    scanned = thread.length;
    const kept = filterKinds(thread, kinds);
    walk(kept.slice(offset, offset + limit));
    total = state.total ?? thread.length;
    matched = kept.length;
    nextOffset = offset + items.length < kept.length ? offset + items.length : null;
  } else {
    // The caller's window IS the upstream window: page 1 asks for
    // min(limit, 500) items at `offset`; page 2 is fetched only when
    // page 1 went into the reply whole (no budget cut), still short of
    // `limit`, and Loomio has more — so a budget-cut call never pays for
    // items it would not return.
    const pager = loomioPager<ThreadItemsResponse>(path, readParams(profile), {
      root: "items",
      offset,
      want: limit,
      pageSize: B2_PAGE_MAX,
      maxPages: Math.ceil(MAX_ITEMS_LIMIT / B2_PAGE_MAX),
    });
    state = pager.state;
    const first: ThreadItemsResponse = (await pager.next().catch(fail)) ?? {};
    absorb(first);
    header = completeHeader(header, first);
    const rows = Array.isArray(first.items) ? first.items : [];
    let received = rows.length;
    if (state.legacy) {
      // Loomio < 3.11.1: the whole thread from item 0. Slice it here.
      walk(rows.slice(offset, offset + limit));
    } else {
      walk(rows);
      if (!cut && items.length < limit && !state.done) {
        const second = await pager.next().catch(fail);
        if (second) {
          absorb(second);
          header = completeHeader(header, second);
          const more = Array.isArray(second.items) ? second.items : [];
          received += more.length;
          walk(more);
        }
      }
    }
    // Loomio always sends meta.total on this route; the fallbacks are a
    // lower bound and a "the last page was full, so ask again" guess.
    total = state.total ?? (state.legacy ? received : offset + received);
    matched = total;
    const at = offset + items.length;
    nextOffset =
      state.total !== null || state.legacy
        ? at < total
          ? at
          : null
        : cut || state.lastPageFull
          ? at
          : null;
  }

  const wantUsers = new Set<number>();
  for (const item of items) if (item.actor_id != null) wantUsers.add(item.actor_id);
  for (const c of included.comments.values()) if (c.author_id != null) wantUsers.add(c.author_id);
  for (const p of included.polls.values()) if (p.author_id != null) wantUsers.add(p.author_id);
  for (const o of included.outcomes.values()) if (o.author_id != null) wantUsers.add(o.author_id);
  for (const s of included.stances.values()) {
    if (s.participant_id != null) wantUsers.add(s.participant_id);
  }

  let note = ITEMS_SCOPE_NOTE;
  if (kinds && state.capped) {
    note +=
      ` Only the first ${scanned} items of the thread were scanned for kinds (scan_truncated): ` +
      `matched and next_offset cover those; read later items without kinds, from offset ${scanned}.`;
  }
  if (header.type === null && header.id === null) note += ITEMS_HEADER_UNKNOWN_NOTE;

  const returned = items.length;
  const result: ListThreadItemsResult = {
    ...header,
    items,
    comments: shaped.comments,
    polls: shaped.polls,
    stances: shaped.stances,
    outcomes: shaped.outcomes,
    users: slimUsers([...wantUsers].flatMap((id) => users.get(id) ?? [])),
    total,
    matched,
    returned,
    truncated_by_budget: cut,
    next_offset: nextOffset,
    scope: {
      offset,
      limit,
      max_total_chars: budget,
      chars: used,
      kinds: kinds ?? null,
      include_reactions: includeReactions,
      body_max_chars: bodyMax,
      strip_html: stripHtml,
      upstream_calls: calls + state.requests,
      server_paged: !state.legacy,
      ...(kinds && state.capped ? { scan_truncated: true as const } : {}),
      profile,
      own_user_known: ownUserId !== undefined,
      note,
    },
  };
  if (includeReactions) {
    const reactable = new Set<string>();
    for (const id of included.comments.keys()) reactable.add(`Comment:${id}`);
    for (const id of included.stances.keys()) reactable.add(`Stance:${id}`);
    for (const id of included.outcomes.keys()) reactable.add(`Outcome:${id}`);
    for (const id of included.polls.keys()) reactable.add(`Poll:${id}`);
    if (header.type === "Discussion" && header.id != null) reactable.add(`Discussion:${header.id}`);
    result.reactions = [...reactions.values()].filter((r) =>
      reactable.has(`${r.reactable_type}:${r.reactable_id}`),
    );
  }
  return result;
}

/** Add `rows` to `into` by id, keeping the first arrival (the `mergePageBodies` rule). */
function addNew<R extends { id: number }>(
  into: Map<number, R>,
  rows: readonly R[] | undefined,
): void {
  for (const row of rows ?? []) if (!into.has(row.id)) into.set(row.id, row);
}

// ── get_thread_markdown ─────────────────────────────────────────────────────

export const getThreadMarkdownSchema = z
  .object({
    ...markdownRefFields,
    max_chars: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe(
        `Cap in chars; default ${DEFAULT_MARKDOWN_MAX_CHARS}, -1 = all. Cuts the END; \`truncated\` flags it.`,
      ),
  })
  .superRefine((input, ctx) => {
    requireExactlyOneRef(input, ctx);
    if (input.max_chars === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["max_chars"],
        message: "max_chars must be -1 (full) or a positive number; 0 would return nothing.",
      });
    }
  });

export type GetThreadMarkdownInput = z.infer<typeof getThreadMarkdownSchema>;

export interface GetThreadMarkdownResult extends ThreadHeader {
  /**
   * The document's `# …` title line without the `# `. Loomio ≥ 3.10:
   * "<Type>: <title> · <author> · <YYYY-MM-DD HH:MM>" (UTC); older
   * releases put no separator before the date. The type word follows the
   * connector user's locale.
   */
  heading: string | null;
  markdown: string;
  /** Length of the FULL document in characters. */
  chars: number;
  truncated: boolean;
  scope: {
    max_chars: number;
    /**
     * Upstream requests: the guard's one read of the thread (any
     * reference), plus one per 500 items when the guard scanned the
     * thread's items (any thread holding more than its opening item),
     * plus the document itself. On Loomio 3.8 / 3.9 (guard skipped): the
     * read and the document, plus 2 when a stale health probe had to be
     * refreshed to confirm the version.
     */
    upstream_calls: number;
    /**
     * Open polls (opened, not closed, not discarded) whose vote
     * visibility the guard checked before fetching the document: every
     * open poll the items scan found, or — when the thread holds only its
     * opening item — 1 for an open standalone poll and 0 otherwise. 0
     * when the guard was skipped.
     */
    open_polls_checked: number;
    /**
     * Present only when the guard was skipped: a health probe within the
     * last minute reported Loomio 3.8 / 3.9, whose export still applies
     * 'hide results until vote' per reader (thread_markdown_service.rb:
     * 168-172 before df28cf845).
     */
    guard_skipped_pre_3_10?: true;
    note: string;
  };
}

const MARKDOWN_SCOPE_NOTE =
  "Rendered by Loomio (ThreadMarkdownService, 3.10+ layout): YAML front matter (key, url, group, " +
  "created, last_activity, tags = the union over every tagged contribution, and on 3.13+ root_tags " +
  "= the opening post's own), the title line `<Type>: <title> · <author> · <UTC time>`, the opening " +
  "body, then the activity as a reply tree of nested blockquotes: each poll is a `##` section " +
  "(status, options, results table or a 'hidden until…' line) with its votes and their replies " +
  "beneath; each item is headed `**Author** · <UTC time> · #<seq>` (seq = list_thread_items' " +
  "sequence_id), with reactions inline and `Tags:` lines. Removed items stay as `_Removed_` " +
  "placeholders that keep their replies. Superseded, removed and undecided votes are listed; an " +
  "open poll hiding results until it closes shows `voted` without the choice. Loomio 3.10+'s " +
  "export ignores hide_results 'until_vote', so the connector checks the thread first and REFUSES " +
  "one holding an open until_vote poll its user has not voted in (open_polls_checked counts the " +
  "open polls it checked; the check is skipped, guard_skipped_pre_3_10, when a recent health " +
  "probe reports Loomio 3.8 / 3.9, whose export applies the rule itself). Anonymous polls never " +
  "name a voter.";

/** The first Markdown H1 after the front matter, without its `# `. */
export function markdownHeading(markdown: string): string | null {
  const m = /^# (.+)$/m.exec(markdown);
  return m?.[1]?.trim() || null;
}

// ── The vote-visibility guard ───────────────────────────────────────────────
//
// Loomio ≥ 3.10 renders an open `until_vote` poll's votes and results
// table into the Markdown for a reader who has not voted (module note;
// src/loomio/visibility.ts). The JSON tools withhold exactly that, so
// get_thread_markdown checks the thread FIRST and refuses
// (`VisibilityRefusalError`) instead of fetching a document it would
// have to redact — redacting Loomio's localised Markdown is not
// attempted. One read per reference, which also fills the header on
// every path (`loadThreadForGuard`):
//
//   topic_id       GET /b2/threads/{id}?compact=1: the topic row, the
//                  fronting record and, on a Poll topic, that poll with
//                  the user's `my_stance` under `stances`.
//   discussion_id  GET /b2/discussions/{id} with `thread_guard` (compact
//                  minus `topic`), so the `topics` row comes along.
//   poll_id        GET /b2/polls/{id}, same profile (`showPollThread`):
//                  the poll, the topic row of its thread (the
//                  discussion's, for a poll inside one) and `my_stance`.
//
// What the export prints is decided by the thread's ITEMS, not by a
// counter: ThreadMarkdownService#activity_items
// (thread_markdown_service.rb:81-92) renders `topic.items` of the
// comment / poll / vote / outcome kinds and keeps a poll item when it is
// that poll's `created_topic_item` — an association not scoped to the
// topic (has_topic_items.rb:7-17). So, from the read (`guardVerdict`):
//
//   1. Every poll the read side-loaded (a Poll topic's fronting poll, the
//      poll a poll_id named) carries the user's `my_stance`
//      (PollSerializer): one hiding its results from the user is final —
//      refuse, no scan.
//   2. A Poll topic whose fronting poll F (the `polls` row whose id is
//      the topic's `topicable_id`; on the poll_id path not necessarily
//      the poll asked for) did not arrive → scan.
//   3. `items_count` ≤ 1 → allow, nothing else to read. The thread holds
//      its opening item only: a discussion's `new_discussion`, or F's own
//      `poll_created`, which the export replaces by the overview step 1
//      cleared. `items_count` counts the topic's sequenced items
//      (topic.rb:239-246), refreshed on every item create and destroy
//      (topic_item.rb:25-27) and by the repair a move ends with.
//   4. Anything else (a reply, a vote, an unknown topicable, no topic
//      row) → scan.
//
// WHY not `active_polls_count`, which would skip the scan on most
// threads (0 on a discussion; no more than F explains on a Poll topic):
// it follows `polls.topic_id`, and nothing keeps that where the poll's
// items are. b2 `PATCH /b2/polls/{id}` permits `topic_id`
// (permitted_params.rb:39, polls_controller.rb `update`) for an admin of
// both threads; `Poll#with_topic_lock` keeps that destination
// (poll.rb:338-357) and `update_poll_counts` moves the count with it
// (poll.rb:272, 312-331), but PollService.update moves no item
// (poll_service.rb:75-140) — and Loomio's own client includes `topic_id`
// in its poll saves, so a stale tab after a move does the same. The old
// thread then reads `active_polls_count: 0` while its export still
// prints the poll's section and every vote. The other direction — v1
// `topics#move_comments` (routes.rb:341 → TopicItemService.move_comments
// → MoveCommentsWorker) moving any selected `poll_created` items and
// their polls into any topic the actor administers, Poll topics included
// (move_comments_worker.rb:15-25, 38; ability/topic.rb:13-15) — raises
// the target's `items_count`, so step 3 sends it to the scan too; the
// thread show never side-loads a moved-in poll (TopicSerializer's
// `has_one :poll` is the topicable only, topic_serializer.rb:37, 48-54).
//
// The scan reads the thread's items, up to `MAX_ITEM_SCAN_PAGES` pages
// of 500, and checks every poll they side-load — a `poll_created` item
// brings its poll, a stance or outcome item its poll, whatever the
// poll's own `topic_id` — with the identity the health probe learned
// (`cachedOwnUserId`; unknown ⇒ "not voted" ⇒ refuse). It stops at the
// first page that shows a hidden poll: PollSerializer sends `my_stance`
// beside the poll on every page that serialises it, so that verdict
// cannot change later. It never stops early to ALLOW — no counter bounds
// what the export prints (above) — and a scan its page cap stopped fails
// CLOSED ("could not verify"). WHY a scan at all: the b2 polls index
// lists standalone polls only (`records_visible_in_group`,
// b2/base_controller.rb:21-32) and no b2 route lists a thread's polls.
//
// On Loomio 3.8 / 3.9, confirmed by a health probe within the last
// minute, the whole guard is skipped (the read still fills the header):
// that export applies 'until vote' per reader itself — see "Loomio 3.8 –
// 3.9" below `guardThreadMarkdown`.

/** What the guard's one read learned about the thread. */
interface GuardRead {
  header: ThreadHeader;
  /** The thread's TopicSerializer row; undefined when Loomio sent none. */
  topic: LoomioTopic | undefined;
  /** The read's `polls` root. */
  polls: readonly LoomioPoll[];
  /** The read's `stances` root: on these shows, the user's `my_stance` rows only. */
  stances: readonly LoomioStance[];
  calls: number;
}

/** The header a TopicSerializer row names (`shapeThreadRow`), with `topic_id` set to the thread read. */
function headerFromTopic(
  topicId: number,
  topic: LoomioTopic,
  body: Pick<LoomioSideLoads, "discussions" | "polls">,
): ThreadHeader {
  const row = shapeThreadRow(topic, body);
  const base = {
    topic_id: topicId,
    type: row.type,
    id: row.id,
    key: row.key,
    title: row.title,
    group_id: row.group_id,
  };
  return { ...base, ...headerUrl(base) };
}

/** GET /b2/threads/{topic_id}?compact=1 — the thread's own row, with the 404 reworded. */
async function showThread(topicId: number): Promise<{ body: ThreadsResponse; topic: LoomioTopic }> {
  let body: ThreadsResponse;
  try {
    body = await loomioGet<ThreadsResponse>(`/b2/threads/${topicId}`, readParams("compact"));
  } catch (err) {
    rethrowThreadNotFound(err, topicId);
  }
  const topic = body.threads?.[0];
  if (!topic) {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/threads/${topicId} without a thread row; the response shape is ` +
        "not the one Loomio 3.8.1 produces.",
    );
  }
  return { body, topic };
}

/** The requested poll in a poll show's `polls` root (which may also hold the thread's fronting poll). */
function requestedPoll(polls: readonly LoomioPoll[], ref: string | number): LoomioPoll | undefined {
  const byRef = polls.find((p) =>
    typeof ref === "number" || /^\d+$/.test(ref) ? p.id === Number(ref) : p.key === ref,
  );
  return byRef ?? polls[0];
}

/** One read per reference, with the module's 404 wording (see the guard note). */
async function loadThreadForGuard(ref: ThreadRef): Promise<GuardRead> {
  if (ref.topic_id !== undefined) {
    const { body, topic } = await showThread(ref.topic_id);
    return {
      header: headerFromTopic(ref.topic_id, topic, body),
      topic,
      polls: body.polls ?? [],
      stances: body.stances ?? [],
      calls: 1,
    };
  }
  if (ref.discussion_id !== undefined) {
    let body: DiscussionsResponse;
    try {
      body = await loomioGet<DiscussionsResponse>(
        `/b2/discussions/${encodePathSegment(ref.discussion_id)}`,
        readParams("thread_guard"),
      );
    } catch (err) {
      rethrowRecordNotFound(err, "discussion", ref.discussion_id);
    }
    const d = body.discussions?.[0];
    if (!d || d.topic_id == null) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/discussions/${ref.discussion_id} without a discussion carrying a ` +
          "topic_id; the response shape is not the one Loomio 3.8.1 produces.",
      );
    }
    const topic = (body.topics ?? []).find((t) => t.id === d.topic_id);
    const base = {
      topic_id: d.topic_id,
      type: "Discussion" as const,
      id: d.id,
      key: d.key ?? null,
      title: d.title ?? null,
      group_id: d.group_id ?? null,
    };
    return {
      header: topic ? headerFromTopic(d.topic_id, topic, body) : { ...base, ...headerUrl(base) },
      topic,
      polls: body.polls ?? [],
      stances: body.stances ?? [],
      calls: 1,
    };
  }
  if (ref.poll_id !== undefined) {
    const { body, topic, header } = await showPollThread(ref.poll_id);
    return {
      header,
      topic,
      polls: body.polls ?? [],
      stances: body.stances ?? [],
      calls: 1,
    };
  }
  // The schema's refinement makes this unreachable (see resolveThread).
  throw new Error("get_thread_markdown: pass exactly one of discussion_id, poll_id or topic_id.");
}

/** Loomio's `Poll.active` (poll.rb:213): kept, opened, not closed — what `active_polls_count` counts. */
function isActivePoll(p: Pick<LoomioPoll, "opened_at" | "closed_at" | "discarded_at">): boolean {
  return p.opened_at != null && p.closed_at == null && p.discarded_at == null;
}

type GuardVerdict =
  | { kind: "allow"; checked: number }
  | { kind: "refuse"; polls: LoomioPoll[] }
  | { kind: "scan" };

/** The decision the guard can make from its one read (steps 1-4 of the guard note). */
function guardVerdict(read: GuardRead): GuardVerdict {
  // 1. On these shows the `stances` root holds the user's `my_stance`
  //    rows only, so `showRoot` reads it without an identity.
  const hidden = read.polls.filter((p) =>
    hiddenUntilVote(p, ownStanceFor(p.id, read.stances, { showRoot: true })),
  );
  if (hidden.length > 0) return { kind: "refuse", polls: hidden };
  const topic = read.topic;
  if (!topic) return { kind: "scan" };
  // 2. The fronting poll is what the export's overview renders.
  let front: LoomioPoll | undefined;
  if (topic.topicable_type === "Poll") {
    front = read.polls.find((p) => p.id === topic.topicable_id);
    if (!front) return { kind: "scan" };
  } else if (topic.topicable_type !== "Discussion") {
    return { kind: "scan" };
  }
  // 3. The opening item alone: nothing the read has not already cleared.
  if (typeof topic.items_count === "number" && topic.items_count <= 1) {
    return { kind: "allow", checked: front && isActivePoll(front) ? 1 : 0 };
  }
  // 4.
  return { kind: "scan" };
}

/**
 * Refuse (throw `VisibilityRefusalError`) when the thread holds an open
 * `until_vote` poll the connector's user has not voted in; otherwise
 * return how many upstream calls the check cost beyond the read and how
 * many open polls it checked.
 */
async function guardThreadMarkdown(read: GuardRead): Promise<{ calls: number; checked: number }> {
  const topicId = read.header.topic_id;
  const verdict = guardVerdict(read);
  if (verdict.kind === "refuse") throw VisibilityRefusalError.untilVote(topicId, verdict.polls);
  if (verdict.kind === "allow") return { calls: 0, checked: verdict.checked };

  // Page by page, merging side-loads (each bounded page carries only what
  // its own items reference) and refusing at the first page that shows a
  // hidden poll — its `my_stance` came with it, so later pages cannot
  // change that verdict. Allowing needs the whole thread (guard note).
  // The polls the read already cleared are not judged again: the read's
  // `stances` root is the user's own `my_stance` rows, which an items page
  // mixes with every voter's, so re-judging them here would need the
  // cached identity the read did not.
  const cleared = new Set(read.polls.map((p) => p.id));
  const pager = loomioPager<ThreadItemsResponse>(
    `/b2/threads/${topicId}/items`,
    readParams("items_known_thread"),
    { root: "items", maxPages: MAX_ITEM_SCAN_PAGES },
  );
  const nextPage = () => pager.next().catch((err: unknown) => rethrowThreadNotFound(err, topicId));
  const ownUserId = cachedOwnUserId();
  const polls = new Map<number, LoomioPoll>();
  const stances = new Map<number, LoomioStance>();
  for (let page = await nextPage(); page !== undefined; page = await nextPage()) {
    addNew(polls, page.polls);
    addNew(stances, page.stances);
    const seen = [...stances.values()];
    const offending = [...polls.values()].filter(
      (p) => !cleared.has(p.id) && hiddenUntilVote(p, ownStanceFor(p.id, seen, { ownUserId })),
    );
    if (offending.length > 0) throw VisibilityRefusalError.untilVote(topicId, offending);
  }
  if (pager.state.capped) {
    throw VisibilityRefusalError.unverified(topicId, pager.state.rows, pager.state.total);
  }
  // A vote whose poll arrived on NO page (and was not cleared by the read)
  // cannot be judged — and the export would print it (security review
  // F-15). v0.0.16 judged `polls.values()` only, so such a stance
  // contributed nothing and the document was fetched; list_thread_items
  // treats the same stance as hidden (`visibilityOf`). Stock Loomio 3.13.1
  // side-loads the poll with every stance item (StanceSerializer
  // `has_one :poll`), so this fires only on a serializer change or
  // regression upstream — exactly when the guard must fail closed.
  const unjudged = [
    ...new Set(
      [...stances.values()]
        .map((st) => st.poll_id)
        .filter((id) => typeof id === "number" && !polls.has(id) && !cleared.has(id)),
    ),
  ];
  if (unjudged.length > 0) throw VisibilityRefusalError.pollsMissing(topicId, unjudged);
  return { calls: pager.state.requests, checked: [...polls.values()].filter(isActivePoll).length };
}

// ── Loomio 3.8 – 3.9: the export applies 'until vote' itself ────────────────
//
// The leak the guard closes dates from 3.10.0 (df28cf845). Before it,
// ThreadMarkdownService decided per reader: `poll_results_visible?` was
// `poll.results_visible?(voted:)` with `voted = poll.stances.latest.
// decided.exists?(participant_id: user.id)` (thread_markdown_service.rb:
// 168-172 at v3.8.0 – v3.9.0), `poll_results` printed the "hidden until
// voted" line instead of the table (:117) and `stance_visible?` (:144)
// showed another voter's stance only when results were visible. So on
// 3.8.x / 3.9.x the export withholds exactly what the JSON tools do, and
// the guard would only refuse documents Loomio renders safely — and pay a
// whole-thread read for it. It is skipped there, but ONLY on a version a
// health probe reported within `HEALTH_CACHE_TTL_MS`: an instance
// upgraded to 3.10+ since an old probe must never be exported unguarded.
// A stale "3.8 / 3.9" is refreshed through `checkLoomioHealth()` (the
// shared probe, GET /b2/groups + GET /v1/boot/version, at most once a
// minute however many callers ask). An unknown, unparseable or ≥ 3.10
// version — the case of any up-to-date instance — costs nothing and
// keeps the guard: fail closed. Versions before 3.8, which the connector
// does not serve, are not assumed either way.

/** True for a Loomio version whose Markdown export still applies 'until vote' per reader (3.8.x, 3.9.x). */
export function exportAppliesUntilVote(version: string | null | undefined): boolean {
  const m = typeof version === "string" ? /^v?(\d+)\.(\d+)(?:\D|$)/.exec(version.trim()) : null;
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major === 3 && minor >= 8 && minor < 10;
}

/**
 * Whether the guard can be skipped (see the note above), and how many
 * upstream requests finding out cost: 0 from a fresh cached probe or a
 * version that keeps the guard, 2 when a stale 3.8 / 3.9 verdict had to
 * be re-probed.
 */
async function exportHonoursUntilVote(): Promise<{ honours: boolean; calls: number }> {
  const cached = getCachedHealth();
  if (!cached || !exportAppliesUntilVote(cached.loomio_version)) {
    return { honours: false, calls: 0 };
  }
  if (cachedHealthAgeMs() < HEALTH_CACHE_TTL_MS) return { honours: true, calls: 0 };
  const fresh = await checkLoomioHealth();
  return {
    honours: exportAppliesUntilVote(fresh.loomio_version),
    calls: fresh === cached ? 0 : 2,
  };
}

export async function getThreadMarkdown(
  input: GetThreadMarkdownInput,
): Promise<GetThreadMarkdownResult> {
  const max = input.max_chars ?? DEFAULT_MARKDOWN_MAX_CHARS;
  const read = await loadThreadForGuard(input);
  const header = read.header;
  // F-17: the read named the thread's group; an unlisted one (or none —
  // a direct thread) is refused before the guard scan and the document.
  const own = callerThreadRef(input, header.topic_id);
  assertRecordGroupAllowed(header.group_id, own.what, own.ref);
  const legacy = await exportHonoursUntilVote();
  const guard = legacy.honours ? { calls: 0, checked: 0 } : await guardThreadMarkdown(read);
  let body: { markdown?: unknown };
  try {
    body = await loomioGet<{ markdown?: unknown }>(`/b2/threads/${header.topic_id}/markdown`);
  } catch (err) {
    rethrowThreadNotFound(err, header.topic_id);
  }
  if (typeof body.markdown !== "string") {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/threads/${header.topic_id}/markdown without a markdown string; the ` +
        "response shape is not the one Loomio 3.8.1 produces.",
    );
  }
  const { text, truncated, chars } = truncateText(body.markdown, max);
  return {
    ...header,
    heading: markdownHeading(body.markdown),
    markdown: text ?? "",
    chars,
    truncated,
    scope: {
      max_chars: max,
      upstream_calls: read.calls + legacy.calls + guard.calls + 1,
      open_polls_checked: guard.checked,
      ...(legacy.honours ? { guard_skipped_pre_3_10: true as const } : {}),
      note: MARKDOWN_SCOPE_NOTE,
    },
  };
}

// ── list_threads ────────────────────────────────────────────────────────────

export const listThreadsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_THREADS_LIMIT)
    .optional()
    .describe(`Threads per page, default ${DEFAULT_THREADS_LIMIT}, max ${MAX_THREADS_LIMIT}.`),
  offset: z.number().int().min(0).optional().describe("Threads to skip. Default 0."),
  group_id: positiveId
    .optional()
    .describe("Only this group's threads (client-side; `total` stays instance-wide)."),
  type: z
    .enum(["Discussion", "Poll"])
    .optional()
    .describe("Keep only Discussion or Poll threads (client-side)."),
  since: isoTimestamp.describe("ISO-8601 cutoff on last_activity_at; page until scope.exhausted."),
});

export type ListThreadsInput = z.infer<typeof listThreadsSchema>;

/**
 * The TopicSerializer fields a thread row carries. `members_count` and
 * `closed_polls_count` arrive from Loomio ≤ 3.10 only (3.11.0 dropped
 * them, 79280ee7a) and are kept for those servers; `has_tagged_replies`
 * (3.13+) says `tags` is the union over every tagged contribution.
 */
const THREAD_ROW_FIELDS = [
  "items_count",
  "replies_count",
  "last_activity_at",
  "locked_at",
  "pinned_at",
  "tags",
  "has_tagged_replies",
  "members_count",
  "active_polls_count",
  "closed_polls_count",
] as const;

export interface ThreadRow extends Pick<LoomioTopic, (typeof THREAD_ROW_FIELDS)[number]> {
  topic_id: number;
  type: ThreadType | null;
  /** The discussion's or poll's own id. */
  id: number | null;
  key: string | null;
  title: string | null;
  group_id: number | null;
  author_id: number | null;
  /** Standalone-poll threads only. */
  poll_type?: string;
  closing_at?: string | null;
  closed_at?: string | null;
  url?: string;
}

export interface ListThreadsResult {
  threads: ThreadRow[];
  /**
   * Loomio's `meta.total`: every thread visible to the connector's user,
   * before paging and before the client-side filters. Under
   * LOOMIO_MCP_GROUP_IDS: the matching count when the walk reached the
   * end, else null — never a figure that counts withheld threads.
   */
  total: number | null;
  returned: number;
  scope: {
    limit: number;
    offset: number;
    group_id: number | null;
    type: ThreadType | null;
    /** Threads on the fetched page before the client-side filters; null under an allow-list. */
    page_size: number | null;
    /** The `offset` of the next page, or null when nothing further can match. */
    next_offset: number | null;
    /** The `since` cutoff applied, or null. */
    since: string | null;
    /**
     * With `since`: true when no further page can hold a row newer than
     * the cutoff (the page's last dated row already predates it, or the
     * page was shorter than `limit`); null without `since`.
     */
    exhausted: boolean | null;
    /** With `since`: rows dropped because they carry no last_activity_at (undatable, never counted as exhausted). */
    undated_dropped: number;
    /** Allow-list walk only: the scan limit ended the walk before the window filled. */
    scan_capped?: true;
    note: string;
  };
}

const THREADS_SCOPE_NOTE =
  "Every thread the connector's user can see — member groups' threads plus public threads of public " +
  "groups — newest activity first (Loomio's TopicQuery.visible_to). `total` is that whole set.";

const THREADS_FILTER_NOTE =
  " group_id / type were applied client-side to this page only: `returned` may be smaller than the " +
  "page and `total` still counts every visible thread; page further with offset to see more.";

const THREADS_ALLOWLIST_SCOPE_NOTE =
  "Threads of the groups this deployment serves (LOOMIO_MCP_GROUP_IDS), newest activity first. " +
  "limit / offset count matching threads only (listed groups, then group_id / type / since); " +
  "page with scope.next_offset until it is null. `total` is null unless this call reached the " +
  "end of the set.";

const THREADS_SCAN_CAPPED_NOTE =
  " The scan stopped after its page limit before filling the window: narrow with since or " +
  "group_id, or use list_discussions / list_polls for one group.";

const THREADS_SINCE_NOTE =
  " since was applied client-side: rows older than the cutoff were dropped, rows without a " +
  "last_activity_at were dropped and counted in undated_dropped; page further with offset until " +
  "exhausted is true.";

/**
 * One `threads[]` row joined with the discussion or poll it fronts —
 * looked up in the response's `discussions` / `polls` roots, which a
 * thread read and a discussion / poll show (with `topic` kept) both
 * carry.
 */
export function shapeThreadRow(
  topic: LoomioTopic,
  body: Pick<LoomioSideLoads, "discussions" | "polls">,
): ThreadRow {
  const type: ThreadType | null =
    topic.topicable_type === "Discussion" || topic.topicable_type === "Poll"
      ? topic.topicable_type
      : null;
  const id = topic.topicable_id ?? null;
  const record =
    type === "Discussion" && id != null
      ? indexById(body.discussions).get(id)
      : type === "Poll" && id != null
        ? indexById(body.polls).get(id)
        : undefined;
  const key = record?.key ?? null;
  const title = record?.title ?? null;
  const row: ThreadRow = {
    topic_id: topic.id,
    type,
    id,
    key,
    title,
    group_id: topic.group_id ?? record?.group_id ?? null,
    author_id: record?.author_id ?? null,
    ...pick(topic, THREAD_ROW_FIELDS),
  };
  if (type === "Poll" && record) {
    const poll = record as LoomioPoll;
    if (poll.poll_type !== undefined) row.poll_type = poll.poll_type;
    if (poll.closing_at !== undefined) row.closing_at = poll.closing_at;
    if (poll.closed_at !== undefined) row.closed_at = poll.closed_at;
  }
  const url = threadUrl(type, key, { title });
  return url ? { ...row, url } : row;
}

/**
 * Under LOOMIO_MCP_GROUP_IDS the connector pages Loomio's index itself:
 * this many rows per upstream page, at most this many pages per call
 * (10 Loomio calls, well inside the per-request budget of 120).
 */
export const THREADS_WALK_PAGE = MAX_THREADS_LIMIT;
export const THREADS_WALK_MAX_PAGES = 10;

/** The filters a row must pass to count, in every mode. */
interface RowFilter {
  groupId?: number;
  type?: ThreadType;
  sinceMs?: number;
}

/**
 * Plain mode (no allow-list): one upstream page at the caller's
 * `limit` / `offset`, filtered client-side. Every figure in the reply
 * (`total`, `page_size`) is about threads the caller may see anyway.
 */
async function listThreadsPage(
  limit: number,
  offset: number,
  f: RowFilter,
): Promise<{
  rows: ThreadRow[];
  total: number;
  pageSize: number;
  undated: number;
  exhausted: boolean | null;
  nextOffset: number | null;
}> {
  const body = await loomioGet<ThreadsResponse>("/b2/threads", {
    limit,
    offset,
    // `compact` minus `tag`: compact would strip the `tags` FIELD from
    // every threads[] row (see the module note).
    ...readParams("threads"),
  });
  const page = Array.isArray(body.threads) ? body.threads : [];
  // `since` is a client-side cutoff over rows Loomio already ordered by
  // last_activity_at DESC. A null last_activity_at (a thread with no
  // recorded activity — Postgres puts NULLs FIRST in that order) cannot
  // be dated, so it is dropped and counted rather than passed as "new";
  // and the exhaustion test looks at the page's last DATED row so a null
  // tail never claims the set is exhausted.
  let undated = 0;
  const rows = page
    .map((t) => shapeThreadRow(t, body))
    .filter((r) => f.groupId === undefined || r.group_id === f.groupId)
    .filter((r) => f.type === undefined || r.type === f.type)
    .filter((r) => {
      if (f.sinceMs === undefined) return true;
      if (r.last_activity_at == null) {
        undated += 1;
        return false;
      }
      return Date.parse(r.last_activity_at) >= f.sinceMs;
    });
  let exhausted: boolean | null = null;
  if (f.sinceMs !== undefined) {
    const lastDated = [...page].reverse().find((t) => t.last_activity_at != null)?.last_activity_at;
    exhausted = page.length < limit || (lastDated != null && Date.parse(lastDated) < f.sinceMs);
  }
  return {
    rows,
    total: typeof body.meta?.total === "number" ? body.meta.total : page.length,
    pageSize: page.length,
    undated,
    exhausted,
    nextOffset: page.length < limit || exhausted === true ? null : offset + page.length,
  };
}

/**
 * Allow-list mode (round-2 security finding on F-17). Filtering ONE
 * upstream page leaked what the allow-list hides: Loomio's `meta.total`
 * and the page length counted threads of unlisted groups and direct
 * threads, and a `limit: 1` walk answered returned=0 exactly at each
 * withheld thread's position in the activity order — bracketing when it
 * was active. So here `limit` / `offset` count MATCHING rows only (listed
 * groups ∩ group_id ∩ type ∩ since), the connector walks Loomio's index
 * from the top to fill the window, and nothing in the reply is computed
 * from rows it withheld: no `page_size`, `total` only when the walk
 * reached the end (then it is the matching count), `next_offset` in the
 * same matching-row units. Cost: ≤ THREADS_WALK_MAX_PAGES Loomio calls;
 * a window past that scan reports `scan_capped` instead of guessing.
 */
async function listThreadsWalk(
  limit: number,
  offset: number,
  f: RowFilter,
): Promise<{
  rows: ThreadRow[];
  total: number | null;
  undated: number;
  exhausted: boolean | null;
  nextOffset: number | null;
  scanCapped: boolean;
}> {
  const rows: ThreadRow[] = [];
  let matched = 0;
  let undated = 0;
  let upstreamOffset = 0;
  let reachedEnd = false;
  for (let n = 0; n < THREADS_WALK_MAX_PAGES && !reachedEnd; n += 1) {
    const body = await loomioGet<ThreadsResponse>("/b2/threads", {
      limit: THREADS_WALK_PAGE,
      offset: upstreamOffset,
      ...readParams("threads"),
    });
    const page = Array.isArray(body.threads) ? body.threads : [];
    upstreamOffset += page.length;
    if (page.length < THREADS_WALK_PAGE) reachedEnd = true;
    for (const t of page) {
      const r = shapeThreadRow(t, body);
      if (!isGroupAllowed(r.group_id)) continue;
      if (f.groupId !== undefined && r.group_id !== f.groupId) continue;
      if (f.type !== undefined && r.type !== f.type) continue;
      if (f.sinceMs !== undefined) {
        if (r.last_activity_at == null) {
          // Counted only for listed groups (filtered above), so the
          // figure says nothing about withheld threads.
          undated += 1;
          continue;
        }
        if (Date.parse(r.last_activity_at) < f.sinceMs) {
          // DESC order: every later row is older too, listed or not.
          reachedEnd = true;
          break;
        }
      }
      matched += 1;
      if (matched <= offset) continue;
      if (rows.length === limit) {
        // A (limit+1)-th match exists: more to page, end not reached.
        return {
          rows,
          total: null,
          undated,
          exhausted: f.sinceMs !== undefined ? false : null,
          nextOffset: offset + rows.length,
          scanCapped: false,
        };
      }
      rows.push(r);
    }
  }
  if (!reachedEnd) {
    return {
      rows,
      total: null,
      undated,
      exhausted: f.sinceMs !== undefined ? false : null,
      nextOffset: rows.length > 0 ? offset + rows.length : null,
      scanCapped: true,
    };
  }
  return {
    rows,
    // The whole matching set was seen; with `since` it is the in-window count.
    total: matched,
    undated,
    exhausted: f.sinceMs !== undefined ? true : null,
    nextOffset: null,
    scanCapped: false,
  };
}

export async function listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
  // F-17: an unlisted group is refused; without `group_id` the walk below
  // keeps listed groups only (Loomio's index has no group filter).
  if (input.group_id !== undefined) assertGroupAllowed(input.group_id);
  const limit = input.limit ?? DEFAULT_THREADS_LIMIT;
  const offset = input.offset ?? 0;
  const filter: RowFilter = {
    ...(input.group_id !== undefined ? { groupId: input.group_id } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.since !== undefined ? { sinceMs: Date.parse(input.since) } : {}),
  };
  const allowlist = hasGroupAllowlist();
  const filtered = input.group_id !== undefined || input.type !== undefined;
  const sinceNote = input.since !== undefined ? THREADS_SINCE_NOTE : "";
  if (allowlist) {
    const w = await listThreadsWalk(limit, offset, filter);
    return {
      threads: w.rows,
      total: w.total,
      returned: w.rows.length,
      scope: {
        limit,
        offset,
        group_id: input.group_id ?? null,
        type: input.type ?? null,
        page_size: null,
        next_offset: w.nextOffset,
        since: input.since ?? null,
        exhausted: w.exhausted,
        undated_dropped: w.undated,
        ...(w.scanCapped ? { scan_capped: true as const } : {}),
        note:
          THREADS_ALLOWLIST_SCOPE_NOTE + (w.scanCapped ? THREADS_SCAN_CAPPED_NOTE : "") + sinceNote,
      },
    };
  }
  const p = await listThreadsPage(limit, offset, filter);
  return {
    threads: p.rows,
    total: p.total,
    returned: p.rows.length,
    scope: {
      limit,
      offset,
      group_id: input.group_id ?? null,
      type: input.type ?? null,
      page_size: p.pageSize,
      next_offset: p.nextOffset,
      since: input.since ?? null,
      exhausted: p.exhausted,
      undated_dropped: p.undated,
      note: THREADS_SCOPE_NOTE + (filtered ? THREADS_FILTER_NOTE : "") + sinceNote,
    },
  };
}
