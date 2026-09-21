/**
 * Anonymised Loomio 3.8.1 response fixtures for the tool tests.
 *
 * Field names, nesting, which roots each endpoint side-loads and where
 * `meta.total` appears follow live captures from a 3.8.1 instance
 * (GET /b2/groups, /b2/groups/{id}, /b2/discussions[?exclude_types],
 * /b2/discussions/{id}, /b2/polls, /b2/memberships?compact=1). Every
 * id, name, handle, title and body is illustrative. Builders take
 * overrides so a test states only what it is about.
 */

import type {
  DiscussionsResponse,
  GroupsIndexResponse,
  LoomioComment,
  LoomioDiscussion,
  LoomioGroup,
  LoomioMembership,
  LoomioOutcome,
  LoomioPoll,
  LoomioPollOption,
  LoomioReportUserRow,
  LoomioSearchResult,
  LoomioStance,
  LoomioTopic,
  LoomioTopicItem,
  LoomioUser,
  MembershipsResponse,
  PollsResponse,
  ReportsUsersResponse,
  SearchResponse,
  ThreadItemsResponse,
  ThreadsResponse,
} from "../src/loomio/types.js";

// ── Users (AuthorSerializer) ────────────────────────────────────────────────

/** The connector's own user: a bot account. Loomio includes its email on its own row. */
export const ADA: LoomioUser = {
  id: 501,
  name: "Ada Example",
  email: "ada@example.org",
  username: "ada",
  avatar_initials: "AE",
  avatar_kind: "initials",
  thumb_url: null,
  time_zone: "Europe/Prague",
  locale: "en",
  created_at: "2026-05-27T12:00:27.532Z",
  titles: {},
  delegates: {},
  email_verified: true,
  bot: true,
};

export const GRACE: LoomioUser = {
  id: 502,
  name: "Grace Sample",
  username: "grace",
  avatar_initials: "GS",
  avatar_kind: "uploaded",
  thumb_url: "/example.png",
  time_zone: "Europe/Prague",
  locale: "en",
  created_at: "2024-10-19T02:52:23.311Z",
  titles: { "7": "Operations", "12": "Treasurer" },
  delegates: {},
  email_verified: true,
  bot: false,
};

export const LINUS: LoomioUser = {
  id: 503,
  name: "Linus Placeholder",
  username: "linus",
  avatar_initials: "LP",
  avatar_kind: "uploaded",
  thumb_url: "/example.png",
  time_zone: "America/Los_Angeles",
  locale: "en",
  created_at: "2024-11-30T17:26:11.843Z",
  titles: {},
  delegates: {},
  email_verified: true,
  bot: false,
};

// ── Groups (GroupSerializer) ────────────────────────────────────────────────

export function groupRow(overrides: Partial<LoomioGroup> = {}): LoomioGroup {
  return {
    id: 7,
    key: "grpKEY07",
    handle: "example-org",
    name: "Example Org",
    full_name: "Example Org",
    content_locale: "en",
    description: "<p>The umbrella group for everything at Example Org.</p>",
    description_format: "html",
    logo_url: null,
    created_at: "2024-10-19T09:55:12.778Z",
    creator_id: 502,
    members_can_add_members: false,
    members_can_add_guests: false,
    members_can_announce: false,
    members_can_create_subgroups: false,
    members_can_create_tags: true,
    members_can_start_discussions: true,
    non_members_can_start_discussions: false,
    members_can_edit_discussions: false,
    members_can_edit_comments: false,
    members_can_delete_comments: false,
    members_can_raise_motions: false,
    members_can_create_templates: false,
    admins_can_edit_user_content: true,
    polls_count: 2,
    poll_templates_count: 0,
    closed_polls_count: 1,
    discussions_count: 21,
    group_privacy: "open",
    listed_in_explore: true,
    memberships_count: 12,
    delegates_count: 0,
    pending_memberships_count: 0,
    accepted_memberships_count: 12,
    membership_granted_upon: "invitation",
    discussion_privacy_options: "public_only",
    admin_memberships_count: 7,
    discarded_at: null,
    discarded_by: null,
    enabled: true,
    attachments: [],
    link_previews: [
      {
        url: "https://example.org/about",
        title: "About Example Org",
        image: "/example.png",
        hostname: "example.org",
        description: "What Example Org does.",
        fit: "contain",
        align: "center",
      },
    ],
    has_custom_cover_photo: true,
    cover_url: "/example.png",
    discussion_templates_count: 1,
    is_visible_to_public: true,
    is_visible_to_parent_members: false,
    parent_members_can_see_discussions: true,
    org_discussions_count: 436,
    org_members_count: 395,
    subscription: {
      max_members: null,
      max_threads: null,
      allow_subgroups: true,
      plan: "free",
      state: "active",
      active: true,
      renews_at: null,
      expires_at: null,
      members_count: null,
    },
    subgroups_count: 3,
    new_host: null,
    categorize_poll_templates: true,
    category: null,
    request_to_join_prompt: null,
    current_user_followed: false,
    parent_id: null,
    current_user_membership_id: 9007,
    tag_ids: [71, 120],
    ...overrides,
  };
}

