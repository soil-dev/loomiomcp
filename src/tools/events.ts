import { z } from "zod";
import { loomioGet } from "../loomio/client.js";
import { isoTimestamp, positiveId } from "./_common.js";

// ── list_events ─────────────────────────────────────────────────────────────
//
// Thin pass-through to Loomio's v1 `events` endpoint, scoped to one
// discussion. The v1 events controller has no api-key auth gate of
// its own — visibility is enforced by the discussion's group
// membership rules. The connector's bot needs membership in the
// discussion's group (or the discussion's group must be public);
// admin role is NOT required, unlike `list_memberships`.
//
// The server-side filter on v1/events is `discussion_id`. There is
// no `actor_id` / `group_id` index; both are accepted as params but
// silently return an empty array unless `discussion_id` is also
// supplied. That constraint shapes `get_user_activity` below: it
// has to fan out across discussions, there's no shortcut.

interface LoomioEvent {
  id: number;
  kind: string;
  actor_id: number | null;
  created_at: string;
  parent_id: number | null;
  discussion_id: number | null;
  sequence_id: number | null;
  position: number | null;
  depth: number | null;
  child_count: number | null;
  descendant_count: number | null;
  eventable_type: string;
  eventable_id: number;
  pinned: boolean;
  pinned_title: string | null;
  recipient_message?: string | null;
  custom_fields?: Record<string, unknown>;
}

interface EventsResponse {
  events?: LoomioEvent[];
  comments?: unknown[];
  users?: unknown[];
  polls?: unknown[];
  parent_events?: LoomioEvent[];
  meta?: { root?: string; total?: number | null };
}

