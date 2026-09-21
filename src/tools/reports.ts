import { z } from "zod";
import { csvParam, LoomioAuthError, loomioGet, readParams } from "../loomio/client.js";
import type { LoomioReportUserRow, ReportsUsersResponse, SearchResponse } from "../loomio/types.js";
import { isoTimestamp, positiveId } from "./_common.js";
import { type SearchHit, shapeSearchHits } from "./search.js";

// ── GET /b2/reports (Loomio ≥ 3.7.0; verified against 3.8.1) ───────────────
//
// `Api::B2::ReportsController#index` is one line: it renders
// `ParticipationReportService.fetch(actor: current_user, params:,
// instance_admin_access: false)` — the same service behind the
// participation page every member sees in Loomio's UI. What the service
// reads from the query string, and what happens when it is wrong:
//
//   section      base | users | countries. `users` is the per-member
//                table this module wants; `base` is per-interval totals
//                with tag counts; `countries` is per-country totals.
//   group_scope  custom (default) | my | all. `all` needs instance
//                admin access, which the b2 controller switches OFF, so
//                it is read as `my`. `my` = the user's member groups
//                plus the subgroups of those it may see
//                (`GroupQuery.visible_to` over `Group.where(parent_id:
//                member_ids) | member_ids`). `custom` reads `group_ids`.
//   group_ids    a COMMA-SEPARATED STRING (`"7,12"`; `.split(',')` in
//                the service — an array would be silently ignored),
//                then INTERSECTED with `actor.group_ids` (the user's
//                un-revoked memberships, pending invitations included).
//                Ids the user is not a member of are dropped WITHOUT any
//                error; when nothing is left the report runs on group
//                -1 and `users` is empty. The response's `group_ids`
//                echoes the ids that survived — the fence, and the only
//                way to know a group was dropped (test "does not report
//                a group the API user cannot access"). Instance is_admin
//                changes none of this ("instance admin status does not
//                expand report scope").
//   start_month  YYYY-MM. Parsed with `Date.parse(value + "-01")`, so
//   end_month    anything else is a Ruby exception → HTTP 500. The window
//                is [start_month-01, end_month-01 + 1 month): the end
//                month is INCLUDED whole. Defaults: 12 months ago / the
//                current month. This module always sends both, valid.
//   interval     day | week | month | year (default month); anything else
//                → ArgumentError → 500. It shapes ONLY the `base`
//                section's per-interval series. `users_data` never
//                consults it — the per-user maps have no time dimension —
//                so a per-month breakdown per user does not exist and
//                the tools do not pretend otherwise (no `by_month`).
//   member_type  absent or `delegate` (only users holding an active
//                delegate membership in the groups); anything else → 500.
//
// Per-user counts (ReportService, all scoped to topics of the effective
// groups and to `created_at` inside the window): `threads` discussions
// authored, `comments` comments authored, `polls` polls authored,
// `outcomes` outcomes authored, `reactions` reactions given (on
// comments, discussions, polls, stances, outcomes), `votes` = `votes_cast`
// latest stances with `cast_at` set on polls with `anonymous = false`,
// `votes_issued` latest stances with a participant on those polls (Loomio
// creates one stance per invited voter when a poll opens, so this is
// "ballots handed to the user"), `votes_missed` = issued − cast. Two
// consequences worth stating in every description: anonymous polls
// contribute nothing to the vote columns, and a vote is attributed to the
// month the COUNTED STANCE ROW was created — when the ballot was issued
// (the poll opened, or the voter was added later), or, for a vote Loomio
// replaced on change (`StanceService.update` builds a new row with
// `cast_at = now` and flips the old one to `latest: false` when the
// position changed after a reply or after 15 minutes; `uncast` does the
// same), the month it was changed — not necessarily the month it was
// first cast. The row set is
// `Membership.where(group_id: ids).pluck(:user_id)` — no `.active` —
// so everyone who EVER held a membership in the groups gets a row,
// revoked and deactivated accounts included; zero rows are normal and
// mean "no counted activity", never "not a member".
//
// Authorization: `authenticate_api_key!` only. A 403 here is the key
// (`classifyForbidden` says exactly that for /b2/reports), never a
// group; visibility is the silent intersection above.

