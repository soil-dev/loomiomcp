/**
 * get_user_activity and get_participation_report on Loomio 3.8's
 * GET /b2/reports?section=users (src/tools/reports.ts): month-window
 * rounding, request shape (one report per group plus one author search;
 * one aggregated report for the ranking), row parsing and summing, the
 * silent-drop fence surfaced as groups_not_visible, partial and total
 * failure handling, sample mapping, and the participation ordering.
 * Fixture shapes follow live 3.8.1 captures (tests/fixtures.ts).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { LoomioAuthError } from "../src/loomio/client.js";
import { reportsUsersBody, reportUserRow, searchAuthorBody, searchResultRow } from "./fixtures.js";
import { expectBearerAuth, fetchCallsTo, mockFetch, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
afterEach(() => vi.useRealTimers());

const NOW = new Date("2026-09-20T10:00:00Z");

/** Only `Date` is faked: the HTTP client's request-deadline timers stay real. */
function freezeClock(at: Date = NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

type Route = { status: number; body: unknown } | Error;

/**
 * Route by the FULL url. The activity fan-out hits one path
 * (`/b2/reports`) with a different `group_ids` per call and runs the
 * search in parallel, so neither `mockFetch`'s FIFO queue nor the
 * path-suffix router fits.
 */
function mockByUrl(resolve: (url: URL) => Route): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input));
    const hit = resolve(url);
    if (hit instanceof Error) throw hit;
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      headers: new Headers(),
      json: async () => hit.body,
      text: async () => (typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body)),
      statusText: String(hit.status),
    } as Awaited<ReturnType<typeof fetch>>;
  });
}

const urlsTo = (suffix: string): URL[] => fetchCallsTo(suffix).map(([u]) => new URL(String(u)));

/** Grace's row in the Finance Team (group 12): different numbers so sums are checkable. */
const FINANCE_ROWS = [
  reportUserRow({
    id: 502,
    threads: 1,
    comments: 4,
    polls: 0,
    votes: 2,
    votes_cast: 2,
    votes_issued: 2,
    votes_missed: 0,
    all_votes_cast: true,
    outcomes: 0,
    reactions: 1,
  }),
  reportUserRow({
    id: 501,
    name: "Ada Example",
    threads: 0,
    comments: 0,
    polls: 0,
    votes_issued: 0,
    votes_missed: 0,
    outcomes: 0,
  }),
];

const GENERIC_403 = { error: "You are not authorized to access this page." };

/**
 * Group 7 → the Example Org report, group 12 → Finance, anything else →
 * what Loomio does for a group the user is not a member of: `group_ids`
 * echoes nothing and `users` is empty. `overrides` swap one group's
 * answer; `search` the author search's.
 */
function mockActivity(
  overrides: Record<number, Route> = {},
  search: Route = { status: 200, body: searchAuthorBody() },
): void {
  mockByUrl((url) => {
    if (url.pathname.endsWith("/b2/search")) return search;
    if (url.pathname.endsWith("/b2/reports")) {
      const gid = Number(url.searchParams.get("group_ids"));
      const override = overrides[gid];
      if (override) return override;
      if (gid === 7) return { status: 200, body: reportsUsersBody() };
      if (gid === 12) {
        return { status: 200, body: reportsUsersBody({ group_ids: [12], users: FINANCE_ROWS }) };
      }
      return { status: 200, body: reportsUsersBody({ group_ids: [], users: [] }) };
    }
    throw new Error(`unmocked route: ${url.pathname}`);
  });
}

// ── Month helpers ───────────────────────────────────────────────────────────