/** A subgroup of Example Org. */
export const FINANCE = groupRow({
  id: 12,
  key: "grpKEY12",
  handle: "example-org-finance",
  name: "Finance Team",
  full_name: "Example Org - Finance Team",
  description: "<p>Budget, treasury and grants.</p>",
  parent_id: 7,
  polls_count: 9,
  closed_polls_count: 7,
  discussions_count: 32,
  memberships_count: 8,
  accepted_memberships_count: 8,
  admin_memberships_count: 3,
  subgroups_count: 0,
  listed_in_explore: false,
  current_user_membership_id: 9012,
});

/** A subgroup the connector's user has been INVITED to but has not accepted. */
export const VOLUNTEERS = groupRow({
  id: 15,
  key: "grpKEY15",
  handle: "example-org-volunteers",
  name: "Volunteers",
  full_name: "Example Org - Volunteers",
  description: "<p>Event helpers.</p>",
  parent_id: 7,
  group_privacy: "closed",
  is_visible_to_public: false,
  discussion_privacy_options: "private_only",
  memberships_count: 30,
  pending_memberships_count: 1,
  accepted_memberships_count: 29,
  subgroups_count: 0,
  current_user_membership_id: 9015,
});

export const EXAMPLE_ORG = groupRow();

// ── Memberships (MembershipSerializer; own rows carry volume_* ) ────────────

export function membershipRow(overrides: Partial<LoomioMembership> = {}): LoomioMembership {
  return {
    id: 9007,
    group_id: 7,
    user_id: 501,
    inviter_id: 502,
    volume_email: "normal",
    volume_push: "normal",
    admin: false,
    delegate: false,
    experiences: {},
    title: null,
    created_at: "2026-05-27T13:18:28.444Z",
    accepted_at: "2026-05-27T13:18:57.456Z",
    ...overrides,
  };
}

export const OWN_MEMBERSHIPS: LoomioMembership[] = [
  membershipRow(),
  membershipRow({ id: 9012, group_id: 12, admin: true, title: "Connector" }),
  membershipRow({ id: 9015, group_id: 15, accepted_at: null }),
];

/** GET /b2/groups?exclude_types=tag translation — member groups, their parents, own membership rows, users, meta.total. */
export function groupsIndexBody(overrides: Partial<GroupsIndexResponse> = {}): GroupsIndexResponse {
  return {
    groups: [FINANCE, EXAMPLE_ORG, VOLUNTEERS],
    parent_groups: [EXAMPLE_ORG],
    memberships: OWN_MEMBERSHIPS,
    users: [ADA, GRACE],
    meta: { root: "groups", total: 3 },
    ...overrides,
  };
}

/** GET /b2/groups/{id}?exclude_types=tag translation — one group, its parent, the own membership row. No meta.total. */
export function groupShowBody(
  group: LoomioGroup = FINANCE,
  overrides: Partial<GroupsIndexResponse> = {},
): GroupsIndexResponse {
  const own = OWN_MEMBERSHIPS.find((m) => m.group_id === group.id);
  return {
    parent_groups: group.parent_id === 7 ? [EXAMPLE_ORG] : [],
    memberships: own ? [own] : [],
    groups: [group],
    users: [ADA, GRACE],
    meta: { root: "groups" },
    ...overrides,
  };
}

// ── Topics (TopicSerializer) ────────────────────────────────────────────────