/** `YYYY-MM` — the only shape ParticipationReportService parses without a 500. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const monthSchema = z
  .string()
  .regex(MONTH_RE, "must be a calendar month as YYYY-MM (e.g. 2026-03).");

/**
 * The `start_month` sent when a caller asks for ALL history. Loomio's
 * own default is 12 months ago, which would silently narrow "how active
 * has X ever been" to one year; the honest alternative is a floor no
 * instance's data can predate (Loomio's first release was in 2012).
 * `section=users` builds no per-interval series, so a wide window costs
 * Loomio nothing extra — and it saves the connector a first request
 * just to learn the response's `first_year`.
 */
export const ALL_HISTORY_START_MONTH = "2000-01";

/** UTC `YYYY-MM` of an instant. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `YYYY-MM` → `YYYY-MM-01`, the first instant Loomio counts for that month. */
export function firstDayOf(month: string): string {
  return `${month}-01`;
}

/** The `YYYY-MM` after `month` (December rolls the year). */
export function monthAfter(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** `YYYY-MM` that is `count` months before `month` (`count` ≥ 0). */
export function monthsBefore(month: string, count: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) - count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Inclusive number of months from `start` to `end` (`YYYY-MM` each, start ≤ end). */
export function monthSpan(start: string, end: string): number {
  const [sy, sm] = start.split("-").map(Number) as [number, number];
  const [ey, em] = end.split("-").map(Number) as [number, number];
  return (ey - sy) * 12 + (em - sm) + 1;
}

/**
 * The month window a since/until pair maps to. Both bounds widen, never
 * narrow: `since` is rounded DOWN to the first of its month, `until`
 * (exclusive — "ignore items at or after") to the END of the last month
 * that has any instant before it, so an `until` sitting exactly on a
 * month boundary does not drag the following month in. `since` absent
 * means all history (`ALL_HISTORY_START_MONTH`); `until` absent means
 * through the current month. `since_effective` / `until_effective` are
 * the ISO dates the counts actually cover (`until_effective` exclusive),
 * so a caller sees the rounding instead of inferring it.
 */
export interface MonthWindow {
  start_month: string;
  end_month: string;
  since_effective: string;
  until_effective: string;
}

export function monthWindow(
  since: string | undefined,
  until: string | undefined,
  now: number = Date.now(),
): MonthWindow {
  const start = since !== undefined ? monthKey(Date.parse(since)) : ALL_HISTORY_START_MONTH;
  const end = until !== undefined ? monthKey(Date.parse(until) - 1) : monthKey(now);
  if (start > end) {
    throw new Error(
      `since (${since}) falls after the last month the window can cover (${end}); Loomio's ` +
        "participation report is month-grained, so pass a since no later than the month of until " +
        "(or the current month).",
    );
  }
  return {
    start_month: start,
    end_month: end,
    since_effective: firstDayOf(start),
    until_effective: firstDayOf(monthAfter(end)),
  };
}

// ── Row shaping ─────────────────────────────────────────────────────────────

export const ACTIVITY_COUNT_FIELDS = [
  "threads",
  "comments",
  "polls",
  "votes",
  "votes_cast",
  "votes_issued",
  "votes_missed",
  "outcomes",
  "reactions",
] as const;

export type ActivityCountField = (typeof ACTIVITY_COUNT_FIELDS)[number];

export interface ActivityCounts extends Record<ActivityCountField, number> {
  /**
   * threads + comments + polls + votes + outcomes: the things a member
   * DID. `reactions` are left out (a click, not a contribution) and so
   * are `votes_issued` / `votes_missed` (what happened TO the member).
   * The same formula orders get_participation_report's rows.
   */
  total: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function activityTotal(c: Record<ActivityCountField, number>): number {
  return c.threads + c.comments + c.polls + c.votes + c.outcomes;
}

/** The nine counters of one report row (zeros for a missing row) plus `total`. */
export function shapeCounts(row: LoomioReportUserRow | undefined): ActivityCounts {
  const base = Object.fromEntries(
    ACTIVITY_COUNT_FIELDS.map((field) => [field, count(row?.[field])]),
  ) as Record<ActivityCountField, number>;
  return { ...base, total: activityTotal(base) };
}

export function sumCounts(rows: readonly ActivityCounts[]): ActivityCounts {
  const base = Object.fromEntries(
    ACTIVITY_COUNT_FIELDS.map((field) => [field, rows.reduce((acc, r) => acc + r[field], 0)]),
  ) as Record<ActivityCountField, number>;
  return { ...base, total: activityTotal(base) };
}

const EMPTY_COUNTS: ActivityCounts = shapeCounts(undefined);

/** `all_groups[]` as an id → name map; tolerant of a missing or odd root. */
function groupNames(body: ReportsUsersResponse): Map<number, string | null> {
  const names = new Map<number, string | null>();
  for (const g of Array.isArray(body.all_groups) ? body.all_groups : []) {
    if (g && typeof g.id === "number") names.set(g.id, g.name ?? null);
  }
  return names;
}

/** The echoed effective group set; `fallback` when the response lacks one (never invent a drop). */
function echoedGroupIds(body: ReportsUsersResponse, fallback: number[]): number[] {
  return Array.isArray(body.group_ids)
    ? body.group_ids.filter((id) => typeof id === "number")
    : fallback;
}

interface ReportRequest {
  scope: "custom" | "my";
  group_ids: number[];
  start_month: string;
  end_month: string;
  delegates_only?: boolean;
}

/**
 * The one request shape this module sends. No `interval` (it has no
 * effect on `section=users` and an invalid value is a 500), no
 * `compact` / `exclude_types` (the response is a plain hash), and the
 * months are validated before they get here so a malformed value can
 * never turn into Loomio's 500.
 */
async function fetchUsersReport(req: ReportRequest): Promise<ReportsUsersResponse> {
  return loomioGet<ReportsUsersResponse>("/b2/reports", {
    section: "users",
    group_scope: req.scope,
    ...(req.scope === "custom" ? { group_ids: csvParam(req.group_ids) } : {}),
    start_month: req.start_month,
    end_month: req.end_month,
    ...(req.delegates_only ? { member_type: "delegate" } : {}),
  });
}

/**
 * Run `worker` over `items` with at most `limit` in flight, results in
 * input order. A worker that throws aborts the whole map — used here
 * only for the errors that are never about one item (a rejected key) —
 * and the abort is shared: `Promise.all` rejects at once, and the other
 * lanes, whose requests are still open, stop pulling further items when
 * theirs resolve instead of issuing more calls with a key Loomio just
 * refused (tests/reports.test.ts pins both the cap and this stop).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let aborted = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (aborted) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i] as T);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

// ── get_user_activity ───────────────────────────────────────────────────────
//
// One report call PER GROUP (so the answer can say where the activity
// was), plus one author-mode search for recent, linkable examples.
// N + 1 upstream requests for N groups, at most `REPORT_CONCURRENCY` in
// flight — the 0.0.11 version fanned out over every discussion in the
// groups (hundreds of calls) and, against Loomio ≥ 3.4.0, could not
// work at all (the v1 events endpoint it read is gone).
//
// Honesty rules, kept from 0.0.11: a group Loomio silently dropped
// (not a member) is NAMED in `scope.groups_not_visible`, a report call
// that errored is named in `scope.groups_failed`, `scope.complete` is
// false whenever either list is non-empty, and a call in which EVERY
// report failed throws instead of returning zeros that read as "this
// user did nothing". A 403 aborts immediately: on /b2/reports it can
// only mean the key.

/** Report calls in flight at once. Well under Loomio's Rack::Attack budget even for 50 groups. */
export const REPORT_CONCURRENCY = 4;

export const getUserActivitySchema = z
  .object({
    user_id: positiveId.describe("Loomio user id."),
    group_ids: z.array(positiveId).min(1).max(50).describe("Group ids (1-50); 1 call each."),
    since: isoTimestamp.describe(
      "ISO-8601 start, rounded down to its month. Default: all history.",
    ),
    until: isoTimestamp.describe(
      "ISO-8601 end (exclusive), rounded out to a whole month. Default: now.",
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

export type GetUserActivityInput = z.infer<typeof getUserActivitySchema>;

export interface GroupActivity extends ActivityCounts {
  group_id: number;
  /** From the report's `all_groups`; null when Loomio did not name it. */
  name: string | null;
  /**
   * False when Loomio's report has no row for this user in this group:
   * the user never held a membership there (current or revoked), so
   * anything it may have posted there as a guest is NOT counted.
   */
  listed: boolean;
  /** The user holds an active delegate membership in this group. */
  delegate: boolean;
}

export interface ActivitySample {
  type: SearchHit["type"];
  /** The record's own id (discussion, comment, poll, stance or outcome). */
  id: number;
  title: string | null;
  group: SearchHit["group"];
  authored_at: string | null;
  url?: string;
  /** Only when a since/until window was given: whether the counts include this item's month. */
  in_window?: boolean;
}

export interface UserActivityResult {
  user_id: number;
  /** null when no reported group has a row for the user. */
  user: { id: number; name: string | null; delegate_in: number[] } | null;
  /** Summed over the reported groups. */
  counts: ActivityCounts;
  /** One row per group Loomio reported on, in the order requested. */
  by_group: GroupActivity[];
  /** `authored_at` of the newest sample, i.e. the user's most recent visible item in these groups. */
  latest_item_at: string | null;
  sample_events: ActivitySample[];
  scope: {
    group_ids: number[];
    /** Groups Loomio actually reported on (echoed `group_ids`). */
    groups_reported: number[];
    /** Requested groups Loomio dropped silently: the connector's user is not a member. Counts exclude them. */
    groups_not_visible: number[];
    /** Requested groups whose report call errored (5xx / timeout). Counts exclude them. */
    groups_failed: number[];
    /** True only when every requested group was reported on. */
    complete: boolean;
    month_granularity: true;
    since_requested: string | null;
    until_requested: string | null;
    /** First day counted (inclusive), after rounding to whole months. */
    since_effective: string;
    /** First day NOT counted (exclusive). */
    until_effective: string;
    /** Loomio's `first_year`: the creation year of the oldest group the user can report on. */
    first_year: number | null;
    /** Report calls + the search: N + 1. */
    upstream_calls: number;
    samples: {
      /** Rows the author search returned (≤ 20). */
      fetched: number;
      /** Rows kept after the group filter. */
      returned: number;
      /** `upstream` when one group was requested (group_id sent to Loomio), `client` when several (filtered here). */
      group_filter: "upstream" | "client";
      /** Set when the search failed; the counts are unaffected. */
      error?: string;
    };
    note: string;
  };
}

const ACTIVITY_NOTE =
  "Counts come from Loomio's participation report (GET /b2/reports?section=users), one call per " +
  "group, for whole calendar months (since/until rounded outward; see since_effective / " +
  "until_effective). Anonymous polls never count toward votes; a vote is counted in the month its " +
  "counted stance row was created — when the ballot was issued (poll opened, or the voter added " +
  "later) or, for a vote Loomio replaced on change, when it was changed — not necessarily when it was " +
  "first cast. A group in groups_not_visible was dropped by Loomio " +
  "because the connector's user is not a member — its activity is NOT in the counts. There is no " +
  "per-month breakdown per user (Loomio's report has none); call again with a narrower since/until " +
  "for a period figure. sample_events are the user's newest visible items from search_content's " +
  "author mode (at most 20, no date filter), not a complete list.";

type ReportOutcome =
  | { group_id: number; ok: true; body: ReportsUsersResponse }
  | { group_id: number; ok: false; error: unknown };

/**
 * One group's report, with the failures that are ABOUT that group folded
 * into the result and the failures that are not (the key: 403 / 401)
 * rethrown so the whole call aborts with the client's explanation.
 */
async function reportForGroup(groupId: number, window: MonthWindow): Promise<ReportOutcome> {
  try {
    const body = await fetchUsersReport({
      scope: "custom",
      group_ids: [groupId],
      start_month: window.start_month,
      end_month: window.end_month,
    });
    return { group_id: groupId, ok: true, body };
  } catch (err) {
    if (err instanceof LoomioAuthError) throw err;
    return { group_id: groupId, ok: false, error: err };
  }
}

/** One search result as an activity sample (the fields a caller needs to name and open it). */
export function shapeSample(
  hit: SearchHit,
  window?: { since: number; until: number },
): ActivitySample {
  const sample: ActivitySample = {
    type: hit.type,
    id: hit.id,
    title: hit.title,
    group: hit.group,
    authored_at: hit.authored_at,
    ...(hit.url ? { url: hit.url } : {}),
  };
  if (window) {
    const t = hit.authored_at ? Date.parse(hit.authored_at) : Number.NaN;
    sample.in_window = !Number.isNaN(t) && t >= window.since && t < window.until;
  }
  return sample;
}

export async function getUserActivity(input: GetUserActivityInput): Promise<UserActivityResult> {
  const groupIds = [...new Set(input.group_ids)];
  const window = monthWindow(input.since, input.until);
  const windowed = input.since !== undefined || input.until !== undefined;

  // The search runs alongside the reports; its failure is folded into
  // `scope.samples.error` rather than failing the counts, and its
  // rejection is caught HERE so an aborted report fan-out (rotated key)
  // never leaves it dangling as an unhandled rejection.
  const singleGroup = groupIds.length === 1 ? groupIds[0] : undefined;
  const searchPromise: Promise<{ hits: SearchHit[]; error?: string }> = loomioGet<SearchResponse>(
    "/b2/search",
    {
      author_id: input.user_id,
      ...(singleGroup !== undefined ? { group_id: singleGroup } : {}),
      ...readParams("compact"),
    },
  )
    // Same shaping as search_content, stance gate included: a sample of
    // the user's votes must not show reasons the poll still hides.
    .then((body) => ({ hits: shapeSearchHits(body) }))
    .catch((err: unknown) => ({
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    }));

  const outcomes = await mapWithConcurrency(groupIds, REPORT_CONCURRENCY, (gid) =>
    reportForGroup(gid, window),
  );

  const failed = outcomes.filter((o): o is Extract<ReportOutcome, { ok: false }> => !o.ok);
  if (failed.length === groupIds.length) {
    const last = failed[failed.length - 1]?.error;
    const reason = last instanceof Error ? last.message : String(last);
    // Consume the search result so nothing is left in flight unobserved.
    await searchPromise;
    throw new Error(
      `get_user_activity could not read Loomio's participation report for any of the ` +
        `${groupIds.length} requested group(s) (${groupIds.join(", ")}), so no activity can be ` +
        `reported. Last error: ${reason}`,
    );
  }

  const names = new Map<number, string | null>();
  const reported: number[] = [];
  const notVisible: number[] = [];
  const byGroup: GroupActivity[] = [];
  let firstYear: number | null = null;
  let userName: string | null = null;
  const delegateIn: number[] = [];
  let listedAnywhere = false;

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const { group_id: gid, body } = outcome;
    for (const [id, name] of groupNames(body)) if (!names.has(id)) names.set(id, name);
    if (typeof body.first_year === "number" && firstYear === null) firstYear = body.first_year;
    if (!echoedGroupIds(body, [gid]).includes(gid)) {
      notVisible.push(gid);
      continue;
    }
    reported.push(gid);
    const row = (Array.isArray(body.users) ? body.users : []).find((u) => u.id === input.user_id);
    if (row) {
      listedAnywhere = true;
      if (userName === null && typeof row.name === "string") userName = row.name;
      if (row.delegate === true) delegateIn.push(gid);
    }
    byGroup.push({
      group_id: gid,
      name: names.get(gid) ?? null,
      listed: Boolean(row),
      delegate: row?.delegate === true,
      ...(row ? shapeCounts(row) : EMPTY_COUNTS),
    });
  }

  const search = await searchPromise;
  const inScope =
    singleGroup !== undefined
      ? search.hits
      : search.hits.filter((h) => h.group !== null && groupIds.includes(h.group.id));
  const bounds = windowed
    ? { since: Date.parse(window.since_effective), until: Date.parse(window.until_effective) }
    : undefined;
  const samples = inScope.map((h) => shapeSample(h, bounds));
  const latest = samples.reduce<string | null>(
    (acc, s) => (s.authored_at && (!acc || s.authored_at > acc) ? s.authored_at : acc),
    null,
  );

  return {
    user_id: input.user_id,
    user: listedAnywhere ? { id: input.user_id, name: userName, delegate_in: delegateIn } : null,
    counts: sumCounts(byGroup),
    by_group: byGroup,
    latest_item_at: latest,
    sample_events: samples,
    scope: {
      group_ids: groupIds,
      groups_reported: reported,
      groups_not_visible: notVisible,
      groups_failed: failed.map((f) => f.group_id),
      complete: notVisible.length === 0 && failed.length === 0,
      month_granularity: true,
      since_requested: input.since ?? null,
      until_requested: input.until ?? null,
      since_effective: window.since_effective,
      until_effective: window.until_effective,
      first_year: firstYear,
      upstream_calls: groupIds.length + 1,
      samples: {
        fetched: search.hits.length,
        returned: samples.length,
        group_filter: singleGroup !== undefined ? "upstream" : "client",
        ...(search.error ? { error: search.error } : {}),
      },
      note: ACTIVITY_NOTE,
    },
  };
}

// ── get_participation_report ────────────────────────────────────────────────
//
// ONE call for the whole group set: the service takes the comma-
// separated ids together (`topics.group_id IN (…)`), so a user active in
// several of the groups gets one combined row, and the row set is the
// union of their memberships. This is the tool for ranking a group (or
// a family of groups) — get_user_activity is one member at a time.
//
// The row set Loomio returns is every user who EVER held a membership
// in the groups (see the module note), which for a mature group is
// mostly all-zero rows: former members, deactivated accounts, lurkers.
// A ranking that relays 300 zero rows to answer "who is most engaged"
// pays for them on every call, so the tool DROPS zero-`total` rows
// unless `include_inactive` is set, then cuts the sorted list at
// `limit`. `total_users` is the ranked size before that cut and
// `scope.inactive_dropped` the rows the filter removed, so a reader can
// always see what was left out; the note states both rules per call.

/** Months in the default window: the current month and the eleven before it. */
export const DEFAULT_REPORT_MONTHS = 12;

/** Rows returned when `limit` is absent: enough for a ranking, not a roster dump. */
export const DEFAULT_REPORT_LIMIT = 50;

/** Ceiling on `limit`: above this the caller wants an export, not an answer. */
export const MAX_REPORT_LIMIT = 500;

export const getParticipationReportSchema = z
  .object({
    group_ids: z
      .array(positiveId)
      .min(1)
      .max(50)
      .optional()
      .describe("Group ids counted together (1-50); required unless group_scope 'my'."),
    group_scope: z
      .enum(["custom", "my"])
      .optional()
      .describe("'custom' (default) = given group_ids; 'my' = the user's groups."),
    start_month: monthSchema
      .optional()
      .describe(
        `First month, YYYY-MM. Default: ${DEFAULT_REPORT_MONTHS - 1} months before end_month.`,
      ),
    end_month: monthSchema.optional().describe("Last month, YYYY-MM. Default: the current month."),
    delegates_only: z
      .boolean()
      .optional()
      .describe("Only users with an active delegate role. Default false."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_REPORT_LIMIT)
      .optional()
      .describe(
        `Rows after sorting by total desc (1-${MAX_REPORT_LIMIT}). Default ${DEFAULT_REPORT_LIMIT}.`,
      ),
    include_inactive: z
      .boolean()
      .optional()
      .describe("Also list users with total 0 (ever-members). Default false."),
  })
  .superRefine((input, ctx) => {
    const scope = input.group_scope ?? "custom";
    if (scope === "my" && input.group_ids !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["group_ids"],
        message: "group_scope 'my' reports on all member groups; do not pass group_ids with it.",
      });
    }
    if (scope === "custom" && input.group_ids === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["group_ids"],
        message: "Pass group_ids (1–50), or group_scope 'my' for every member group.",
      });
    }
    if (input.start_month && input.end_month && input.start_month > input.end_month) {
      ctx.addIssue({
        code: "custom",
        path: ["end_month"],
        message: "end_month must not be earlier than start_month.",
      });
    }
  });