describe("month helpers", () => {
  it("monthKey is the UTC calendar month", async () => {
    const { monthKey } = await import("../src/tools/reports.js");
    expect(monthKey(Date.parse("2026-03-31T23:59:59Z"))).toBe("2026-03");
    expect(monthKey(Date.parse("2026-04-01T00:00:00Z"))).toBe("2026-04");
  });

  it("monthAfter / monthsBefore / monthSpan roll years correctly", async () => {
    const { monthAfter, monthsBefore, monthSpan } = await import("../src/tools/reports.js");
    expect(monthAfter("2026-12")).toBe("2027-01");
    expect(monthAfter("2026-03")).toBe("2026-04");
    expect(monthsBefore("2026-09", 11)).toBe("2025-10");
    expect(monthsBefore("2026-01", 1)).toBe("2025-12");
    expect(monthsBefore("2026-09", 0)).toBe("2026-09");
    expect(monthSpan("2025-10", "2026-09")).toBe(12);
    expect(monthSpan("2026-03", "2026-03")).toBe(1);
  });

  it("monthWindow rounds since DOWN to its month and until UP to the end of the last started month", async () => {
    const { monthWindow } = await import("../src/tools/reports.js");
    const w = monthWindow("2026-03-15T12:00:00Z", "2026-05-10T00:00:00Z");
    expect(w.start_month).toBe("2026-03");
    expect(w.end_month).toBe("2026-05");
    expect(w.since_effective).toBe("2026-03-01");
    expect(w.until_effective).toBe("2026-06-01");
  });

  it("monthWindow: an until exactly on a month boundary does NOT pull the next month in", async () => {
    const { monthWindow } = await import("../src/tools/reports.js");
    expect(monthWindow("2026-01-01", "2026-04-01T00:00:00Z").end_month).toBe("2026-03");
    expect(monthWindow("2026-01-01", "2026-04-01T00:00:00.001Z").end_month).toBe("2026-04");
  });

  it("monthWindow: since omitted = all history floor; until omitted = the current month", async () => {
    freezeClock();
    const { monthWindow, ALL_HISTORY_START_MONTH } = await import("../src/tools/reports.js");
    const w = monthWindow(undefined, undefined);
    expect(w.start_month).toBe(ALL_HISTORY_START_MONTH);
    expect(w.end_month).toBe("2026-09");
    expect(w.until_effective).toBe("2026-10-01");
    expect(ALL_HISTORY_START_MONTH).toMatch(/^\d{4}-\d{2}$/);
  });

  it("monthWindow refuses a since after the last month it could cover", async () => {
    freezeClock();
    const { monthWindow } = await import("../src/tools/reports.js");
    expect(() => monthWindow("2027-01-01", undefined)).toThrow(/month-grained/);
    // Same month is fine: since and until inside March.
    expect(monthWindow("2026-03-10", "2026-03-20").end_month).toBe("2026-03");
  });

  it("MONTH_RE accepts YYYY-MM with a real month only", async () => {
    const { MONTH_RE } = await import("../src/tools/reports.js");
    expect(MONTH_RE.test("2026-01")).toBe(true);
    expect(MONTH_RE.test("2026-12")).toBe(true);
    expect(MONTH_RE.test("2026-13")).toBe(false);
    expect(MONTH_RE.test("2026-00")).toBe(false);
    expect(MONTH_RE.test("2026-1")).toBe(false);
    expect(MONTH_RE.test("2026-01-01")).toBe(false);
    expect(MONTH_RE.test("")).toBe(false);
  });
});

// ── get_user_activity: schema ───────────────────────────────────────────────

