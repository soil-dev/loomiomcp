import { z } from "zod";
import { LoomioApiError, LoomioAuthError, loomioGet } from "../loomio/client.js";
import { isoTimestamp, positiveId } from "./_common.js";

const CONCURRENCY = 6;
const EVENTS_PAGE_SIZE = 200;
const MAX_EVENTS_PAGES = 10; // hard cap per discussion to bound a single bad thread
const MAX_DISCUSSION_PAGES = 20; // hard cap per group when enumerating discussions
const MAX_SCAN_DISCUSSIONS = 500; // global ceiling on discussions whose events we fetch

// ── Loomio ≥ 3.4.0: v1/events no longer exists ──────────────────────────────
//
// Loomio 3.4.0 (August 2026) replaced the Event model with TopicItem and
// deleted the v1 `events` controller together with its route — Loomio
// 3.8.1's config/routes.rb has no `events` resource in any namespace.
// Against such an instance every GET /api/v1/events answers 404: a Rails
// routing miss, not a Loomio "record not found". The successor is
// GET /api/b2/threads/{topic_id}/items, which this connector does not
// call yet (the port is planned for v0.0.12).
//
// Until then the only honest behaviour is to FAIL LOUDLY. A 404 here is
// not "this discussion has no events", and a fan-out that quietly
// recovered from it would report `counts.total: 0` for every user in
// every group — a plausible-looking, entirely wrong answer that an agent
// would relay as "this person never participated".

export const V1_EVENTS_REMOVED_MESSAGE =
  "Loomio removed the v1/events endpoint (Loomio ≥ 3.4.0). list_events and get_user_activity do " +
  "not work against this Loomio version until the connector is ported to " +
  "GET /api/b2/threads/{topic_id}/items (planned for v0.0.12).";

/**
 * Thrown when GET /api/v1/events answers 404. Its own class (rather than
 * a bare Error) so `getUserActivity` can refuse to swallow it while it
 * still recovers from the per-discussion failures that make a scan
 * merely partial.
 */
export class V1EventsRemovedError extends Error {
  constructor(discussionId: number) {
    super(
      `${V1_EVENTS_REMOVED_MESSAGE} (If the instance is OLDER than 3.4.0 the same 404 would ` +
        `instead mean discussion ${discussionId} does not exist — get_discussion tells the two apart.)`,
    );
    this.name = "V1EventsRemovedError";
  }
}

function isV1EventsGone(err: unknown): boolean {
  return err instanceof LoomioApiError && err.status === 404;
}

// ── list_events ─────────────────────────────────────────────────────────────
//
// Paginated wrapper around Loomio's v1 `events` endpoint (where it still
// exists — see above), scoped to one discussion. Visibility caveat: v1
// never read the API key (v1 resolves its user from the session cookie
// only, so the bearer header the client sends is ignored), which means
// this read always ran as Loomio's anonymous `LoggedOutUser`. It could
// see PUBLIC discussions only — the connector user's memberships made
// no difference, and a private discussion 403'd regardless of them.
// The b2 successor runs as the key's user, so the 0.0.12 port also
// changes what is visible, not just where it is read from.
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

interface EventsWithScope extends EventsResponse {
  scope: {
    complete: boolean;
    pages_fetched: number;
    events_truncated: boolean;
  };
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
    .describe(
      "Page size for a single-page fetch. Omit limit/offset to let the connector paginate the full discussion stream up to its bounded cap.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Page offset (Loomio's `from` parameter). When supplied, list_events returns exactly that page instead of auto-paginating.",
    ),
  kinds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional filter to only these event kinds (applied client-side after fetch — Loomio doesn't filter `kind` server-side). Common kinds: new_discussion, new_comment, comment_edited, poll_created, stance_created, outcome_created, discussion_moved, discussion_closed, reaction.",
    ),
});