export function topicRow(overrides: Partial<LoomioTopic> = {}): LoomioTopic {
  return {
    id: 701,
    group_id: 7,
    items_count: 9,
    replies_count: 8,
    ranges: [[0, 8]],
    max_depth: 3,
    allow_concurrent_polls: false,
    allow_comments: true,
    allow_reactions: true,
    comment_length_max: null,
    active_polls_count: 0,
    last_activity_at: "2026-08-15T09:03:41.491Z",
    discarded_at: null,
    locked_at: null,
    locker_id: null,
    pinned_at: "2026-05-29T11:28:24.096Z",
    topicable_id: 601,
    topicable_type: "Discussion",
    members_count: 369,
    anonymous_polls_count: 0,
    closed_polls_count: 0,
    seen_by_count: 103,
    tags: ["guide"],
    reader_volume_email: "normal",
    reader_volume_push: "normal",
    last_read_at: null,
    dismissed_at: null,
    read_ranges: [],
    reader_inviter_id: null,
    reader_guest: false,
    reader_admin: false,
    discussion_id: 601,
    ...overrides,
  };
}

// ── Discussions (DiscussionSerializer) ──────────────────────────────────────

export const LONG_HTML = `<p>${"Budget planning for next year. ".repeat(80)}</p>`;

export function discussionRow(overrides: Partial<LoomioDiscussion> = {}): LoomioDiscussion {
  return {
    id: 601,
    key: "dscKEY01",
    group_id: 7,
    topic_id: 701,
    title: "Budget planning for 2027",
    content_locale: "en",
    description: LONG_HTML,
    description_format: "html",
    discussion_template_id: 11,
    created_at: "2026-05-29T11:25:57.740Z",
    updated_at: "2026-06-25T09:14:34.050Z",
    versions_count: 4,
    attachments: [{ id: 1, filename: "budget.pdf" }],
    link_previews: [],
    discarded_at: null,
    author_id: 502,
    ...overrides,
  };
}

export const DISCUSSION_2 = discussionRow({
  id: 602,
  key: "dscKEY02",
  topic_id: 702,
  title: "How to nominate a candidate",
  description: "<p>Short guide.</p>",
  versions_count: 0,
  attachments: [],
  author_id: 503,
});

export const TOPIC_702 = topicRow({
  id: 702,
  items_count: 1,
  replies_count: 0,
  ranges: [[0, 0]],
  last_activity_at: "2026-08-03T23:53:13.598Z",
  pinned_at: null,
  topicable_id: 602,
  members_count: 27,
  seen_by_count: 26,
  tags: [],
  discussion_id: 602,
});

/** GET /b2/discussions?group_id=7&status=open&exclude_types=<list profile> — no groups root, topics + users kept, meta.total. */
export function discussionsListBody(
  overrides: Partial<DiscussionsResponse> = {},
): DiscussionsResponse {
  return {
    users: [GRACE, LINUS],
    topics: [topicRow(), TOPIC_702],
    discussions: [discussionRow(), DISCUSSION_2],
    meta: { root: "discussions", total: 13 },
    ...overrides,
  };
}

/** GET /b2/discussions/601?exclude_types=<show profile> — groups root kept, no meta.total. */
export function discussionShowBody(
  overrides: Partial<DiscussionsResponse> = {},
): DiscussionsResponse {
  return {
    users: [GRACE],
    topics: [topicRow()],
    discussions: [discussionRow()],
    groups: [EXAMPLE_ORG],
    meta: { root: "discussions" },
    ...overrides,
  };
}

// ── Polls (PollSerializer + poll_options / outcomes / stances roots) ────────

export function pollRow(overrides: Partial<LoomioPoll> = {}): LoomioPoll {
  return {
    id: 301,
    limit_reason_length: true,
    attachments: [],
    agree_target: null,
    author_id: 502,
    anonymous: false,
    legacy_anonymous_vote_reasons_count: 0,
    voting_system: "stance",
    can_respond_maybe: false,
    chart_type: "pie",
    chart_column: "score_percent",
    closed_at: null,
    closing_at: "2026-10-01T12:00:00Z",
    opening_at: null,
    opened_at: "2026-09-01T12:00:00Z",
    created_at: "2026-09-01T12:00:00Z",
    content_locale: null,
    cast_stances_pct: 40,
    decided_voters_count: 4,
    details: "<p>Shall we adopt the proposed budget?</p>",
    details_format: "html",
    discarded_at: null,
    discarded_by: null,
    hide_results: "off",
    key: "polKEY01",
    link_previews: [],
    mentioned_usernames: [],
    notify_on_closing_soon: "nobody",
    notify_on_open: true,
    poll_type: "proposal",
    poll_option_names: ["agree", "disagree", "abstain"],
    poll_option_name_format: "plain",
    results: [
      { id: 1, poll_id: 301, name: "agree", score: 3, voter_ids: [502, 503, 504], voter_count: 3 },
      { id: 2, poll_id: 301, name: "disagree", score: 1, voter_ids: [505], voter_count: 1 },
      { id: 3, poll_id: 301, name: "abstain", score: 0, voter_ids: [], voter_count: 0 },
      { id: -1, poll_id: 301, name: "undecided", score: 0, voter_ids: [506, 507], voter_count: 2 },
    ],
    result_columns: ["chart", "name", "votes", "votes_cast_percent", "voter_percent", "voters"],
    reason_prompt: null,
    shuffle_options: false,
    show_none_of_the_above: false,
    stance_counts: [3, 1, 0],
    specified_voters_only: false,
    total_score: 4,
    title: "Adopt the 2027 budget?",
    undecided_voters_count: 2,
    voters_count: 6,
    stance_reason_required: "optional",
    versions_count: 1,
    dots_per_person: 1,
    max_score: 1,
    min_score: 1,
    minimum_stance_choices: 1,
    maximum_stance_choices: 1,
    meeting_duration: null,
    stv_seats: null,
    stv_method: null,
    stv_quota: null,
    poll_template_id: null,
    poll_template_key: null,
    quorum_pct: null,
    quorum_count: 0,
    quorum_votes_required: 0,
    topic_id: 711,
    group_id: 7,
    current_outcome_id: null,
    poll_option_ids: [1, 2, 3],
    ...overrides,
  };
}