describe("getUserActivitySchema", () => {
  it("requires 1–50 group ids", async () => {
    const { getUserActivitySchema } = await import("../src/tools/reports.js");
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: [] }).success).toBe(false);
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: [1] }).success).toBe(true);
    const big = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: big }).success).toBe(false);
  });

  it("rejects unparseable since/until and an inverted window", async () => {
    const { getUserActivitySchema } = await import("../src/tools/reports.js");
    const base = { user_id: 2, group_ids: [1] };
    expect(getUserActivitySchema.safeParse({ ...base, since: "last week" }).success).toBe(false);
    expect(getUserActivitySchema.safeParse({ ...base, until: "2026-13-99" }).success).toBe(false);
    expect(getUserActivitySchema.safeParse({ ...base, since: "2026-01-31" }).success).toBe(true);
    expect(
      getUserActivitySchema.safeParse({
        ...base,
        since: "2026-02-01T00:00:00Z",
        until: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});

// ── get_user_activity: request shape ────────────────────────────────────────

describe("getUserActivity — request shape", () => {
  it("one GET /b2/reports?section=users per group (group_ids=<id>, custom scope, both months, no interval / compact) plus one author search", async () => {
    freezeClock();
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 12] });

    const reports = urlsTo("/b2/reports");
    expect(reports).toHaveLength(2);
    expect(reports.map((u) => u.searchParams.get("group_ids")).sort()).toEqual(["12", "7"]);
    for (const u of reports) {
      expect(u.pathname).toBe("/api/b2/reports");
      expect(u.searchParams.get("section")).toBe("users");
      expect(u.searchParams.get("group_scope")).toBe("custom");
      expect(u.searchParams.get("start_month")).toBe("2000-01");
      expect(u.searchParams.get("end_month")).toBe("2026-09");
      expect(u.searchParams.has("interval")).toBe(false);
      expect(u.searchParams.has("member_type")).toBe(false);
      expect(u.searchParams.has("compact")).toBe(false);
      expect(u.searchParams.has("exclude_types")).toBe(false);
    }

    const searches = urlsTo("/b2/search");
    expect(searches).toHaveLength(1);
    expect(searches[0]!.searchParams.get("author_id")).toBe("502");
    expect(searches[0]!.searchParams.get("compact")).toBe("1");
    expect(searches[0]!.searchParams.has("query")).toBe(false);
    // Two groups: no upstream group filter (the route takes one id), filtered client-side instead.
    expect(searches[0]!.searchParams.has("group_id")).toBe(false);
    expect(r.scope.samples.group_filter).toBe("client");
    expect(r.scope.upstream_calls).toBe(3);
    for (let i = 0; i < vi.mocked(fetch).mock.calls.length; i++) expectBearerAuth(i, "test-key");
  });

  it("a single group is sent to the search as group_id (upstream filter)", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7] });
    expect(urlsTo("/b2/search")[0]!.searchParams.get("group_id")).toBe("7");
    expect(r.scope.samples.group_filter).toBe("upstream");
    expect(r.scope.upstream_calls).toBe(2);
  });

  it("since/until become the rounded start_month/end_month and are echoed as the effective window", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({
      user_id: 502,
      group_ids: [7],
      since: "2026-02-14T09:00:00Z",
      until: "2026-06-01T00:00:00Z",
    });
    const u = urlsTo("/b2/reports")[0]!;
    expect(u.searchParams.get("start_month")).toBe("2026-02");
    expect(u.searchParams.get("end_month")).toBe("2026-05");
    expect(r.scope.since_requested).toBe("2026-02-14T09:00:00Z");
    expect(r.scope.until_requested).toBe("2026-06-01T00:00:00Z");
    expect(r.scope.since_effective).toBe("2026-02-01");
    expect(r.scope.until_effective).toBe("2026-06-01");
    expect(r.scope.month_granularity).toBe(true);
  });

  it("dedupes repeated group ids (one report call each)", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 7, 12, 7] });
    expect(urlsTo("/b2/reports")).toHaveLength(2);
    expect(r.scope.group_ids).toEqual([7, 12]);
  });
});

// ── get_user_activity: shaping ──────────────────────────────────────────────