export const listEventsSchema = z.object({
  discussion_id: positiveId.describe(
    "ID of the discussion whose event stream to fetch. Required — Loomio's v1/events endpoint silently returns empty without it.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Page size. Loomio defaults to 50; cap is 200."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Page offset (Loomio's `from` parameter). Defaults to 0."),
  kinds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional filter to only these event kinds (applied client-side after fetch — Loomio doesn't filter `kind` server-side). Common kinds: new_discussion, new_comment, comment_edited, poll_created, stance_created, outcome_created, discussion_moved, discussion_closed, reaction.",
    ),
});

export async function listEvents(input: z.infer<typeof listEventsSchema>) {
  const resp = await loomioGet<EventsResponse>("/v1/events", {
    discussion_id: input.discussion_id,
    ...(input.limit !== undefined ? { per: input.limit } : {}),
    ...(input.offset !== undefined ? { from: input.offset } : {}),
  });

  if (input.kinds?.length) {
    const allowed = new Set(input.kinds);
    return {
      ...resp,
      events: (resp.events ?? []).filter((e) => allowed.has(e.kind)),
    };
  }
  return resp;
}

// ── get_user_activity ───────────────────────────────────────────────────────
//
// Server-side aggregation of a user's activity across the bot's
// visible discussions. Loomio doesn't have a per-user events index
// (see comment above), so this fans out: for each discussion in the
// requested groups (or every group the bot can see, if none
// specified), fetch the event stream, filter to events authored by
// the target user, and aggregate.
//
// Cost: ~1 HTTP call per discussion in scope. On openssl-communities,
// that's ~200 calls for an instance-wide scan — limited by the
// CONCURRENCY pool to bursts of 6.
//
// Amplification guard: the per-group and per-discussion page caps below
// MULTIPLY (groups × disc-pages × event-pages), so without a global
// ceiling one public, auto-approvable call could in principle fan out
// to millions of upstream requests on a large instance. MAX_SCAN_
// DISCUSSIONS caps the dominant cost (the per-discussion event fetch):
// once that many discussions are in scope we stop and flag the result
// `truncated`, so the aggregate is never silently partial. The cap sits
// far above this instance's ~200 discussions, so normal scans are
// unaffected.

const CONCURRENCY = 6;
const EVENTS_PAGE_SIZE = 200;
const MAX_EVENTS_PAGES = 10; // hard cap per discussion to bound a single bad thread
const MAX_DISCUSSION_PAGES = 20; // hard cap per group when enumerating discussions
const MAX_SCAN_DISCUSSIONS = 500; // global ceiling on discussions whose events we fetch

const ACTIVITY_KINDS = new Set([
  "new_discussion",
  "new_comment",
  "comment_edited",
  "poll_created",
  "stance_created",
  "stance_updated",
  "outcome_created",
  "reaction",
]);

export const getUserActivitySchema = z.object({
  user_id: positiveId.describe("Loomio user id whose activity to summarise."),
  group_ids: z
    .array(positiveId)
    .min(1)
    .max(50)
    .describe(
      "Groups to scan. Required — pass the result of `list_groups` (or a subset of it) to make the cost explicit. ~1 outbound HTTP request per discussion in scope, plus one list_discussions call per group; ~100-300 calls is typical for a wide scan. Capped at 50 groups per call.",
    ),
  since: isoTimestamp.describe(
    "ISO-8601 timestamp; ignore events before this time. Rejected if unparseable (so a typo can't silently widen the scan to all history).",
  ),
  until: isoTimestamp.describe(
    "ISO-8601 timestamp; ignore events at or after this time. Rejected if unparseable.",
  ),
});

interface ActivityResult {
  user_id: number;
  scope: {
    group_ids: number[];
    discussions_scanned: number;
    events_examined: number;
    since: string | null;
    until: string | null;
    // Completeness signals. When any of these is non-empty / true the
    // counts below are a LOWER BOUND, not the whole picture — surfaced
    // explicitly so a partial scan is never mistaken for a complete one.
    complete: boolean;
    groups_failed: number[]; // groups whose discussion list couldn't be read (e.g. 403 — bot not a member)
    discussions_failed: number; // discussions whose event stream errored and were skipped
    discussions_truncated: number; // discussions that hit the per-thread page cap (events beyond it not counted)
    discussions_capped: boolean; // true if the global MAX_SCAN_DISCUSSIONS ceiling dropped some discussions
  };
  counts: {
    total: number;
    new_discussion: number;
    new_comment: number;
    poll_created: number;
    stance_created: number;
    outcome_created: number;
    reaction: number;
    other: number;
  };
  by_group: Record<string, number>;
  by_month: Record<string, number>;
  first_activity: string | null;
  last_activity: string | null;
  sample_events: Array<{
    kind: string;
    discussion_id: number | null;
    created_at: string;
    eventable_type: string;
    eventable_id: number;
  }>;
}

interface DiscussionsListResponse {
  discussions?: Array<{ id: number; group_id?: number | null }>;
}

async function listDiscussionIdsForGroup(
  groupId: number,
): Promise<Array<{ id: number; group_id: number }>> {
  const all: Array<{ id: number; group_id: number }> = [];
  let offset = 0;
  // Pagination — Loomio returns at most ~200 per page. Cap iterations
  // to avoid runaway scans.
  for (let page = 0; page < MAX_DISCUSSION_PAGES; page++) {
    const resp = await loomioGet<DiscussionsListResponse>("/b2/discussions", {
      group_id: groupId,
      status: "all",
      limit: EVENTS_PAGE_SIZE,
      offset,
    });
    const ds = resp.discussions ?? [];
    for (const d of ds) all.push({ id: d.id, group_id: groupId });
    if (ds.length < EVENTS_PAGE_SIZE) break;
    offset += EVENTS_PAGE_SIZE;
  }
  return all;
}

// Fetch a discussion's events, paginating up to MAX_EVENTS_PAGES.
// `truncated` is true if we stopped because we hit that page cap (i.e.
// the thread has more events we didn't read) rather than because we
// reached the end — so the caller can flag the aggregate as a lower
// bound instead of presenting a silently-clipped count as complete.
async function fetchAllEventsForDiscussion(
  discussionId: number,
): Promise<{ events: LoomioEvent[]; truncated: boolean }> {
  const all: LoomioEvent[] = [];
  let offset = 0;
  let truncated = false;
  for (let page = 0; page < MAX_EVENTS_PAGES; page++) {
    const resp = await loomioGet<EventsResponse>("/v1/events", {
      discussion_id: discussionId,
      per: EVENTS_PAGE_SIZE,
      from: offset,
    });
    const evs = resp.events ?? [];
    for (const e of evs) all.push(e);
    if (evs.length < EVENTS_PAGE_SIZE) break;
    offset += EVENTS_PAGE_SIZE;
    // Full page on the final allowed iteration → there's more we won't read.
    if (page === MAX_EVENTS_PAGES - 1) truncated = true;
  }
  return { events: all, truncated };
}

// Run promise-returning fns with bounded concurrency. Returns results
// in input order; failures map to `null` (caller decides recovery).
async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  async function take(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, take));
  return results;
}