export const POLL_TOPIC = topicRow({
  id: 711,
  items_count: 3,
  replies_count: 2,
  ranges: [[0, 2]],
  active_polls_count: 1,
  last_activity_at: "2026-09-10T08:00:00Z",
  pinned_at: null,
  topicable_id: 301,
  topicable_type: "Poll",
  members_count: 12,
  seen_by_count: 9,
  tags: ["budget"],
  poll_id: 301,
});

export function pollOptionRow(overrides: Partial<LoomioPollOption> = {}): LoomioPollOption {
  return {
    id: 1,
    poll_id: 301,
    name: "agree",
    priority: 0,
    color: "#4caf50",
    icon: "agree",
    meaning: "I support this",
    prompt: null,
    test_operator: null,
    test_percent: null,
    test_against: null,
    ...overrides,
  };
}

export const POLL_OPTIONS: LoomioPollOption[] = [
  pollOptionRow({ id: 3, name: "abstain", priority: 2, icon: "abstain", meaning: null }),
  pollOptionRow(),
  pollOptionRow({ id: 2, name: "disagree", priority: 1, icon: "disagree", meaning: "I object" }),
];

export function outcomeRow(overrides: Partial<LoomioOutcome> = {}): LoomioOutcome {
  return {
    id: 801,
    statement: "<p>Adopted with three votes in favour.</p>",
    statement_format: "html",
    content_locale: null,
    latest: true,
    created_at: "2026-10-01T13:00:00Z",
    event_summary: null,
    event_location: null,
    attachments: [],
    link_previews: [],
    review_on: null,
    poll_id: 301,
    poll_option_id: 1,
    group_id: 7,
    author_id: 502,
    versions_count: 0,
    ...overrides,
  };
}

/** The API user's own stance (`my_stance` side-load, `stances` root). */
export function ownStanceRow(overrides: Partial<LoomioStance> = {}): LoomioStance {
  return {
    id: 901,
    none_of_the_above: false,
    reason: "Looks sound.",
    reason_format: "md",
    content_locale: null,
    latest: true,
    cast_at: "2026-09-05T10:00:00Z",
    mentioned_usernames: [],
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
    locale: "en",
    versions_count: 1,
    attachments: [],
    link_previews: [],
    inviter_id: null,
    poll_id: 301,
    participant_id: 501,
    revoked_at: null,
    redacted_at: null,
    redactor_id: null,
    order_at: "2026-09-05T10:00:00Z",
    option_scores: { "1": 1 },
    ...overrides,
  };
}

/** GET /b2/polls?group_id=7&status=active&exclude_types=<list profile>. */
export function pollsListBody(overrides: Partial<PollsResponse> = {}): PollsResponse {
  return {
    users: [GRACE],
    outcomes: [],
    topics: [POLL_TOPIC],
    polls: [pollRow()],
    poll_options: POLL_OPTIONS,
    meta: { root: "polls", total: 1 },
    ...overrides,
  };
}

/** GET /b2/polls/301?exclude_types=<show profile> — groups root kept, no meta.total. */
export function pollShowBody(overrides: Partial<PollsResponse> = {}): PollsResponse {
  return {
    users: [GRACE],
    outcomes: [],
    topics: [POLL_TOPIC],
    polls: [pollRow()],
    poll_options: POLL_OPTIONS,
    groups: [EXAMPLE_ORG],
    meta: { root: "polls" },
    ...overrides,
  };
}