function mergeEventResponse(into: EventsResponse, from: EventsResponse): void {
  into.events = [...(into.events ?? []), ...(from.events ?? [])];
  into.comments = [...(into.comments ?? []), ...(from.comments ?? [])];
  into.users = [...(into.users ?? []), ...(from.users ?? [])];
  into.polls = [...(into.polls ?? []), ...(from.polls ?? [])];
  into.parent_events = [...(into.parent_events ?? []), ...(from.parent_events ?? [])];
  into.meta = from.meta ?? into.meta;
}

function filterKinds<T extends EventsResponse>(resp: T, kinds?: string[]): T {
  if (!kinds?.length) return resp;
  const allowed = new Set(kinds);
  return {
    ...resp,
    events: (resp.events ?? []).filter((e) => allowed.has(e.kind)),
  };
}

/**
 * One page of a discussion's events, with the 404-means-gone translation
 * applied. Used by `listEvents` directly; `getUserActivity` uses the raw
 * fetch and applies the translation only to its first probe (see there).
 */
async function getEventsPage(
  discussionId: number,
  page: { per?: number; from?: number },
): Promise<EventsResponse> {
  try {
    return await loomioGet<EventsResponse>("/v1/events", { discussion_id: discussionId, ...page });
  } catch (err) {
    if (isV1EventsGone(err)) throw new V1EventsRemovedError(discussionId);
    throw err;
  }
}

export async function listEvents(input: z.infer<typeof listEventsSchema>) {
  if (input.limit !== undefined || input.offset !== undefined) {
    const resp = await getEventsPage(input.discussion_id, {
      ...(input.limit !== undefined ? { per: input.limit } : {}),
      ...(input.offset !== undefined ? { from: input.offset } : {}),
    });
    return filterKinds(resp, input.kinds);
  }

  const merged: EventsResponse = {};
  let offset = 0;
  let pagesFetched = 0;
  let truncated = false;

  for (let page = 0; page < MAX_EVENTS_PAGES; page++) {
    const resp = await getEventsPage(input.discussion_id, { per: EVENTS_PAGE_SIZE, from: offset });
    pagesFetched++;
    const evs = resp.events ?? [];
    mergeEventResponse(merged, resp);
    if (evs.length < EVENTS_PAGE_SIZE) break;
    offset += EVENTS_PAGE_SIZE;
    // Full page on the final allowed iteration means the returned "full"
    // stream is capped; surface that rather than silently clipping it.
    if (page === MAX_EVENTS_PAGES - 1) truncated = true;
  }

  return filterKinds(
    {
      ...merged,
      scope: {
        complete: !truncated,
        pages_fetched: pagesFetched,
        events_truncated: truncated,
      },
    } satisfies EventsWithScope,
    input.kinds,
  );
}

// ── get_user_activity ───────────────────────────────────────────────────────
//
// Server-side aggregation of a user's activity across the connector
// user's visible discussions. Loomio doesn't have a per-user events
// index (see comment above), so this fans out: for each discussion in
// the requested groups, fetch the event stream, filter to events
// authored by the target user, and aggregate.
//
// Cost: ~1 HTTP call per discussion in scope. On a mid-sized instance
// (a few hundred discussions) that's a few hundred calls for an
// instance-wide scan — limited by the CONCURRENCY pool to bursts of 6.
//
// Amplification guard: the per-group and per-discussion page caps below
// MULTIPLY (groups × disc-pages × event-pages), so without a global
// ceiling one public, auto-approvable call could in principle fan out
// to millions of upstream requests on a large instance. MAX_SCAN_
// DISCUSSIONS caps the dominant cost (the per-discussion event fetch):
// once that many discussions are in scope we stop and flag the result
// `truncated`, so the aggregate is never silently partial. The cap sits
// well above a typical mid-sized instance's discussion count, so normal
// scans are unaffected.
//
// Honesty guard: partial results are flagged, TOTAL failures are thrown.
// A scan where every event fetch failed (or every group listing failed)
// has counted nothing; returning `counts.total: 0` with `complete: false`
// is technically labelled but reads as "this user did nothing" to
// anyone who skips the scope block. See the two throws in
// `getUserActivity`.

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