export type GetParticipationReportInput = z.infer<typeof getParticipationReportSchema>;

export interface ParticipationRow extends ActivityCounts {
  user_id: number;
  name: string | null;
  /** Active delegate membership in at least one of the groups. */
  delegate: boolean;
  /** Every ballot issued to the user in the window was cast (and at least one was issued). */
  all_votes_cast: boolean;
}

export interface ParticipationReportResult {
  /** Ranked by `total` desc, zero-`total` rows dropped unless `include_inactive`, cut at `limit`. */
  users: ParticipationRow[];
  /** Ranked rows BEFORE the `limit` cut (after the inactive filter). */
  total_users: number;
  /** Rows in `users`: min(total_users, limit). */
  returned: number;
  /** The groups Loomio actually counted (its echoed `group_ids`), with names. */
  groups: Array<{ id: number; name: string | null }>;
  /** Requested groups Loomio dropped silently: the connector's user is not a member. */
  groups_not_visible: number[];
  period: {
    start_month: string;
    end_month: string;
    /** First day counted (inclusive). */
    since_effective: string;
    /** First day NOT counted (exclusive). */
    until_effective: string;
    months: number;
  };
  scope: {
    group_scope: "custom" | "my";
    delegates_only: boolean;
    /** The cap applied to the sorted rows (input `limit` or the default). */
    limit: number;
    include_inactive: boolean;
    /** Rows removed for `total` 0; always 0 when `include_inactive`. */
    inactive_dropped: number;
    /** False when a requested group was dropped. */
    complete: boolean;
    first_year: number | null;
    upstream_calls: 1;
    note: string;
  };
}