// ── Memberships index (compact=1) ───────────────────────────────────────────

/** GET /b2/memberships?group_id=7&compact=1 — roots memberships, users, meta only; `user_email` only for admin groups. */
export function membershipsListBody(
  overrides: Partial<MembershipsResponse> = {},
): MembershipsResponse {
  return {
    memberships: [
      {
        id: 3,
        group_id: 7,
        user_id: 502,
        inviter_id: null,
        admin: true,
        delegate: false,
        experiences: {},
        title: "Operations",
        created_at: "2024-10-19T09:55:12.970Z",
        accepted_at: "2024-10-19T09:55:12.964Z",
      },
      {
        id: 61,
        group_id: 7,
        user_id: 503,
        inviter_id: 502,
        admin: false,
        delegate: true,
        experiences: {},
        title: null,
        created_at: "2024-11-30T17:26:12.000Z",
        accepted_at: "2024-12-01T08:00:00.000Z",
      },
    ],
    users: [GRACE, LINUS],
    meta: { root: "memberships", total: 12 },
    ...overrides,
  };
}

// ── Threads index (GET /b2/threads?compact=1) ───────────────────────────────
//
// `threads` root = TopicSerializer rows; `discussions` / `polls` hold the
// fronted records; no groups / topics roots under compact.

/** A standalone poll in the Finance subgroup, fronting its own thread. */
export const STANDALONE_POLL = pollRow({
  id: 302,
  key: "polKEY02",
  title: "Pick a date for the budget meeting",
  poll_type: "meeting",
  topic_id: 712,
  group_id: 12,
  closing_at: "2026-10-05T12:00:00Z",
  poll_option_names: ["Mon 5 Oct", "Tue 6 Oct"],
  poll_option_ids: [11, 12],
  results: [],
  stance_counts: [0, 0],
  total_score: 0,
  voters_count: 8,
  decided_voters_count: 0,
  undecided_voters_count: 8,
});

export const STANDALONE_POLL_TOPIC = topicRow({
  id: 712,
  group_id: 12,
  items_count: 3,
  replies_count: 2,
  ranges: [[0, 2]],
  active_polls_count: 1,
  last_activity_at: "2026-09-12T08:00:00Z",
  pinned_at: null,
  topicable_id: 302,
  topicable_type: "Poll",
  members_count: 8,
  seen_by_count: 5,
  tags: [],
  discussion_id: undefined,
  poll_id: 302,
});

export function threadsIndexBody(overrides: Partial<ThreadsResponse> = {}): ThreadsResponse {
  return {
    users: [GRACE, LINUS],
    discussions: [discussionRow(), DISCUSSION_2],
    polls: [STANDALONE_POLL],
    outcomes: [],
    poll_options: [],
    threads: [topicRow(), TOPIC_702, STANDALONE_POLL_TOPIC],
    meta: { root: "threads", total: 467 },
    ...overrides,
  };
}

// ── Thread items (GET /b2/threads/{topic_id}/items?compact=1) ───────────────
//
// `items` root = TopicItemSerializer rows ordered by sequence_id, each
// pointing at its record in `discussions` / `comments` / `polls` /
// `stances` / `outcomes`; actors in `users`; `meta.total` = item count.

export function topicItemRow(overrides: Partial<LoomioTopicItem> = {}): LoomioTopicItem {
  return {
    id: 7001,
    sequence_id: 0,
    position: 0,
    depth: 0,
    child_count: 3,
    kind: "new_discussion",
    topic_id: 701,
    created_at: "2026-05-29T11:25:58.755Z",
    itemable_id: 601,
    itemable_type: "Discussion",
    pinned: false,
    pinned_title: null,
    parent_id: null,
    actor_id: 502,
    position_key: "00000",
    itemable: { type: "discussion", id: 601 },
    ...overrides,
  };
}

export function commentRow(overrides: Partial<LoomioComment> = {}): LoomioComment {
  return {
    id: 1701,
    body: "<p>First reply: the draft looks reasonable.</p>",
    body_format: "html",
    topic_id: 701,
    created_at: "2026-06-01T08:31:10.169Z",
    updated_at: "2026-06-01T08:31:10.169Z",
    parent_id: 601,
    parent_type: "Discussion",
    content_locale: "en",
    versions_count: 0,
    attachments: [],
    link_previews: [],
    author_id: 503,
    discarded_at: null,
    discarded_by: null,
    ...overrides,
  };
}

