import { z } from "zod";
import { loomioGet } from "../loomio/client.js";
import { positiveId } from "./_common.js";

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

const CONCURRENCY = 6;
const EVENTS_PAGE_SIZE = 200;
const MAX_EVENTS_PAGES = 10; // hard cap per discussion to bound a single bad thread

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
  since: z.string().optional().describe("ISO-8601 timestamp; ignore events before this time."),
  until: z.string().optional().describe("ISO-8601 timestamp; ignore events at or after this time."),
});

interface ActivityResult {
  user_id: number;
  scope: {
    group_ids: number[];
    discussions_scanned: number;
    events_examined: number;
    since: string | null;
    until: string | null;
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
  for (let page = 0; page < 20; page++) {
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

async function fetchAllEventsForDiscussion(discussionId: number): Promise<LoomioEvent[]> {
  const all: LoomioEvent[] = [];
  let offset = 0;
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
  }
  return all;
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

  // 1. Enumerate discussions across the scoped groups.
  const groupDiscussionLists = await runWithConcurrency(
    groupIds,
    (gid) => listDiscussionIdsForGroup(gid),
    CONCURRENCY,
  );
  const discussions: Array<{ id: number; group_id: number }> = [];
  for (const list of groupDiscussionLists) {
    if (list) discussions.push(...list);
  }

  // 2. Fetch events per discussion, with bounded concurrency.
  const since = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;
  const until = input.until ? Date.parse(input.until) : Number.POSITIVE_INFINITY;
  let eventsExamined = 0;

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
    discussions,
    async (d) => ({ groupId: d.group_id, events: await fetchAllEventsForDiscussion(d.id) }),
    CONCURRENCY,
  );

  for (const s of eventStreams) {
    if (!s) continue;
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

  return {
    user_id: input.user_id,
    scope: {
      group_ids: groupIds,
      discussions_scanned: discussions.length,
      events_examined: eventsExamined,
      since: input.since ?? null,
      until: input.until ?? null,
    },
    counts,
    by_group: byGroup,
    by_month: byMonth,
    first_activity: firstActivity,
    last_activity: lastActivity,
    sample_events: samples,
  };
}
