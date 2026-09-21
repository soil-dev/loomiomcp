/**
 * Wire shapes of Loomio 3.8.1's b2 API, as its serializers emit them
 * (app/serializers/*.rb) and as captured from a live instance. These
 * are the INPUT side of the connector: what `loomioGet` hands back
 * before `shape.ts` slims and joins it. The tool layer decides what an
 * AI caller sees; nothing here is returned verbatim.
 *
 * Two conventions, both deliberate:
 *
 *   - Almost everything is optional and every record carries an index
 *     signature. Loomio's serializers hide fields conditionally
 *     (`hide_when_discarded`, `include_<field>?` guards such as a poll's
 *     `results` or a membership's `user_email`) and `exclude_types` /
 *     `compact=1` drop whole side-loaded roots. A shape that promised a
 *     field Loomio may withhold would type-check code that crashes on a
 *     discarded record.
 *   - Collections are one JSON object with the collection under its
 *     root (`discussions`, `polls`, `threads`, `items`, `memberships`,
 *     `groups`, `search_results`) plus SIDE-LOADED roots — `users`,
 *     `topics`, `groups`, `poll_options`, `outcomes`, `stances`,
 *     `comments`, `discussions`, `polls`, `parent_groups`,
 *     `memberships`, `reactions`, `tags` — and a `meta` block. Records
 *     reference side-loads by id (`author_id` → `users[]`, `topic_id` →
 *     `topics[]`), never by nesting. `meta.total` is present only when
 *     the controller set `collection_count` (Api::B2::ResponseOptions
 *     deletes it otherwise): groups index, discussions, polls,
 *     memberships, threads and thread items have it; shows and search
 *     do not.
 */

/** `meta` on every Snorlax response. `total` is exact and pre-pagination when present. */
export interface LoomioMeta {
  root?: string;
  total?: number;
  [key: string]: unknown;
}

/**
 * AuthorSerializer (the `users` root everywhere). `email` appears only
 * when the serializer scope allows it: the user is the API user itself,
 * the caller is an instance admin, or the endpoint opted in.
 */
export interface LoomioUser {
  id: number;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  avatar_initials?: string | null;
  avatar_kind?: string | null;
  thumb_url?: string | null;
  time_zone?: string | null;
  locale?: string | null;
  created_at?: string | null;
  titles?: Record<string, string>;
  delegates?: Record<string, unknown>;
  email_verified?: boolean;
  bot?: boolean;
  [key: string]: unknown;
}

/** GroupSerializer (`groups` and `parent_groups` roots). */
export interface LoomioGroup {
  id: number;
  key?: string;
  handle?: string | null;
  name?: string | null;
  full_name?: string | null;
  description?: string | null;
  description_format?: string | null;
  parent_id?: number | null;
  group_privacy?: "open" | "closed" | "secret" | string;
  is_visible_to_public?: boolean;
  is_visible_to_parent_members?: boolean;
  parent_members_can_see_discussions?: boolean;
  discussion_privacy_options?: "public_only" | "private_only" | "public_or_private" | string;
  memberships_count?: number;
  accepted_memberships_count?: number;
  pending_memberships_count?: number;
  admin_memberships_count?: number;
  discussions_count?: number;
  polls_count?: number;
  closed_polls_count?: number;
  subgroups_count?: number;
  enabled?: boolean;
  discarded_at?: string | null;
  created_at?: string | null;
  creator_id?: number | null;
  attachments?: unknown[];
  link_previews?: unknown[];
  cover_url?: string | null;
  logo_url?: string | null;
  has_custom_cover_photo?: boolean;
  /** Set on the groups index and show for the API user's own row (id into `memberships[]`). */
  current_user_membership_id?: number | null;
  [key: string]: unknown;
}