export async function getUserActivity(
  input: z.infer<typeof getUserActivitySchema>,
): Promise<ActivityResult> {
  const groupIds = [...new Set(input.group_ids)];

  // 1. Enumerate discussions across the scoped groups. A group whose
  // list can't be read (null = it errored, e.g. 403 because the bot
  // isn't a member) is recorded in groupsFailed rather than silently
  // dropped — otherwise its absence would understate the totals with
  // no signal.
  const groupDiscussionLists = await runWithConcurrency(
    groupIds,
    (gid) => listDiscussionIdsForGroup(gid),
    CONCURRENCY,
  );
  const groupsFailed: number[] = [];
  const discussions: Array<{ id: number; group_id: number }> = [];
  groupDiscussionLists.forEach((list, i) => {
    if (list) {
      discussions.push(...list);
    } else {
      groupsFailed.push(groupIds[i]!);
    }
  });

  // Global ceiling on the expensive per-discussion event fetch. If the
  // scan turned up more discussions than the cap, fetch events for only
  // the first MAX_SCAN_DISCUSSIONS and flag the result capped.
  const discussionsCapped = discussions.length > MAX_SCAN_DISCUSSIONS;
  const scanDiscussions = discussionsCapped
    ? discussions.slice(0, MAX_SCAN_DISCUSSIONS)
    : discussions;

  // 2. Fetch events per discussion, with bounded concurrency.
  const since = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;
  const until = input.until ? Date.parse(input.until) : Number.POSITIVE_INFINITY;
  let eventsExamined = 0;
  let discussionsFailed = 0;
  let discussionsTruncated = 0;

  const counts = {
    total: 0,
    new_discussion: 0,
    new_comment: 0,
    poll_created: 0,
    stance_created: 0,
    outcome_created: 0,
    reaction: 0,
    other: 0,
  };
  const byGroup: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let firstActivity: string | null = null;
  let lastActivity: string | null = null;
  const samples: ActivityResult["sample_events"] = [];

  const eventStreams = await runWithConcurrency(
    scanDiscussions,
    async (d) => {
      const { events, truncated } = await fetchAllEventsForDiscussion(d.id);
      return { groupId: d.group_id, events, truncated };
    },
    CONCURRENCY,
  );

  for (const s of eventStreams) {
    if (!s) {
      // null = this discussion's event fetch errored (403/500/timeout).
      // Count it so the aggregate is flagged incomplete rather than
      // quietly contributing zero events.
      discussionsFailed++;
      continue;
    }
    if (s.truncated) discussionsTruncated++;
    for (const e of s.events) {
      eventsExamined++;
      if (e.actor_id !== input.user_id) continue;
      const t = Date.parse(e.created_at);
      if (Number.isNaN(t) || t < since || t >= until) continue;
      if (!ACTIVITY_KINDS.has(e.kind)) {
        counts.other++;
      } else {
        const slot = e.kind as keyof typeof counts;
        if (slot in counts && slot !== "total") counts[slot]++;
      }
      counts.total++;
      byGroup[String(s.groupId)] = (byGroup[String(s.groupId)] ?? 0) + 1;
      const month = e.created_at.slice(0, 7); // YYYY-MM
      byMonth[month] = (byMonth[month] ?? 0) + 1;
      if (!firstActivity || e.created_at < firstActivity) firstActivity = e.created_at;
      if (!lastActivity || e.created_at > lastActivity) lastActivity = e.created_at;
      if (samples.length < 10) {
        samples.push({
          kind: e.kind,
          discussion_id: e.discussion_id,
          created_at: e.created_at,
          eventable_type: e.eventable_type,
          eventable_id: e.eventable_id,
        });
      }
    }
  }

  const complete =
    groupsFailed.length === 0 &&
    discussionsFailed === 0 &&
    discussionsTruncated === 0 &&
    !discussionsCapped;

  return {
    user_id: input.user_id,
    scope: {
      group_ids: groupIds,
      discussions_scanned: scanDiscussions.length,
      events_examined: eventsExamined,
      since: input.since ?? null,
      until: input.until ?? null,
      complete,
      groups_failed: groupsFailed,
      discussions_failed: discussionsFailed,
      discussions_truncated: discussionsTruncated,
      discussions_capped: discussionsCapped,
    },
    counts,
    by_group: byGroup,
    by_month: byMonth,
    first_activity: firstActivity,
    last_activity: lastActivity,
    sample_events: samples,
  };
}
