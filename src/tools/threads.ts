import { z } from "zod";
import { LoomioApiError, loomioGet, readParams } from "../loomio/client.js";
import { cachedOwnUserId } from "../loomio/health.js";
import {
  indexById,
  pick,
  type SlimUser,
  slimUsers,
  stripBodyHtml,
  threadUrl,
  truncateBody,
  truncateText,
} from "../loomio/shape.js";
import type {
  DiscussionsResponse,
  LoomioComment,
  LoomioOutcome,
  LoomioPoll,
  LoomioPollOption,
  LoomioStance,
  LoomioTopic,
  LoomioTopicItem,
  PollsResponse,
  ThreadItemsResponse,
  ThreadsResponse,
} from "../loomio/types.js";
import {
  type GatedPoll,
  pollResultsVisible,
  ownStanceFor,
  type ResultsVisibility,
  stripHiddenResults,
  stripHiddenStanceResults,
} from "../loomio/visibility.js";
import { encodePathSegment, idOrKey, isoTimestamp, maxCharsSchema, positiveId } from "./_common.js";

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
//   GET /b2/threads/{topic_id}/items EVERY item of the thread ordered by
//                                    sequence_id, UNPAGINATED (no limit /
//                                    offset are read), `meta.total` = count.
//                                    The connector pages client-side.
//   GET /b2/threads/{topic_id}/markdown  {markdown} from
//                                    ThreadMarkdownService: front matter,
//                                    title, body, then every comment, poll
//                                    (with a results table or a "hidden
//                                    until…" line — Loomio applies the
//                                    vote-visibility rule itself here),
//                                    stance and outcome.
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
// in). `compact=1` drops the `topics`, `groups`, `parent_topic_items`,
// `memberships`, `reactions`, `tags` and `translations` roots — none of
// which the items read needs (the counters live on the topic the caller
// already has, and `parent_id` describes the tree). Two variations on
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

/** Default and ceiling for the client-side page over a thread's items. */
export const DEFAULT_ITEMS_LIMIT = 200;
export const MAX_ITEMS_LIMIT = 1000;
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
// a `discussion_id` or `poll_id` costs one `GET /b2/{discussions,polls}/
// {id}?compact=1` to read the record's `topic_id` (compact, because
// only the record itself is needed — the counters come with the thread).
// Callers that already hold a record (from list_discussions,
// list_threads, search_content) should pass its `topic_id` and skip
// that call; the descriptions say so.

const threadRefFields = {
  discussion_id: idOrKey
    .optional()
    .describe("Discussion id or short key (+1 call); prefer `topic_id`."),
  poll_id: idOrKey.optional().describe("Poll id or short key of a STANDALONE poll (+1 call)."),
  topic_id: positiveId
    .optional()
    .describe("Thread id (`topic_id` on any thread row, NOT `id`); no extra call."),
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
 * Resolve a thread reference to its `topic_id`, spending one call for a
 * discussion or poll reference and none for a topic id. The record read
 * along the way fills the header (type, key, title, group) so the tool
 * output can name the thread without a second lookup. Exported for
 * `create_poll`, which needs a discussion's `topic_id` (Loomio's
 * PermittedParams has no `discussion_id` for polls) and its `group_id`
 * (to refuse a poll aimed at one group but attached to a thread of
 * another) — the same one compact GET, the same 404 wording.
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
    let body: ThreadsResponse;
    try {
      body = await loomioGet<ThreadsResponse>(`/b2/threads/${ref.topic_id}`, readParams("compact"));
    } catch (err) {
      rethrowThreadNotFound(err, ref.topic_id);
    }
    const topic = body.threads?.[0];
    if (!topic) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/threads/${ref.topic_id} without a thread row; the response shape is ` +
          "not the one Loomio 3.8.1 produces.",
      );
    }
    const row = shapeThreadRow(topic, body);
    const base = {
      topic_id: ref.topic_id,
      type: row.type,
      id: row.id,
      key: row.key,
      title: row.title,
      group_id: row.group_id,
    };
    return { header: { ...base, ...headerUrl(base) }, calls: 1 };
  }
  if (ref.discussion_id !== undefined) {
    let body: DiscussionsResponse;
    try {
      body = await loomioGet<DiscussionsResponse>(
        `/b2/discussions/${encodePathSegment(ref.discussion_id)}`,
        readParams("compact"),
      );
    } catch (err) {
      if (err instanceof LoomioApiError && err.status === 404) {
        throw notFound("discussion", ref.discussion_id);
      }
      throw err;
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
    let body: PollsResponse;
    try {
      body = await loomioGet<PollsResponse>(
        `/b2/polls/${encodePathSegment(ref.poll_id)}`,
        readParams("compact"),
      );
    } catch (err) {
      if (err instanceof LoomioApiError && err.status === 404) throw notFound("poll", ref.poll_id);
      throw err;
    }
    const p = body.polls?.[0];
    if (!p || p.topic_id == null) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/polls/${ref.poll_id} without a poll carrying a topic_id; the response ` +
          "shape is not the one Loomio 3.8.1 produces.",
      );
    }
    const base = {
      topic_id: p.topic_id,
      type: "Poll" as const,
      id: p.id,
      key: p.key ?? null,
      title: p.title ?? null,
      group_id: p.group_id ?? null,
    };
    return { header: { ...base, ...headerUrl(base) }, calls: 1 };
  }
  // The schema's refinement makes this unreachable; keep the throw so a
  // direct caller gets a message rather than an undefined path segment.
  throw new Error("list_thread_items: pass exactly one of discussion_id, poll_id or topic_id.");
}