/** MembershipSerializer. `user_email` only for groups the API user administers, or members it invited. */
export interface LoomioMembership {
  id: number;
  group_id: number;
  user_id: number;
  inviter_id?: number | null;
  admin?: boolean;
  delegate?: boolean;
  title?: string | null;
  created_at?: string | null;
  /** null while the invitation is pending. */
  accepted_at?: string | null;
  user_email?: string | null;
  volume_email?: string | null;
  volume_push?: string | null;
  experiences?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * TopicSerializer (`topics` root on discussion/poll reads, `threads`
 * root on GET /b2/threads). One row per thread; `topicable_type` /
 * `topicable_id` point at the Discussion or Poll it fronts. The
 * `reader_*` / `*_read_*` fields describe the API user's own reading
 * state and are dropped by `shape.ts` (`TOPIC_JOIN_FIELDS`).
 */
export interface LoomioTopic {
  id: number;
  group_id?: number | null;
  topicable_type?: "Discussion" | "Poll" | string;
  topicable_id?: number;
  items_count?: number;
  /** `items_count - 1` (the opening item is not a reply). */
  replies_count?: number;
  last_activity_at?: string | null;
  discarded_at?: string | null;
  locked_at?: string | null;
  locker_id?: number | null;
  pinned_at?: string | null;
  members_count?: number;
  seen_by_count?: number;
  active_polls_count?: number;
  closed_polls_count?: number;
  anonymous_polls_count?: number;
  tags?: string[];
  ranges?: number[][];
  max_depth?: number;
  allow_comments?: boolean;
  allow_reactions?: boolean;
  allow_concurrent_polls?: boolean;
  comment_length_max?: number | null;
  /** Present on side-loaded rows: the id of the record this topic fronts, by type. */
  discussion_id?: number;
  poll_id?: number;
  [key: string]: unknown;
}

/** DiscussionSerializer. `title` and `description` are hidden once discarded. */
export interface LoomioDiscussion {
  id: number;
  key?: string;
  group_id?: number | null;
  topic_id?: number | null;
  title?: string | null;
  description?: string | null;
  description_format?: "html" | "md" | string | null;
  author_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  versions_count?: number;
  discarded_at?: string | null;
  discussion_template_id?: number | null;
  attachments?: unknown[];
  link_previews?: unknown[];
  mentioned_usernames?: string[];
  [key: string]: unknown;
}

export type LoomioHideResults = "off" | "until_vote" | "until_closed";

/**
 * PollSerializer. `results`, `stance_counts`, `total_score` and
 * `stv_results` are emitted whenever `results_available?` — that is,
 * unless `hide_results == until_closed` and the poll is still open. The
 * `until_vote` setting is NOT enforced server-side for an API user who
 * has not voted; `visibility.ts` applies it client-side.
 */
export interface LoomioPoll {
  id: number;
  key?: string;
  title?: string | null;
  details?: string | null;
  details_format?: string | null;
  poll_type?: string;
  group_id?: number | null;
  topic_id?: number | null;
  author_id?: number | null;
  anonymous?: boolean;
  voting_system?: "stance" | "anonymous_ballot" | string;
  hide_results?: LoomioHideResults | string;
  closing_at?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
  discarded_at?: string | null;
  poll_option_names?: string[];
  poll_option_ids?: number[];
  current_outcome_id?: number | null;
  results?: unknown[];
  stance_counts?: number[];
  total_score?: number;
  stv_results?: unknown;
  voters_count?: number;
  decided_voters_count?: number;
  undecided_voters_count?: number;
  cast_stances_pct?: number;
  specified_voters_only?: boolean;
  versions_count?: number;
  [key: string]: unknown;
}

/** PollOptionSerializer (`poll_options` root). Scores live in the poll's `results`, not here. */
export interface LoomioPollOption {
  id: number;
  poll_id: number;
  name?: string | null;
  priority?: number;
  color?: string | null;
  icon?: string | null;
  meaning?: string | null;
  prompt?: string | null;
  [key: string]: unknown;
}

/**
 * StanceSerializer. `participant_id` is null for anonymous polls.
 * `reason`, `option_scores` and `none_of_the_above` are emitted when the
 * stance is the API user's own OR the poll's `results_available?` —
 * again without the `until_vote` gate, see `visibility.ts`.
 */
export interface LoomioStance {
  id: number;
  poll_id: number;
  participant_id?: number | null;
  cast_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  revoked_at?: string | null;
  redacted_at?: string | null;
  latest?: boolean;
  reason?: string | null;
  reason_format?: string | null;
  none_of_the_above?: boolean;
  /** `{ "<poll_option_id>": score }`. */
  option_scores?: Record<string, number>;
  [key: string]: unknown;
}

/** OutcomeSerializer (`outcomes` root). */
export interface LoomioOutcome {
  id: number;
  poll_id: number;
  group_id?: number | null;
  author_id?: number | null;
  poll_option_id?: number | null;
  statement?: string | null;
  statement_format?: string | null;
  latest?: boolean;
  created_at?: string | null;
  review_on?: string | null;
  event_summary?: string | null;
  event_location?: string | null;
  versions_count?: number;
  [key: string]: unknown;
}

/** CommentSerializer (`comments` root). `body` is hidden once discarded. */
export interface LoomioComment {
  id: number;
  topic_id?: number | null;
  body?: string | null;
  body_format?: "html" | "md" | string | null;
  author_id?: number | null;
  parent_id?: number | null;
  parent_type?: "Discussion" | "Poll" | "Comment" | string | null;
  created_at?: string | null;
  updated_at?: string | null;
  discarded_at?: string | null;
  discarded_by?: number | null;
  versions_count?: number;
  attachments?: unknown[];
  link_previews?: unknown[];
  mentioned_usernames?: string[];
  [key: string]: unknown;
}

/**
 * TopicItemSerializer (`items` root of GET /b2/threads/{id}/items).
 * One row per thread event, ordered by `sequence_id`; `kind` is the
 * event kind (`new_discussion`, `new_comment`, `poll_created`,
 * `stance_created`, `outcome_created`, `discussion_edited`, …) and
 * `itemable_type` / `itemable_id` point at the side-loaded record.
 */
export interface LoomioTopicItem {
  id: number;
  topic_id?: number;
  sequence_id?: number;
  position?: number;
  position_key?: string;
  depth?: number;
  child_count?: number;
  kind?: string;
  actor_id?: number | null;
  created_at?: string | null;
  parent_id?: number | null;
  itemable_type?: string | null;
  itemable_id?: number | null;
  pinned?: boolean;
  pinned_title?: string | null;
  /** Pointer into the side-loads, e.g. `{ type: "comment", id: 1700 }`. */
  itemable?: { type?: string; id?: number } | null;
  [key: string]: unknown;
}

/**
 * SearchResultSerializer (`search_results` root of GET /b2/search).
 * `id` is the pg_search document id, NOT a Loomio record id; the record
 * is `searchable_type` + `searchable_id`. `highlight` is HTML with
 * `<b>…</b>` around matches (query mode) or an escaped, 240-char
 * excerpt (author mode).
 */
export interface LoomioSearchResult {
  id: number;
  searchable_type?: "Discussion" | "Comment" | "Poll" | "Stance" | "Outcome" | string;
  searchable_id?: number;
  discussion_title?: string | null;
  discussion_key?: string | null;
  poll_title?: string | null;
  poll_key?: string | null;
  poll_id?: number | null;
  sequence_id?: number | null;
  highlight?: string | null;
  group_id?: number | null;
  group_key?: string | null;
  group_handle?: string | null;
  group_name?: string | null;
  author_id?: number | null;
  author_name?: string | null;
  authored_at?: string | null;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * One row of `users[]` in GET /b2/reports?section=users
 * (ParticipationReportService#users_data, Loomio 3.8.1). Counts are for
 * the requested groups and month window together: `threads` /
 * `comments` / `polls` / `outcomes` authored, `votes` (= `votes_cast`)
 * ballots cast on NON-anonymous polls, `votes_issued` ballots the user
 * was given on those polls (a stance row exists for every invited
 * voter), `votes_missed` = issued − cast, `all_votes_cast` = issued > 0
 * and every one cast, `reactions` given. One row per user holding ANY
 * membership row in the groups — revoked and deactivated included.
 */
export interface LoomioReportUserRow {
  id: number;
  name?: string | null;
  country?: string | null;
  delegate?: boolean;
  threads?: number;
  comments?: number;
  polls?: number;
  votes?: number;
  votes_cast?: number;
  votes_issued?: number;
  votes_missed?: number;
  all_votes_cast?: boolean;
  outcomes?: number;
  reactions?: number;
  [key: string]: unknown;
}

/**
 * GET /b2/reports?section=users — a plain hash, not a Snorlax
 * collection: no `meta`, `compact` / `exclude_types` have no effect.
 * `group_ids` echoes the EFFECTIVE group set (the requested ids
 * intersected with the API user's member groups — Loomio's built-in
 * fence, applied silently); `all_groups` is every group the user could
 * ask about (member groups plus subgroups visible to it), `first_year`
 * the creation year of the oldest of those. The `*_per_user` maps are
 * the same numbers as the rows, keyed by user-id STRINGS.
 */
export interface ReportsUsersResponse {
  first_year?: number;
  all_groups?: Array<{ id: number; name?: string | null }>;
  group_ids?: number[];
  group_scope?: string;
  current_user_is_admin?: boolean;
  users?: LoomioReportUserRow[];
  discussions_per_user?: Record<string, number>;
  comments_per_user?: Record<string, number>;
  polls_per_user?: Record<string, number>;
  outcomes_per_user?: Record<string, number>;
  stances_per_user?: Record<string, number>;
  stances_issued_per_user?: Record<string, number>;
  reactions_per_user?: Record<string, number>;
  tag_threads_per_user?: Record<string, Record<string, number>>;
  tag_threads_authored_per_user?: Record<string, Record<string, number>>;
  [key: string]: unknown;
}

/** The side-loaded roots any b2 read may carry alongside its collection. */
export interface LoomioSideLoads {
  users?: LoomioUser[];
  groups?: LoomioGroup[];
  parent_groups?: LoomioGroup[];
  memberships?: LoomioMembership[];
  topics?: LoomioTopic[];
  discussions?: LoomioDiscussion[];
  polls?: LoomioPoll[];
  poll_options?: LoomioPollOption[];
  stances?: LoomioStance[];
  outcomes?: LoomioOutcome[];
  comments?: LoomioComment[];
  reactions?: unknown[];
  tags?: unknown[];
  meta?: LoomioMeta;
  [key: string]: unknown;
}

/** GET /b2/groups: the API user's member groups plus side-loads. Cached by the health probe. */
export interface GroupsIndexResponse extends LoomioSideLoads {
  groups?: LoomioGroup[];
}

export interface DiscussionsResponse extends LoomioSideLoads {
  discussions?: LoomioDiscussion[];
}

export interface PollsResponse extends LoomioSideLoads {
  polls?: LoomioPoll[];
}

export interface ThreadsResponse extends LoomioSideLoads {
  threads?: LoomioTopic[];
}

export interface ThreadItemsResponse extends LoomioSideLoads {
  items?: LoomioTopicItem[];
}

export interface MembershipsResponse extends LoomioSideLoads {
  memberships?: LoomioMembership[];
}

export interface SearchResponse extends LoomioSideLoads {
  search_results?: LoomioSearchResult[];
}
