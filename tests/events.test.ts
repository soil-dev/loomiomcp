import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("listEvents", () => {
  it("GETs /v1/events with discussion_id, per, from in the query", async () => {
    mockFetch(200, { events: [], meta: { root: "events" } });
    const { listEvents } = await import("../src/tools/events.js");
    await listEvents({ discussion_id: 218, limit: 25, offset: 50 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/v1/events?");
    expect(url).toContain("discussion_id=218");
    expect(url).toContain("per=25");
    expect(url).toContain("from=50");
    expect(url).toContain("api_key=test-key");
    expect((opts as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("returns the response untouched when no `kinds` filter is set", async () => {
    mockFetch(200, {
      events: [
        { id: 1, kind: "new_discussion", actor_id: 2 },
        { id: 2, kind: "new_comment", actor_id: 5 },
        { id: 3, kind: "reaction", actor_id: 5 },
      ],
      users: [{ id: 2 }, { id: 5 }],
      comments: [{ id: 100, body: "hi" }],
    });
    const { listEvents } = await import("../src/tools/events.js");
    const r = (await listEvents({ discussion_id: 218 })) as {
      events: Array<{ id: number; kind: string }>;
      users: unknown[];
      comments: unknown[];
    };
    expect(r.events.map((e) => e.kind)).toEqual(["new_discussion", "new_comment", "reaction"]);
    expect(r.users).toHaveLength(2);
    expect(r.comments).toHaveLength(1);
  });

  it("applies `kinds` filter client-side, keeping embedded arrays intact", async () => {
    mockFetch(200, {
      events: [
        { id: 1, kind: "new_discussion" },
        { id: 2, kind: "new_comment" },
        { id: 3, kind: "reaction" },
        { id: 4, kind: "new_comment" },
      ],
      users: [{ id: 1 }],
    });
    const { listEvents } = await import("../src/tools/events.js");
    const r = (await listEvents({ discussion_id: 218, kinds: ["new_comment"] })) as {
      events: Array<{ id: number; kind: string }>;
      users: unknown[];
    };
    expect(r.events.map((e) => e.id)).toEqual([2, 4]);
    expect(r.users).toHaveLength(1);
  });

  it("rejects missing discussion_id at schema layer", async () => {
    const { listEventsSchema } = await import("../src/tools/events.js");
    expect(listEventsSchema.safeParse({}).success).toBe(false);
    expect(listEventsSchema.safeParse({ discussion_id: 218 }).success).toBe(true);
  });
});

describe("getUserActivity", () => {
  it("rejects empty group_ids", async () => {
    const { getUserActivitySchema } = await import("../src/tools/events.js");
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: [] }).success).toBe(false);
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: [1] }).success).toBe(true);
  });

  it("rejects group_ids longer than 50", async () => {
    const { getUserActivitySchema } = await import("../src/tools/events.js");
    const big = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(getUserActivitySchema.safeParse({ user_id: 2, group_ids: big }).success).toBe(false);
  });

  it("aggregates events authored by the target user across discussions", async () => {
    // group 2 → discussions [10, 11]; group 3 → discussions [20]
    // Each fetch sequence: list_discussions(group), then v1/events per discussion.
    // With concurrency=6 the order of dispatch is by-index but each task awaits
    // its full chain before completing. We queue enough mocks to satisfy any
    // reasonable interleaving — vitest's queue is FIFO per resolution, so the
    // mocks are consumed in dispatch order.

    // Group 2 list_discussions
    mockFetch(200, { discussions: [{ id: 10 }, { id: 11 }] });
    // Group 3 list_discussions
    mockFetch(200, { discussions: [{ id: 20 }] });
    // Discussion 10 events
    mockFetch(200, {
      events: [
        {
          id: 1,
          kind: "new_discussion",
          actor_id: 99,
          created_at: "2025-01-15T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Discussion",
          eventable_id: 10,
        },
        {
          id: 2,
          kind: "new_comment",
          actor_id: 7,
          created_at: "2025-01-20T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Comment",
          eventable_id: 100,
        },
        {
          id: 3,
          kind: "new_comment",
          actor_id: 99,
          created_at: "2025-02-01T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Comment",
          eventable_id: 101,
        },
      ],
    });
    // Discussion 11 events
    mockFetch(200, {
      events: [
        {
          id: 4,
          kind: "reaction",
          actor_id: 99,
          created_at: "2025-03-01T10:00:00Z",
          discussion_id: 11,
          eventable_type: "Reaction",
          eventable_id: 50,
        },
      ],
    });
    // Discussion 20 events
    mockFetch(200, {
      events: [
        {
          id: 5,
          kind: "stance_created",
          actor_id: 99,
          created_at: "2025-02-15T10:00:00Z",
          discussion_id: 20,
          eventable_type: "Stance",
          eventable_id: 200,
        },
        {
          id: 6,
          kind: "new_comment",
          actor_id: 12,
          created_at: "2025-02-16T10:00:00Z",
          discussion_id: 20,
          eventable_type: "Comment",
          eventable_id: 102,
        },
      ],
    });

    const { getUserActivity } = await import("../src/tools/events.js");
    const r = await getUserActivity({ user_id: 99, group_ids: [2, 3] });

    expect(r.scope.group_ids).toEqual([2, 3]);
    expect(r.scope.discussions_scanned).toBe(3);
    expect(r.scope.events_examined).toBe(6);
    expect(r.counts.total).toBe(4); // events authored by user 99
    expect(r.counts.new_discussion).toBe(1);
    expect(r.counts.new_comment).toBe(1);
    expect(r.counts.reaction).toBe(1);
    expect(r.counts.stance_created).toBe(1);
    expect(r.first_activity).toBe("2025-01-15T10:00:00Z");
    expect(r.last_activity).toBe("2025-03-01T10:00:00Z");
    expect(r.by_group).toEqual({ "2": 3, "3": 1 });
    expect(r.by_month).toEqual({ "2025-01": 1, "2025-02": 2, "2025-03": 1 });
  });

  it("respects since/until window", async () => {
    mockFetch(200, { discussions: [{ id: 10 }] });
    mockFetch(200, {
      events: [
        {
          id: 1,
          kind: "new_comment",
          actor_id: 99,
          created_at: "2025-01-01T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Comment",
          eventable_id: 1,
        },
        {
          id: 2,
          kind: "new_comment",
          actor_id: 99,
          created_at: "2025-06-01T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Comment",
          eventable_id: 2,
        },
        {
          id: 3,
          kind: "new_comment",
          actor_id: 99,
          created_at: "2025-12-01T10:00:00Z",
          discussion_id: 10,
          eventable_type: "Comment",
          eventable_id: 3,
        },
      ],
    });

    const { getUserActivity } = await import("../src/tools/events.js");
    const r = await getUserActivity({
      user_id: 99,
      group_ids: [2],
      since: "2025-05-01T00:00:00Z",
      until: "2025-11-01T00:00:00Z",
    });
    expect(r.counts.total).toBe(1); // only the June one survives the window
  });

  it("dedupes duplicate group_ids", async () => {
    mockFetch(200, { discussions: [{ id: 10 }] });
    mockFetch(200, { events: [] });

    const { getUserActivity } = await import("../src/tools/events.js");
    const r = await getUserActivity({ user_id: 99, group_ids: [2, 2, 2] });
    expect(r.scope.group_ids).toEqual([2]);
    // 2 fetches: list_discussions(2) + events(10). No dup group fetches.
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });
});