export const LONG_MD = `Status update. ${"More detail follows here. ".repeat(60)}`;

export const THREAD_COMMENTS: LoomioComment[] = [
  commentRow(),
  commentRow({
    id: 1702,
    body: LONG_MD,
    body_format: "md",
    mentioned_usernames: [],
    author_id: 502,
    created_at: "2026-06-16T19:15:26.410Z",
    updated_at: "2026-06-16T19:15:26.410Z",
    attachments: [{ id: 9, filename: "chart.png" }],
  }),
  commentRow({
    id: 1703,
    body: "<p>Replying to the first reply.</p>",
    parent_id: 1701,
    parent_type: "Comment",
    author_id: 503,
    created_at: "2026-06-18T14:03:30.351Z",
    updated_at: "2026-06-18T14:03:30.351Z",
  }),
];

function commentItem(
  overrides: Partial<LoomioTopicItem> & { id: number; sequence_id: number; itemable_id: number },
): LoomioTopicItem {
  return topicItemRow({
    position: overrides.sequence_id,
    depth: 1,
    child_count: 0,
    kind: "new_comment",
    itemable_type: "Comment",
    parent_id: 7001,
    position_key: `00000-0000${overrides.sequence_id}`,
    itemable: { type: "comment", id: overrides.itemable_id },
    ...overrides,
  });
}

/** A discussion thread: opening item, three comments (one nested), one edit. */
export const THREAD_ITEMS: LoomioTopicItem[] = [
  topicItemRow({ child_count: 4 }),
  commentItem({
    id: 7002,
    sequence_id: 1,
    itemable_id: 1701,
    actor_id: 503,
    child_count: 1,
    created_at: "2026-06-01T08:31:10.220Z",
  }),
  commentItem({
    id: 7003,
    sequence_id: 2,
    itemable_id: 1702,
    actor_id: 502,
    created_at: "2026-06-16T19:15:26.445Z",
  }),
  commentItem({
    id: 7004,
    sequence_id: 3,
    itemable_id: 1703,
    actor_id: 503,
    depth: 2,
    parent_id: 7002,
    position_key: "00000-00001-00001",
    created_at: "2026-06-18T14:03:30.431Z",
  }),
  topicItemRow({
    id: 7005,
    sequence_id: 4,
    position: 4,
    depth: 1,
    child_count: 0,
    kind: "discussion_edited",
    parent_id: 7001,
    actor_id: 502,
    position_key: "00000-00004",
    created_at: "2026-06-25T09:14:34.050Z",
  }),
];

export function threadItemsBody(overrides: Partial<ThreadItemsResponse> = {}): ThreadItemsResponse {
  return {
    users: [GRACE, LINUS],
    discussions: [discussionRow()],
    comments: THREAD_COMMENTS,
    items: THREAD_ITEMS,
    meta: { root: "items", total: 5 },
    ...overrides,
  };
}

/** Another voter's stance on poll 301 (StanceSerializer with results available). */
export function voterStanceRow(overrides: Partial<LoomioStance> = {}): LoomioStance {
  return ownStanceRow({
    id: 902,
    participant_id: 503,
    reason: "I object to the reserve figure.",
    option_scores: { "2": 1 },
    cast_at: "2026-09-06T10:00:00Z",
    order_at: "2026-09-06T10:00:00Z",
    ...overrides,
  });
}

/** Poll 301 as it sits inside discussion 601's thread, results hidden until the reader votes. */
export const ITEM_POLL = pollRow({
  hide_results: "until_vote",
  topic_id: 701,
  current_outcome_id: 801,
});