/**
 * The per-call note: the two shaping rules with THIS call's numbers, so
 * "showing 50 of 120" is read from the note and not inferred, then the
 * facts about the counts that hold for every row.
 */
export function reportNote(opts: {
  limit: number;
  includeInactive: boolean;
  totalUsers: number;
  returned: number;
  inactiveDropped: number;
}): string {
  const cut =
    opts.totalUsers > opts.returned
      ? `showing the top ${opts.returned} of ${opts.totalUsers} ranked users (limit ${opts.limit}; raise it for more)`
      : `all ${opts.totalUsers} ranked users shown (limit ${opts.limit})`;
  const inactive = opts.includeInactive
    ? "include_inactive is on: rows include everyone who ever held a membership in the groups — " +
      "revoked and deactivated accounts too — so a zero row means 'no counted activity', not 'inactive member'"
    : `${opts.inactiveDropped} user(s) with no counted activity in the period were dropped (the row set ` +
      "is everyone who ever held a membership, revoked and deactivated accounts included); pass " +
      "include_inactive: true to list them";
  return (
    `Loomio's participation report in one call, whole calendar months, sorted by total desc ` +
    `(total = threads + comments + polls + votes + outcomes); ${cut}. ${inactive}. Anonymous polls ` +
    "never count toward votes; a vote is counted in the month its counted stance row was created " +
    "(ballot issued, or vote changed), not necessarily when first cast; guests' content is not " +
    "counted. `groups` is what Loomio counted; groups_not_visible were dropped because the " +
    "connector's user is not a member."
  );
}