describe("getUserActivity — shaping", () => {
  it("takes the user's row per group, names the groups, and sums the counts", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 12] });

    expect(r.user).toEqual({ id: 502, name: "Grace Sample", delegate_in: [] });
    expect(r.by_group).toHaveLength(2);
    const [org, finance] = r.by_group;
    expect(org).toMatchObject({
      group_id: 7,
      name: "Example Org",
      listed: true,
      delegate: false,
      threads: 3,
      comments: 2,
      polls: 1,
      votes: 0,
      votes_cast: 0,
      votes_issued: 1,
      votes_missed: 1,
      outcomes: 1,
      reactions: 0,
      total: 7,
    });
    expect(finance).toMatchObject({
      group_id: 12,
      name: "Finance Team",
      threads: 1,
      comments: 4,
      votes: 2,
      votes_issued: 2,
      reactions: 1,
      total: 7,
    });
    expect(r.counts).toEqual({
      threads: 4,
      comments: 6,
      polls: 1,
      votes: 2,
      votes_cast: 2,
      votes_issued: 3,
      votes_missed: 1,
      outcomes: 1,
      reactions: 1,
      total: 14,
    });
    // country never leaves the connector.
    expect(JSON.stringify(r)).not.toContain("Norway");
    expect(r.scope.groups_reported).toEqual([7, 12]);
    expect(r.scope.groups_not_visible).toEqual([]);
    expect(r.scope.groups_failed).toEqual([]);
    expect(r.scope.complete).toBe(true);
    expect(r.scope.first_year).toBe(2024);
    expect(r.by_group.every((g) => !("by_month" in g))).toBe(true);
    expect(r).not.toHaveProperty("by_month");
    expect(r.scope.note).toMatch(/no per-month breakdown/i);
  });

  it("reports the delegate flag per group and in user.delegate_in", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 503, group_ids: [7] });
    expect(r.user).toEqual({ id: 503, name: "Linus Placeholder", delegate_in: [7] });
    expect(r.by_group[0]).toMatchObject({ delegate: true, votes: 1, votes_issued: 1, total: 2 });
  });

  it("a group with no row for the user is listed:false with zero counts; user is null when no group lists them", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    // 504 (a former member) has a row in group 7 only; 999 has none anywhere.
    const former = await getUserActivity({ user_id: 504, group_ids: [7, 12] });
    expect(former.user).toEqual({ id: 504, name: "Former Member", delegate_in: [] });
    expect(former.by_group[0]).toMatchObject({ group_id: 7, listed: true, total: 0 });
    expect(former.by_group[1]).toMatchObject({ group_id: 12, listed: false, total: 0 });

    vi.mocked(fetch).mockClear();
    const stranger = await getUserActivity({ user_id: 999, group_ids: [7] });
    expect(stranger.user).toBeNull();
    expect(stranger.counts.total).toBe(0);
    expect(stranger.by_group[0]).toMatchObject({ listed: false });
    expect(stranger.scope.complete).toBe(true);
  });

  it("a group Loomio dropped from the echoed group_ids is groups_not_visible, not zeros", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 46] });
    expect(r.scope.groups_reported).toEqual([7]);
    expect(r.scope.groups_not_visible).toEqual([46]);
    expect(r.scope.complete).toBe(false);
    expect(r.by_group.map((g) => g.group_id)).toEqual([7]);
    expect(r.counts.total).toBe(7);
  });

  it("maps the author search into sample_events (type, id, title, group, authored_at, url) and filters to the requested groups client-side", async () => {
    const outOfScope = searchResultRow({
      id: 211200,
      searchable_type: "Comment",
      searchable_id: 1799,
      discussion_title: "Elsewhere",
      discussion_key: "dscKEY99",
      highlight: "not in a requested group",
      group_id: 99,
      group_name: "Other Org",
      group_handle: "other-org",
      authored_at: "2026-08-01T00:00:00Z",
    });
    const body = searchAuthorBody();
    mockActivity(
      {},
      {
        status: 200,
        body: { ...body, search_results: [...(body.search_results ?? []), outOfScope] },
      },
    );
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 12] });
    expect(r.scope.samples).toEqual({ fetched: 2, returned: 1, group_filter: "client" });
    expect(r.sample_events).toHaveLength(1);
    expect(r.sample_events[0]).toEqual({
      type: "Discussion",
      id: 602,
      title: "How to nominate a candidate",
      // `full_name`: the search controller emits the group's FULL name.
      group: { id: 7, full_name: "Example Org", handle: "example-org" },
      authored_at: "2026-07-27T12:41:31.329Z",
      url: "https://www.loomio.com/d/dscKEY02/how-to-nominate-a-candidate",
    });
    expect(r.sample_events[0]).not.toHaveProperty("in_window");
    expect(r.sample_events[0]).not.toHaveProperty("snippet");
    expect(r.latest_item_at).toBe("2026-07-27T12:41:31.329Z");
  });

  it("flags each sample in_window against the EFFECTIVE month window when since/until were given", async () => {
    mockActivity();
    const { getUserActivity } = await import("../src/tools/reports.js");
    // The sample is authored 2026-07-27; a window of March..May excludes it, one of July includes it.
    const outside = await getUserActivity({
      user_id: 502,
      group_ids: [7],
      since: "2026-03-01",
      until: "2026-06-01",
    });
    expect(outside.sample_events[0]?.in_window).toBe(false);
    vi.mocked(fetch).mockClear();
    const inside = await getUserActivity({
      user_id: 502,
      group_ids: [7],
      since: "2026-07-30", // rounds down to 2026-07-01, so the 27 July item IS counted
      until: "2026-08-01",
    });
    expect(inside.sample_events[0]?.in_window).toBe(true);
  });

  it("a failed search leaves the counts intact and records the error in scope.samples", async () => {
    mockActivity({}, { status: 500, body: { error: "boom" } });
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7] });
    expect(r.counts.total).toBe(7);
    expect(r.sample_events).toEqual([]);
    expect(r.latest_item_at).toBeNull();
    expect(r.scope.samples.fetched).toBe(0);
    expect(r.scope.samples.error).toMatch(/500/);
    expect(r.scope.complete).toBe(true);
  });

  it("one group's report failing is groups_failed + complete:false; the others still count", async () => {
    mockActivity({ 12: { status: 502, body: "Bad Gateway" } });
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 502, group_ids: [7, 12] });
    expect(r.scope.groups_failed).toEqual([12]);
    expect(r.scope.groups_reported).toEqual([7]);
    expect(r.scope.complete).toBe(false);
    expect(r.counts.total).toBe(7);
    expect(r.by_group.map((g) => g.group_id)).toEqual([7]);
  });

  it("every report failing → throws naming the groups and the last error, never zero counts", async () => {
    mockActivity({
      7: { status: 500, body: { error: "boom" } },
      12: { status: 504, body: "Gateway Timeout" },
    });
    const { getUserActivity } = await import("../src/tools/reports.js");
    const err = await getUserActivity({ user_id: 502, group_ids: [7, 12] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/participation report for any of the 2 requested group/);
    expect(err.message).toContain("7, 12");
    expect(err.message).toMatch(/Last error: .*50[04]/);
    expect(err).not.toHaveProperty("counts");
  });

  it("a 403 aborts immediately with the client's key explanation (reports never 403 for visibility)", async () => {
    mockActivity({ 7: { status: 403, body: GENERIC_403 }, 12: { status: 403, body: GENERIC_403 } });
    const { getUserActivity } = await import("../src/tools/reports.js");
    const err = await getUserActivity({ user_id: 502, group_ids: [7, 12] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toMatch(/visibility as a FILTER/);
    expect(err.message).toContain("/profile/api_access");
    expect(err).not.toHaveProperty("counts");
  });

  it("a 401 from an intermediary propagates too", async () => {
    mockActivity({ 7: { status: 401, body: { error: "proxy auth required" } } });
    const { getUserActivity } = await import("../src/tools/reports.js");
    await expect(getUserActivity({ user_id: 502, group_ids: [7] })).rejects.toThrow(/401/);
  });
});

// ── get_user_activity: the fan-out keeps at most REPORT_CONCURRENCY in flight ─
//
// The cap protects Loomio's Rack::Attack budget (900 requests / 5 min per
// IP) when a caller passes the schema maximum of 50 groups. Every other
// test resolves fetch synchronously, so an unbounded Promise.all would
// pass them identically; these hold each report open until released and
// count what is pending.

describe("getUserActivity — concurrency", () => {
  type Deferred = { url: URL; resolve: (r: Route) => void };

  /**
   * Route the author search immediately; hold every /b2/reports call in
   * `pending` until the test releases it. Returns the queue.
   */
  function mockDeferredReports(): Deferred[] {
    const pending: Deferred[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const hit: Route = await new Promise<Route>((resolve) => {
        if (url.pathname.endsWith("/b2/search")) {
          resolve({ status: 200, body: searchAuthorBody() });
          return;
        }
        if (!url.pathname.endsWith("/b2/reports")) {
          throw new Error(`unmocked route: ${url.pathname}`);
        }
        pending.push({ url, resolve });
      });
      if (hit instanceof Error) throw hit;
      return {
        status: hit.status,
        ok: hit.status >= 200 && hit.status < 300,
        headers: new Headers(),
        json: async () => hit.body,
        text: async () => (typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body)),
        statusText: String(hit.status),
      } as Awaited<ReturnType<typeof fetch>>;
    });
    return pending;
  }

  /** Let every queued microtask / continuation run without advancing real time. */
  const settle = () => new Promise<void>((r) => setImmediate(r));

  const gidOf = (d: Deferred) => Number(d.url.searchParams.get("group_ids"));

  it("with more groups than lanes, exactly REPORT_CONCURRENCY report requests are in flight; each release starts the next", async () => {
    const pending = mockDeferredReports();
    const { getUserActivity, REPORT_CONCURRENCY } = await import("../src/tools/reports.js");
    const groups = [11, 12, 13, 14, 15, 16, 17];
    expect(groups.length).toBeGreaterThan(REPORT_CONCURRENCY);
    const call = getUserActivity({ user_id: 502, group_ids: groups });
    await settle();

    // Peak: the first `REPORT_CONCURRENCY` groups, in input order, and no more.
    expect(pending).toHaveLength(REPORT_CONCURRENCY);
    expect(pending.map(gidOf)).toEqual(groups.slice(0, REPORT_CONCURRENCY));

    // Releasing ONE lane admits exactly ONE more request.
    const answer = (gid: number): Route => ({
      status: 200,
      body: reportsUsersBody({ group_ids: [gid], users: FINANCE_ROWS }),
    });
    pending[1]!.resolve(answer(gidOf(pending[1]!)));
    await settle();
    expect(pending).toHaveLength(REPORT_CONCURRENCY + 1);
    expect(gidOf(pending[REPORT_CONCURRENCY]!)).toBe(groups[REPORT_CONCURRENCY]);

    // Release the rest in queue order; after k releases at most
    // k + REPORT_CONCURRENCY requests may ever have been issued.
    let released = 1;
    for (let i = 0; i < groups.length; i++) {
      if (i === 1) continue;
      while (pending.length <= i) await settle();
      pending[i]!.resolve(answer(gidOf(pending[i]!)));
      released += 1;
      await settle();
      expect(pending.length).toBeLessThanOrEqual(released + REPORT_CONCURRENCY);
    }
    const r = await call;
    expect(pending).toHaveLength(groups.length);
    // Results come back in INPUT order regardless of completion order.
    expect(r.by_group.map((g) => g.group_id)).toEqual(groups);
    expect(r.scope.upstream_calls).toBe(groups.length + 1);
    expect(r.scope.complete).toBe(true);
  });

  it("a rejected-key 403 on one lane aborts the call: the lanes already in flight are the last requests issued", async () => {
    const pending = mockDeferredReports();
    const { getUserActivity, REPORT_CONCURRENCY } = await import("../src/tools/reports.js");
    const groups = [21, 22, 23, 24, 25, 26, 27, 28];
    const call = getUserActivity({ user_id: 502, group_ids: groups });
    await settle();
    expect(pending).toHaveLength(REPORT_CONCURRENCY);

    // The first lane comes back 403: LoomioAuthError is rethrown, the map
    // aborts, and the other lanes' loops stop pulling new groups.
    pending[0]!.resolve({ status: 403, body: GENERIC_403 });
    const err = await call.catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.kind).toBe("unauthenticated");
    // Nothing beyond the initial lanes was ever requested …
    expect(pending).toHaveLength(REPORT_CONCURRENCY);
    // … and releasing the still-open lanes afterwards starts nothing new.
    for (const d of pending.slice(1)) {
      d.resolve({ status: 200, body: reportsUsersBody({ group_ids: [gidOf(d)], users: [] }) });
    }
    await settle();
    await settle();
    expect(pending).toHaveLength(REPORT_CONCURRENCY);
    expect(pending.map(gidOf)).toEqual(groups.slice(0, REPORT_CONCURRENCY));
  });
});