/** The same discussion thread with a poll, two votes (one the connector user's own) and an outcome. */
export const POLL_THREAD_ITEMS: LoomioTopicItem[] = [
  topicItemRow({ child_count: 1 }),
  topicItemRow({
    id: 7010,
    sequence_id: 1,
    position: 1,
    depth: 1,
    child_count: 3,
    kind: "poll_created",
    itemable_type: "Poll",
    itemable_id: 301,
    parent_id: 7001,
    actor_id: 502,
    position_key: "00000-00001",
    itemable: { type: "poll", id: 301 },
    created_at: "2026-09-01T12:00:00Z",
  }),
  topicItemRow({
    id: 7011,
    sequence_id: 2,
    position: 1,
    depth: 2,
    child_count: 0,
    kind: "stance_created",
    itemable_type: "Stance",
    itemable_id: 902,
    parent_id: 7010,
    actor_id: 503,
    position_key: "00000-00001-00001",
    itemable: { type: "stance", id: 902 },
    created_at: "2026-09-06T10:00:00Z",
  }),
  topicItemRow({
    id: 7012,
    sequence_id: 3,
    position: 2,
    depth: 2,
    child_count: 0,
    kind: "stance_created",
    itemable_type: "Stance",
    itemable_id: 901,
    parent_id: 7010,
    actor_id: 501,
    position_key: "00000-00001-00002",
    itemable: { type: "stance", id: 901 },
    created_at: "2026-09-05T10:00:00Z",
  }),
  topicItemRow({
    id: 7013,
    sequence_id: 4,
    position: 3,
    depth: 2,
    child_count: 0,
    kind: "outcome_created",
    itemable_type: "Outcome",
    itemable_id: 801,
    parent_id: 7010,
    actor_id: 502,
    position_key: "00000-00001-00003",
    itemable: { type: "outcome", id: 801 },
    created_at: "2026-10-01T13:00:00Z",
  }),
];

export function pollThreadItemsBody(
  overrides: Partial<ThreadItemsResponse> = {},
): ThreadItemsResponse {
  return {
    users: [ADA, GRACE, LINUS],
    discussions: [discussionRow()],
    polls: [ITEM_POLL],
    poll_options: POLL_OPTIONS,
    stances: [voterStanceRow(), ownStanceRow()],
    outcomes: [outcomeRow()],
    items: POLL_THREAD_ITEMS,
    meta: { root: "items", total: 5 },
    ...overrides,
  };
}

/** GET /b2/threads/{topic_id}/markdown — the document Loomio renders. */
export const THREAD_MARKDOWN = [
  "---",
  'group: "Example Org"',
  'created: "2026-05-29T11:25:57Z"',
  'last_activity: "2026-08-15T09:03:41Z"',
  'tags: ["guide"]',
  "---",
  "",
  "# Discussion: Budget planning for 2027 · Grace Sample 2026-05-29 11:25",
  "",
  "Budget planning for next year.",
  "",
  "## Comment by Linus Placeholder · 2026-06-01 08:31",
  "",
  "First reply: the draft looks reasonable.",
  "",
  "## Comment by Grace Sample · 2026-06-16 19:15",
  "",
  LONG_MD,
].join("\n");

// ── Search (GET /b2/search?compact=1) ───────────────────────────────────────
//
// `search_results` root = SearchResultSerializer rows (denormalised);
// `users` (authors) and `polls` (+ `poll_options`) side-loaded; NO
// meta.total (the controller never sets collection_count).

export function searchResultRow(overrides: Partial<LoomioSearchResult> = {}): LoomioSearchResult {
  return {
    id: 207608,
    searchable_type: "Discussion",
    searchable_id: 601,
    poll_title: null,
    discussion_title: "Budget planning for 2027",
    discussion_key: "dscKEY01",
    highlight:
      "the <b>budget</b> for next year &amp; the <b>budget</b> reserve\n\n* [<b>budget</b> notes](https://example.org/notes)",
    poll_key: null,
    poll_id: null,
    sequence_id: null,
    group_id: 7,
    group_handle: "example-org",
    group_key: "grpKEY07",
    group_name: "Example Org",
    author_name: "Grace Sample",
    author_id: 502,
    authored_at: "2026-05-29T11:25:57.740Z",
    ...overrides,
  };
}

export const SEARCH_ROWS: LoomioSearchResult[] = [
  searchResultRow(),
  searchResultRow({
    id: 207609,
    searchable_type: "Comment",
    searchable_id: 1701,
    highlight: "I read the <b>budget</b> draft &#39;twice&#39;",
    author_id: 503,
    author_name: "Linus Placeholder",
    authored_at: "2026-06-01T08:31:10.169Z",
    tags: ["guide"],
  }),
  searchResultRow({
    id: 207610,
    searchable_type: "Stance",
    searchable_id: 902,
    poll_title: "Adopt the 2027 budget?",
    poll_key: "polKEY01",
    poll_id: 301,
    sequence_id: 2,
    highlight: "<b>Budget</b> reserve figure",
    author_id: 503,
    author_name: "Linus Placeholder",
    authored_at: "2026-09-06T10:00:00Z",
  }),
  searchResultRow({
    id: 207611,
    searchable_type: "Poll",
    searchable_id: 302,
    discussion_title: null,
    discussion_key: null,
    poll_title: "Pick a date for the budget meeting",
    poll_key: "polKEY02",
    poll_id: 302,
    highlight: "Pick a date for the <b>budget</b> meeting",
    group_id: 12,
    group_handle: "example-org-finance",
    group_key: "grpKEY12",
    group_name: "Example Org - Finance Team",
    authored_at: "2026-09-02T09:00:00Z",
  }),
];