export const getUserActivitySchema = z
  .object({
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
  })
  .superRefine((input, ctx) => {
    if (!input.since || !input.until) return;
    if (Date.parse(input.until) <= Date.parse(input.since)) {
      ctx.addIssue({
        code: "custom",
        path: ["until"],
        message: "until must be later than since.",
      });
    }
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
    groups_failed: number[]; // groups whose discussion list couldn't be read (e.g. 403 — not visible to the connector's user)
    discussions_failed: number; // discussions whose event stream errored and were skipped
    discussions_truncated: number; // discussions that hit the per-thread page cap (events beyond it not counted)
    discussions_capped: boolean; // true if the global MAX_SCAN_DISCUSSIONS ceiling dropped some discussions
    groups_truncated: number[]; // groups whose discussion listing hit MAX_DISCUSSION_PAGES
  };
  counts: {
    total: number;
    new_discussion: number;
    new_comment: number;
    comment_edited: number;
    poll_created: number;
    stance_created: number;
    stance_updated: number;
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
): Promise<{ discussions: Array<{ id: number; group_id: number }>; truncated: boolean }> {
  const all: Array<{ id: number; group_id: number }> = [];
  let offset = 0;
  let truncated = false;
  // Pagination — Loomio returns at most ~200 per page. Cap iterations
  // to avoid runaway scans. `status: "all"` is explicit: activity in
  // locked threads still counts, and Loomio's default for a missing
  // `status` has not been stable across releases.
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
    if (page === MAX_DISCUSSION_PAGES - 1) truncated = true;
  }
  return { discussions: all, truncated };
}

// Fetch a discussion's events, paginating up to MAX_EVENTS_PAGES.
// `truncated` is true if we stopped because we hit that page cap (i.e.
// the thread has more events we didn't read) rather than because we
// reached the end — so the caller can flag the aggregate as a lower
// bound instead of presenting a silently-clipped count as complete.
// Errors propagate untranslated; the caller decides which are fatal.
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
  recoverError: (err: unknown) => boolean = () => true,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  async function take(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!);
      } catch (err) {
        if (!recoverError(err)) throw err;
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, take));
  return results;
}

// A scan survives per-record refusals (403: the connector's user cannot
// see that group / discussion) and per-record API errors (404 for a
// discussion discarded mid-scan, 5xx, timeout) by skipping the record
// and flagging the result incomplete. Anything else — a 401 from a proxy,
// a configuration error, a V1EventsRemovedError — is not about one record
// and aborts the scan.
function isRecoverableScanError(err: unknown): boolean {
  if (err instanceof LoomioAuthError) return err.status === 403;
  return err instanceof LoomioApiError;
}

function rememberRecentSample(samples: ActivityResult["sample_events"], e: LoomioEvent): void {
  samples.push({
    kind: e.kind,
    discussion_id: e.discussion_id,
    created_at: e.created_at,
    eventable_type: e.eventable_type,
    eventable_id: e.eventable_id,
  });
  samples.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (samples.length > 10) samples.length = 10;
}

interface EventStream {
  groupId: number;
  events: LoomioEvent[];
  truncated: boolean;
}