// ── get_participation_report: schema ────────────────────────────────────────

describe("getParticipationReportSchema", () => {
  it("requires group_ids unless group_scope is 'my', and refuses both together", async () => {
    const { getParticipationReportSchema } = await import("../src/tools/reports.js");
    expect(getParticipationReportSchema.safeParse({}).success).toBe(false);
    expect(getParticipationReportSchema.safeParse({ group_ids: [7] }).success).toBe(true);
    expect(getParticipationReportSchema.safeParse({ group_scope: "my" }).success).toBe(true);
    expect(
      getParticipationReportSchema.safeParse({ group_scope: "my", group_ids: [7] }).success,
    ).toBe(false);
    expect(getParticipationReportSchema.safeParse({ group_ids: [] }).success).toBe(false);
    const big = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(getParticipationReportSchema.safeParse({ group_ids: big }).success).toBe(false);
  });

  it("months must be YYYY-MM and ordered", async () => {
    const { getParticipationReportSchema } = await import("../src/tools/reports.js");
    const ok = (extra: object) =>
      getParticipationReportSchema.safeParse({ group_ids: [7], ...extra }).success;
    expect(ok({ start_month: "2026-01", end_month: "2026-06" })).toBe(true);
    expect(ok({ start_month: "2026-06", end_month: "2026-06" })).toBe(true);
    expect(ok({ start_month: "2026-1" })).toBe(false);
    expect(ok({ start_month: "2026-01-01" })).toBe(false);
    expect(ok({ end_month: "2026-13" })).toBe(false);
    expect(ok({ start_month: "2026-07", end_month: "2026-06" })).toBe(false);
  });

  it("limit is an integer 1–500; include_inactive a boolean", async () => {
    const { getParticipationReportSchema, MAX_REPORT_LIMIT, DEFAULT_REPORT_LIMIT } = await import(
      "../src/tools/reports.js"
    );
    const ok = (extra: object) =>
      getParticipationReportSchema.safeParse({ group_ids: [7], ...extra }).success;
    expect(MAX_REPORT_LIMIT).toBe(500);
    expect(DEFAULT_REPORT_LIMIT).toBe(50);
    expect(ok({ limit: 1 })).toBe(true);
    expect(ok({ limit: MAX_REPORT_LIMIT })).toBe(true);
    expect(ok({ limit: 0 })).toBe(false);
    expect(ok({ limit: MAX_REPORT_LIMIT + 1 })).toBe(false);
    expect(ok({ limit: 2.5 })).toBe(false);
    expect(ok({ include_inactive: true })).toBe(true);
    expect(ok({ include_inactive: "yes" })).toBe(false);
  });
});