const THREAD_NOT_VISIBLE =
  "thread not found or not visible to the connector's user (HTTP 404 from GET /b2/threads/{topic_id}). " +
  "Loomio resolves a thread through TopicQuery.visible_to(user).find, so an unknown topic_id and a " +
  "private thread in a group the user has not joined look the same. Check the topic_id (it is the " +
  "thread id, not the discussion or poll id) and the user's membership.";

/** Re-say a thread route's 404 in terms of what it means (see the module note). */
function rethrowThreadNotFound(err: unknown, topicId: number): never {
  if (err instanceof LoomioApiError && err.status === 404) {
    throw new LoomioApiError(404, `topic_id ${topicId}: ${THREAD_NOT_VISIBLE}`);
  }
  throw err;
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

export type ShapedThreadItem = Pick<LoomioTopicItem, (typeof ITEM_FIELDS)[number]> & {
  /** Only when the item is pinned with a title. */
  pinned_title?: string;
};

/** One item minus its internals (`position_key`, `topic_id`, the redundant `itemable` pointer). */
export function shapeThreadItem(item: LoomioTopicItem): ShapedThreadItem {
  const out: ShapedThreadItem = pick(item, ITEM_FIELDS);
  if (item.pinned && typeof item.pinned_title === "string" && item.pinned_title !== "") {
    out.pinned_title = item.pinned_title;
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
  "voting_system",
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
  Record<string, unknown>;

export function shapeStance(
  stance: LoomioStance,
  visibility: ResultsVisibility,
  bodyMaxChars: number,
  ownUserId: number | undefined,
  stripHtml = false,
): ShapedStance {
  // `stripHiddenStanceResults` types its result with `Omit`, which over a
  // record carrying an index signature (every Loomio type does) collapses
  // to the index signature alone and loses `id: number`. The removed
  // fields are optional on LoomioStance, so reading it as one is exact.
  // A hidden stance has no `reason` left for `stripBodyHtml` to touch.
  const stripped = stripHiddenStanceResults(stance, visibility, { ownUserId }) as LoomioStance;
  const picked: ShapedStance = pick(stripped, STANCE_FIELDS);
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
 */
function completeHeader(header: ThreadHeader, body: ThreadItemsResponse): ThreadHeader {
  if (header.type && header.id != null) return header;
  const items = body.items ?? [];
  const root = items.find((i) => i.sequence_id === 0) ?? items[0];
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
      .array(z.string().min(1))
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
  /** Loomio's `meta.total`: every item in the thread, before the kinds filter and the slice. */
  total: number;
  /** Items that passed the kinds filter (= `total` without a filter). */
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
    /** Upstream requests this call made: 1, or 2 when a discussion_id / poll_id had to be resolved. */
    upstream_calls: number;
    /** The `exclude_types` profile sent with the items request (see src/loomio/client.ts). */
    profile: "compact" | "items_known_thread" | "items_with_reactions";
    /** True when the connector could recognise its own stances (poll results gated exactly); false = it assumed "not voted". */
    own_user_known: boolean;
    note: string;
  };
}

const ITEMS_SCOPE_NOTE =
  "Every item of the thread was fetched once (Loomio's items route is unpaginated) and sliced here; " +
  "comments, polls, stances, outcomes and users are those the returned items reference. The slice " +
  "also stops when the reply would exceed max_total_chars (truncated_by_budget: true; continue at " +
  "next_offset). Poll " +
  "results and other voters' choices are hidden where the poll's hide_results setting hides them " +
  "from a member who has not voted (results_visible / results_hidden_reason on each poll). A " +
  "stance's option_scores is keyed by poll_option ID — resolve the keys through the poll's " +
  "poll_options[] {id, name}; stance_counts[i] is the tally of poll_options[i]. Anonymous polls " +
  "carry participant_id null on every stance — do not try to infer voters.";

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

  const { header: fromRef, calls } = await resolveThread(input);
  const resolved = known && fromRef.type === null ? withKnownThread(fromRef, known) : fromRef;
  // Which side-loads to drop (see the module note): reactions need the
  // opening post's serializer; a known thread does not need the opening
  // post at all; the bare topic_id path needs it to fill the header.
  const headerKnown = resolved.type !== null && resolved.id !== null;
  const profile = includeReactions
    ? "items_with_reactions"
    : headerKnown
      ? "items_known_thread"
      : "compact";
  let body: ThreadItemsResponse;
  try {
    body = await loomioGet<ThreadItemsResponse>(
      `/b2/threads/${resolved.topic_id}/items`,
      readParams(profile),
    );
  } catch (err) {
    rethrowThreadNotFound(err, resolved.topic_id);
  }
  const header = completeHeader(resolved, body);

  const all = Array.isArray(body.items) ? body.items : [];
  const matched = filterKinds(all, input.kinds);
  const page = matched.slice(offset, offset + limit);

  // Visibility per poll, computed over EVERY stance in the response
  // (the user's own may sit outside the slice) with the identity the
  // health probe learned; unknown identity ⇒ "not voted" ⇒ hide.
  const ownUserId = cachedOwnUserId();
  const visibility = new Map<number, ResultsVisibility>();
  for (const p of body.polls ?? []) {
    visibility.set(p.id, pollResultsVisible(p, ownStanceFor(p.id, body.stances, { ownUserId })));
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
  // the slice). Each record enters once however many items point at it.
  // The walk stops BEFORE the item that would overrun `budget` — never
  // before the first, so a single oversized comment (already capped by
  // body_max_chars) is returned rather than nothing.
  const roots = {
    comments: indexById(body.comments),
    polls: indexById(body.polls),
    stances: indexById(body.stances),
    outcomes: indexById(body.outcomes),
  };
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
      shapeItemPoll(p, visibilityOf(p.id), bodyMax, body.poll_options),
    );

  let used = 0;
  let cut = false;
  for (const item of page) {
    const row = shapeThreadItem(item);
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
          shapeStance(raw, visibilityOf(raw.poll_id), bodyMax, ownUserId, stripHtml),
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
      break;
    }
    used += cost;
    items.push(row);
    for (const a of adds) a.add();
  }

  const users = indexById(body.users);
  const wantUsers = new Set<number>();
  for (const item of items) if (item.actor_id != null) wantUsers.add(item.actor_id);
  for (const c of included.comments.values()) if (c.author_id != null) wantUsers.add(c.author_id);
  for (const p of included.polls.values()) if (p.author_id != null) wantUsers.add(p.author_id);
  for (const o of included.outcomes.values()) if (o.author_id != null) wantUsers.add(o.author_id);
  for (const s of included.stances.values()) {
    if (s.participant_id != null) wantUsers.add(s.participant_id);
  }

  const returned = items.length;
  const result: ListThreadItemsResult = {
    ...header,
    items,
    comments: shaped.comments,
    polls: shaped.polls,
    stances: shaped.stances,
    outcomes: shaped.outcomes,
    users: slimUsers([...wantUsers].flatMap((id) => users.get(id) ?? [])),
    total: typeof body.meta?.total === "number" ? body.meta.total : all.length,
    matched: matched.length,
    returned,
    truncated_by_budget: cut,
    next_offset: offset + returned < matched.length ? offset + returned : null,
    scope: {
      offset,
      limit,
      max_total_chars: budget,
      chars: used,
      kinds: input.kinds?.length ? input.kinds : null,
      include_reactions: includeReactions,
      body_max_chars: bodyMax,
      strip_html: stripHtml,
      upstream_calls: calls + 1,
      profile,
      own_user_known: ownUserId !== undefined,
      note: ITEMS_SCOPE_NOTE,
    },
  };
  if (includeReactions) {
    const reactable = new Set<string>();
    for (const id of included.comments.keys()) reactable.add(`Comment:${id}`);
    for (const id of included.stances.keys()) reactable.add(`Stance:${id}`);
    for (const id of included.outcomes.keys()) reactable.add(`Outcome:${id}`);
    for (const id of included.polls.keys()) reactable.add(`Poll:${id}`);
    if (header.type === "Discussion" && header.id != null) reactable.add(`Discussion:${header.id}`);
    result.reactions = (Array.isArray(body.reactions) ? body.reactions : [])
      .flatMap((r) => shapeReaction(r) ?? [])
      .filter((r) => reactable.has(`${r.reactable_type}:${r.reactable_id}`));
  }
  return result;
}

// ── get_thread_markdown ─────────────────────────────────────────────────────

export const getThreadMarkdownSchema = z
  .object({
    ...threadRefFields,
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
  /** The document's `# …` title line (Loomio: "Discussion: <title> · <author> <date>"), locale-dependent wording. */
  heading: string | null;
  markdown: string;
  /** Length of the FULL document in characters. */
  chars: number;
  truncated: boolean;
  scope: { max_chars: number; upstream_calls: number; note: string };
}

const MARKDOWN_SCOPE_NOTE =
  "Rendered by Loomio (ThreadMarkdownService): YAML front matter (group, created, last_activity, " +
  "tags), the thread title and body, then every comment, poll (options, status, and either a results " +
  "table or a 'hidden until…' line — Loomio applies the poll's hide_results rule for the connector's " +
  "user itself), vote and outcome in thread order, headings carrying author and UTC timestamp. " +
  "Discarded items are omitted; anonymous votes never name the voter.";

/** The first Markdown H1 after the front matter, without its `# `. */
export function markdownHeading(markdown: string): string | null {
  const m = /^# (.+)$/m.exec(markdown);
  return m?.[1]?.trim() || null;
}

export async function getThreadMarkdown(
  input: GetThreadMarkdownInput,
): Promise<GetThreadMarkdownResult> {
  const max = input.max_chars ?? DEFAULT_MARKDOWN_MAX_CHARS;
  const { header, calls } = await resolveThread(input);
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
    scope: { max_chars: max, upstream_calls: calls + 1, note: MARKDOWN_SCOPE_NOTE },
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

const THREAD_ROW_FIELDS = [
  "items_count",
  "replies_count",
  "last_activity_at",
  "locked_at",
  "pinned_at",
  "tags",
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
  /** Loomio's `meta.total`: every thread visible to the connector's user, before paging and before the client-side filters. */
  total: number;
  returned: number;
  scope: {
    limit: number;
    offset: number;
    group_id: number | null;
    type: ThreadType | null;
    /** Threads on the fetched page before the client-side filters. */
    page_size: number;
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
    note: string;
  };
}

const THREADS_SCOPE_NOTE =
  "Every thread the connector's user can see — member groups' threads plus public threads of public " +
  "groups — newest activity first (Loomio's TopicQuery.visible_to). `total` is that whole set.";

const THREADS_FILTER_NOTE =
  " group_id / type were applied client-side to this page only: `returned` may be smaller than the " +
  "page and `total` still counts every visible thread; page further with offset to see more.";

const THREADS_SINCE_NOTE =
  " since was applied client-side: rows older than the cutoff were dropped, rows without a " +
  "last_activity_at were dropped and counted in undated_dropped; page further with offset until " +
  "exhausted is true.";

/** One `threads[]` row joined with the discussion or poll it fronts. */
export function shapeThreadRow(topic: LoomioTopic, body: ThreadsResponse): ThreadRow {
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

export async function listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
  const limit = input.limit ?? DEFAULT_THREADS_LIMIT;
  const offset = input.offset ?? 0;
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
  const sinceMs = input.since !== undefined ? Date.parse(input.since) : undefined;
  let undated = 0;
  const rows = page
    .map((t) => shapeThreadRow(t, body))
    .filter((r) => input.group_id === undefined || r.group_id === input.group_id)
    .filter((r) => input.type === undefined || r.type === input.type)
    .filter((r) => {
      if (sinceMs === undefined) return true;
      if (r.last_activity_at == null) {
        undated += 1;
        return false;
      }
      return Date.parse(r.last_activity_at) >= sinceMs;
    });
  let exhausted: boolean | null = null;
  if (sinceMs !== undefined) {
    const lastDated = [...page].reverse().find((t) => t.last_activity_at != null)?.last_activity_at;
    exhausted = page.length < limit || (lastDated != null && Date.parse(lastDated) < sinceMs);
  }
  const filtered = input.group_id !== undefined || input.type !== undefined;
  const note =
    THREADS_SCOPE_NOTE +
    (filtered ? THREADS_FILTER_NOTE : "") +
    (sinceMs !== undefined ? THREADS_SINCE_NOTE : "");
  return {
    threads: rows,
    total: typeof body.meta?.total === "number" ? body.meta.total : page.length,
    returned: rows.length,
    scope: {
      limit,
      offset,
      group_id: input.group_id ?? null,
      type: input.type ?? null,
      page_size: page.length,
      since: input.since ?? null,
      exhausted,
      undated_dropped: undated,
      note,
    },
  };
}