export async function getUserActivity(
  input: z.infer<typeof getUserActivitySchema>,
): Promise<ActivityResult> {
  const groupIds = [...new Set(input.group_ids)];

  // 1. Enumerate discussions across the scoped groups. A group whose
  // list can't be read (null = it errored, e.g. 403 because the group is
  // not visible to the connector's user) is recorded in groupsFailed
  // rather than silently dropped — otherwise its absence would
  // understate the totals with no signal. The last such error is kept
  // so a total failure can say WHY (the client's 403 classification
  // already distinguishes a rotated key from a hidden group).
  let lastGroupError: unknown;
  const groupDiscussionLists = await runWithConcurrency(
    groupIds,
    (gid) => listDiscussionIdsForGroup(gid),
    CONCURRENCY,
    (err) => {
      if (!isRecoverableScanError(err)) return false;
      lastGroupError = err;
      return true;
    },
  );
  const groupsFailed: number[] = [];
  const groupsTruncated: number[] = [];
  const discussions: Array<{ id: number; group_id: number }> = [];
  groupDiscussionLists.forEach((list, i) => {
    if (list) {
      discussions.push(...list.discussions);
      if (list.truncated) groupsTruncated.push(groupIds[i]!);
    } else {
      groupsFailed.push(groupIds[i]!);
    }
  });

  // Every group failed: nothing was scanned, so there is nothing to
  // aggregate. The recorded error explains the refusal.
  if (groupsFailed.length === groupIds.length) {
    const reason =
      lastGroupError instanceof Error ? lastGroupError.message : String(lastGroupError);
    throw new Error(
      `get_user_activity could not list the discussions of any of the ${groupIds.length} requested ` +
        `group(s) (${groupIds.join(", ")}), so no activity can be reported. Last error: ${reason}`,
    );
  }

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
    comment_edited: 0,
    poll_created: 0,
    stance_created: 0,
    stance_updated: 0,
    outcome_created: 0,
    reaction: 0,
    other: 0,
  };
  const byGroup: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  let firstActivity: string | null = null;
  let lastActivity: string | null = null;
  const samples: ActivityResult["sample_events"] = [];

  const fetchStream = async (d: { id: number; group_id: number }): Promise<EventStream> => {
    const { events, truncated } = await fetchAllEventsForDiscussion(d.id);
    return { groupId: d.group_id, events, truncated };
  };

  // 2a. Probe the FIRST discussion's stream on its own, before fanning
  // out. If v1/events is gone (Loomio ≥ 3.4.0) this 404s — and so would
  // every one of the hundreds of fetches behind it. Throwing here costs
  // one request instead of one per discussion and, more importantly,
  // never lets the scan degrade into "every discussion failed, here are
  // zero counts". Other errors on the first discussion are treated
  // exactly as they would be inside the fan-out.
  const [first, ...rest] = scanDiscussions;
  const streams: Array<EventStream | null> = [];
  if (first) {
    try {
      streams.push(await fetchStream(first));
    } catch (err) {
      if (isV1EventsGone(err)) throw new V1EventsRemovedError(first.id);
      if (!isRecoverableScanError(err)) throw err;
      streams.push(null);
    }
  }
  streams.push(
    ...(await runWithConcurrency(rest, fetchStream, CONCURRENCY, isRecoverableScanError)),
  );

  for (const s of streams) {
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
      rememberRecentSample(samples, e);
    }
  }

  // 2b. Zero streams read, at least one failure: the counts below would
  // all be zero for a reason that has nothing to do with the user.
  // Refuse rather than return them.
  if (discussionsFailed > 0 && discussionsFailed === scanDiscussions.length) {
    throw new Error(
      `get_user_activity could not read the event stream of any of the ${scanDiscussions.length} ` +
        "discussion(s) in scope (every fetch failed with 403 / 404 / 5xx / timeout), so no activity " +
        "counts can be reported. If this Loomio is ≥ 3.4.0 the cause is the removed v1/events " +
        "endpoint; otherwise check the connector user's access to these discussions.",
    );
  }

  const complete =
    groupsFailed.length === 0 &&
    discussionsFailed === 0 &&
    discussionsTruncated === 0 &&
    groupsTruncated.length === 0 &&
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
      groups_truncated: groupsTruncated,
    },
    counts,
    by_group: byGroup,
    by_month: byMonth,
    first_activity: firstActivity,
    last_activity: lastActivity,
    sample_events: samples,
  };
}