/**
 * `SearchResultSerializer has_one :poll`: every poll-related row (a Poll
 * hit, a Stance / Outcome on one) brings its PollSerializer record into
 * the `polls` root — here poll 301 (hide_results off) for the stance
 * row and standalone poll 302 for its own hit — plus `my_stance` under
 * `stances` when the API user voted (absent here).
 */
export function searchBody(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    users: [GRACE, LINUS],
    polls: [pollRow(), STANDALONE_POLL],
    poll_options: [],
    search_results: SEARCH_ROWS,
    meta: { root: "search_results" },
    ...overrides,
  };
}

/** Author mode (`author_id` without `query`): html-escaped plain excerpts, no <b> markup. */
export function searchAuthorBody(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    users: [GRACE],
    polls: [],
    search_results: [
      searchResultRow({
        id: 211118,
        searchable_id: 602,
        discussion_title: "How to nominate a candidate",
        discussion_key: "dscKEY02",
        highlight:
          "Below are the minutes from the meeting. That&#39;s one of the opportunities to engage &amp; ...",
        authored_at: "2026-07-27T12:41:31.329Z",
      }),
    ],
    meta: { root: "search_results" },
    ...overrides,
  };
}

// ── Participation report (GET /b2/reports?section=users) ────────────────────
//
// A plain hash (no `meta`): `users[]` rows for every user holding ANY
// membership row in the effective groups (revoked included), the same
// numbers again as `*_per_user` maps keyed by user-id strings, the
// `all_groups` the API user could ask about, and `group_ids` echoing the
// ids Loomio actually counted (requested ids it is not a member of are
// dropped silently).

export function reportUserRow(overrides: Partial<LoomioReportUserRow> = {}): LoomioReportUserRow {
  return {
    id: 502,
    name: "Grace Sample",
    country: "Norway",
    delegate: false,
    threads: 3,
    comments: 2,
    polls: 1,
    votes: 0,
    votes_cast: 0,
    votes_issued: 1,
    votes_missed: 1,
    all_votes_cast: false,
    outcomes: 1,
    reactions: 0,
    ...overrides,
  };
}

/** Rows for Example Org (group 7): the bot, two members and a revoked former member. */
export const REPORT_ROWS: LoomioReportUserRow[] = [
  reportUserRow({
    id: 501,
    name: "Ada Example",
    country: null,
    threads: 0,
    comments: 0,
    polls: 0,
    votes_issued: 0,
    votes_missed: 0,
    outcomes: 0,
  }),
  reportUserRow(),
  reportUserRow({
    id: 503,
    name: "Linus Placeholder",
    country: "Portugal",
    delegate: true,
    threads: 1,
    comments: 0,
    polls: 0,
    votes: 1,
    votes_cast: 1,
    votes_issued: 1,
    votes_missed: 0,
    all_votes_cast: true,
    outcomes: 0,
    reactions: 2,
  }),
  reportUserRow({
    id: 504,
    name: "Former Member",
    country: null,
    threads: 0,
    comments: 0,
    polls: 0,
    votes_issued: 0,
    votes_missed: 0,
    outcomes: 0,
  }),
];

export function reportsUsersBody(
  overrides: Partial<ReportsUsersResponse> = {},
): ReportsUsersResponse {
  return {
    first_year: 2024,
    all_groups: [
      { id: 7, name: "Example Org" },
      { id: 12, name: "Finance Team" },
      { id: 15, name: "Volunteers" },
    ],
    group_ids: [7],
    group_scope: "custom",
    current_user_is_admin: false,
    users: REPORT_ROWS,
    discussions_per_user: { "502": 3, "503": 1 },
    comments_per_user: { "502": 2 },
    polls_per_user: { "502": 1 },
    outcomes_per_user: { "502": 1 },
    stances_per_user: { "503": 1 },
    stances_issued_per_user: { "502": 1, "503": 1 },
    reactions_per_user: { "503": 2 },
    tag_threads_per_user: { guide: { "502": 3, "503": 1 } },
    tag_threads_authored_per_user: { guide: { "502": 3, "503": 1 } },
    ...overrides,
  };
}