// ── Catalogue budget ────────────────────────────────────────────────────────
//
// Every input description is paid by every session before the first
// question (tools/list). The cap is the v0.0.12 writing rule; the
// long-form guidance lives in HOWTO.md, not here.

describe("input descriptions stay within the catalogue budget", () => {
  it("every .describe() in the report schemas is at most 120 characters", async () => {
    const { getUserActivitySchema, getParticipationReportSchema } = await import(
      "../src/tools/reports.js"
    );
    for (const schema of [getUserActivitySchema, getParticipationReportSchema]) {
      for (const [field, sub] of Object.entries(schema.shape)) {
        const text = sub.description ?? "";
        expect(text.length, `${field}: ${text}`).toBeGreaterThan(0);
        expect(text.length, `${field}: ${text}`).toBeLessThanOrEqual(120);
      }
    }
  });
});

// ── get_participation_report ────────────────────────────────────────────────

describe("getParticipationReport", () => {
  it("ONE GET /b2/reports with section=users, custom scope, comma-separated group_ids and the default 12-month window", async () => {
    freezeClock();
    mockFetch(200, reportsUsersBody({ group_ids: [7, 12] }));
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [7, 12] });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const u = urlsTo("/b2/reports")[0]!;
    expect(u.pathname).toBe("/api/b2/reports");
    expect(u.searchParams.get("section")).toBe("users");
    expect(u.searchParams.get("group_scope")).toBe("custom");
    expect(u.searchParams.get("group_ids")).toBe("7,12");
    expect(u.searchParams.has("group_ids[]")).toBe(false);
    expect(u.searchParams.get("start_month")).toBe("2025-10");
    expect(u.searchParams.get("end_month")).toBe("2026-09");
    expect(u.searchParams.has("member_type")).toBe(false);
    expect(u.searchParams.has("interval")).toBe(false);
    expect(u.searchParams.has("compact")).toBe(false);
    expectBearerAuth(0, "test-key");
    expect(r.period).toEqual({
      start_month: "2025-10",
      end_month: "2026-09",
      since_effective: "2025-10-01",
      until_effective: "2026-10-01",
      months: 12,
    });
    expect(r.scope.upstream_calls).toBe(1);
  });

  it("explicit months are sent verbatim; delegates_only adds member_type=delegate", async () => {
    mockFetch(200, reportsUsersBody());
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({
      group_ids: [7],
      start_month: "2026-01",
      end_month: "2026-03",
      delegates_only: true,
    });
    const u = urlsTo("/b2/reports")[0]!;
    expect(u.searchParams.get("start_month")).toBe("2026-01");
    expect(u.searchParams.get("end_month")).toBe("2026-03");
    expect(u.searchParams.get("member_type")).toBe("delegate");
    expect(r.period.months).toBe(3);
    expect(r.scope.delegates_only).toBe(true);
  });

  it("group_scope 'my' sends group_scope=my and NO group_ids", async () => {
    mockFetch(200, reportsUsersBody({ group_scope: "my", group_ids: [7, 12, 15] }));
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_scope: "my" });
    const u = urlsTo("/b2/reports")[0]!;
    expect(u.searchParams.get("group_scope")).toBe("my");
    expect(u.searchParams.has("group_ids")).toBe(false);
    expect(r.scope.group_scope).toBe("my");
    expect(r.groups).toEqual([
      { id: 7, name: "Example Org" },
      { id: 12, name: "Finance Team" },
      { id: 15, name: "Volunteers" },
    ]);
    expect(r.groups_not_visible).toEqual([]);
    expect(r.scope.complete).toBe(true);
  });

  it("rows: sorted by total desc, zero-total users DROPPED by default, country stripped, total and all_votes_cast present", async () => {
    mockFetch(200, reportsUsersBody());
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [7] });
    // The fixture has four rows; the bot (501) and the former member (504) have total 0.
    expect(r.users.map((u) => u.user_id)).toEqual([502, 503]);
    expect(r.returned).toBe(2);
    expect(r.total_users).toBe(2);
    expect(r.scope.inactive_dropped).toBe(2);
    expect(r.scope.include_inactive).toBe(false);
    expect(r.scope.limit).toBe(50);
    expect(r.users[0]).toEqual({
      user_id: 502,
      name: "Grace Sample",
      delegate: false,
      all_votes_cast: false,
      threads: 3,
      comments: 2,
      polls: 1,
      votes: 0,
      votes_cast: 0,
      votes_issued: 1,
      votes_missed: 1,
      outcomes: 1,
      reactions: 0,
      total: 7,
    });
    expect(r.users[1]).toMatchObject({
      user_id: 503,
      delegate: true,
      all_votes_cast: true,
      votes: 1,
      total: 2,
    });
    expect(JSON.stringify(r)).not.toMatch(/Norway|Portugal|country/);
    expect(r.scope.first_year).toBe(2024);
    // The note states both shaping rules with this call's numbers.
    expect(r.scope.note).toMatch(/2 user\(s\) with no counted activity .* were dropped/);
    expect(r.scope.note).toMatch(/include_inactive: true/);
    expect(r.scope.note).toMatch(/all 2 ranked users shown \(limit 50\)/);
    expect(r.scope.note).toMatch(/revoked and deactivated/);
  });

  it("include_inactive: true keeps the zero rows, ties broken alphabetically then by id", async () => {
    mockFetch(200, reportsUsersBody());
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [7], include_inactive: true });
    expect(r.users.map((u) => u.user_id)).toEqual([502, 503, 501, 504]);
    expect(r.returned).toBe(4);
    expect(r.total_users).toBe(4);
    expect(r.scope.inactive_dropped).toBe(0);
    expect(r.scope.include_inactive).toBe(true);
    // Zero-total rows tie → alphabetical: "Ada Example" before "Former Member".
    expect(r.users[2]!.name).toBe("Ada Example");
    expect(r.users[3]!.name).toBe("Former Member");
    expect(r.scope.note).toMatch(/include_inactive is on/);
    expect(r.scope.note).toMatch(/revoked and deactivated/);
    expect(r.scope.note).not.toMatch(/with no counted activity in the period were dropped/);
  });

  it("limit cuts AFTER the total-desc sort; total_users is the pre-cut size and the note says 'top N of M'", async () => {
    mockFetch(200, reportsUsersBody());
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [7], limit: 1 });
    expect(r.users.map((u) => u.user_id)).toEqual([502]);
    expect(r.returned).toBe(1);
    expect(r.total_users).toBe(2);
    expect(r.scope.limit).toBe(1);
    expect(r.scope.note).toMatch(/top 1 of 2 ranked users \(limit 1/);

    vi.mocked(fetch).mockClear();
    mockFetch(200, reportsUsersBody());
    // With the inactive rows kept the cut still lands on the ranking, so the
    // two zero rows are what falls off — never the most active user.
    const kept = await getParticipationReport({ group_ids: [7], limit: 3, include_inactive: true });
    expect(kept.users.map((u) => u.user_id)).toEqual([502, 503, 501]);
    expect(kept.total_users).toBe(4);
    expect(kept.returned).toBe(3);
    // Neither knob changes the wire: still one report request, no extra params.
    const u = urlsTo("/b2/reports")[0]!;
    expect(u.searchParams.has("limit")).toBe(false);
    expect(u.searchParams.has("include_inactive")).toBe(false);
  });

  it("echoes the groups Loomio counted with names and names the ones it dropped", async () => {
    // Requested 7, 12 and 46; Loomio (not a member of 46) reports on 7 and 12 only.
    mockFetch(200, reportsUsersBody({ group_ids: [7, 12] }));
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [7, 12, 46] });
    expect(r.groups).toEqual([
      { id: 7, name: "Example Org" },
      { id: 12, name: "Finance Team" },
    ]);
    expect(r.groups_not_visible).toEqual([46]);
    expect(r.scope.complete).toBe(false);
  });

  it("nothing visible: Loomio echoes no groups and no users; the tool says so rather than erroring", async () => {
    mockFetch(200, reportsUsersBody({ group_ids: [], users: [] }));
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const r = await getParticipationReport({ group_ids: [46] });
    expect(r.users).toEqual([]);
    expect(r.total_users).toBe(0);
    expect(r.returned).toBe(0);
    expect(r.scope.inactive_dropped).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.groups_not_visible).toEqual([46]);
    expect(r.scope.complete).toBe(false);
  });

  it("start_month later than the (defaulted) end_month is refused before any request", async () => {
    freezeClock();
    const { getParticipationReport } = await import("../src/tools/reports.js");
    await expect(
      getParticipationReport({ group_ids: [7], start_month: "2027-01" }),
    ).rejects.toThrow(/later than end_month/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a 403 is the key, explained by the client", async () => {
    mockFetch(403, GENERIC_403);
    const { getParticipationReport } = await import("../src/tools/reports.js");
    const err = await getParticipationReport({ group_ids: [7] }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.message).toContain("/profile/api_access");
  });
});