/** One report row as the tool presents it: country dropped, `total` added. */
export function shapeParticipationRow(row: LoomioReportUserRow): ParticipationRow {
  return {
    user_id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    delegate: row.delegate === true,
    all_votes_cast: row.all_votes_cast === true,
    ...shapeCounts(row),
  };
}

/** `total` desc, then name (case-insensitive), then id — so ties are stable and readable. */
export function compareParticipation(a: ParticipationRow, b: ParticipationRow): number {
  if (b.total !== a.total) return b.total - a.total;
  const byName = (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.user_id - b.user_id;
}

export async function getParticipationReport(
  input: GetParticipationReportInput,
): Promise<ParticipationReportResult> {
  const scope: "custom" | "my" = input.group_scope ?? "custom";
  const groupIds = [...new Set(input.group_ids ?? [])];
  const endMonth = input.end_month ?? monthKey(Date.now());
  const startMonth = input.start_month ?? monthsBefore(endMonth, DEFAULT_REPORT_MONTHS - 1);
  if (startMonth > endMonth) {
    throw new Error(
      `start_month (${startMonth}) is later than end_month (${endMonth}); pass an end_month at or ` +
        "after start_month (end_month defaults to the current month).",
    );
  }

  const body = await fetchUsersReport({
    scope,
    group_ids: groupIds,
    start_month: startMonth,
    end_month: endMonth,
    delegates_only: Boolean(input.delegates_only),
  });

  const names = groupNames(body);
  const echoed = echoedGroupIds(body, groupIds);
  const notVisible = scope === "custom" ? groupIds.filter((id) => !echoed.includes(id)) : [];
  const includeInactive = Boolean(input.include_inactive);
  const limit = input.limit ?? DEFAULT_REPORT_LIMIT;
  const all = (Array.isArray(body.users) ? body.users : [])
    .filter((u) => u && typeof u.id === "number")
    .map(shapeParticipationRow);
  // Filter, THEN sort, THEN cut: the cut must fall on the ranking the
  // caller asked for, never on Loomio's arbitrary row order.
  const ranked = all.filter((row) => includeInactive || row.total > 0).sort(compareParticipation);
  const users = ranked.slice(0, limit);
  const inactiveDropped = all.length - ranked.length;

  return {
    users,
    total_users: ranked.length,
    returned: users.length,
    groups: echoed.map((id) => ({ id, name: names.get(id) ?? null })),
    groups_not_visible: notVisible,
    period: {
      start_month: startMonth,
      end_month: endMonth,
      since_effective: firstDayOf(startMonth),
      until_effective: firstDayOf(monthAfter(endMonth)),
      months: monthSpan(startMonth, endMonth),
    },
    scope: {
      group_scope: scope,
      delegates_only: Boolean(input.delegates_only),
      limit,
      include_inactive: includeInactive,
      inactive_dropped: inactiveDropped,
      complete: notVisible.length === 0,
      first_year: typeof body.first_year === "number" ? body.first_year : null,
      upstream_calls: 1,
      note: reportNote({
        limit,
        includeInactive,
        totalUsers: ranked.length,
        returned: users.length,
        inactiveDropped,
      }),
    },
  };
}
