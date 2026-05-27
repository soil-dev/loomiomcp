import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("getPoll", () => {
  it("GETs /b2/polls/{id} with api_key in query", async () => {
    mockFetch(200, { polls: [{ id: 5 }] });
    const { getPoll } = await import("../src/tools/polls.js");
    await getPoll({ id_or_key: 5 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/polls/5");
    expect(url).toContain("api_key=test-key");
  });

  it("encodes string keys as a single path segment", async () => {
    mockFetch(200, {});
    const { getPoll } = await import("../src/tools/polls.js");
    await getPoll({ id_or_key: "../memberships?group_id=7" });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/polls/..%2Fmemberships%3Fgroup_id%3D7?");
    expect(url).not.toContain("/b2/memberships");
  });

  it("rejects path-like string keys at schema layer", async () => {
    const { getPollSchema } = await import("../src/tools/polls.js");
    expect(getPollSchema.safeParse({ id_or_key: "abcDEF12" }).success).toBe(true);
    expect(getPollSchema.safeParse({ id_or_key: "../memberships?group_id=7" }).success).toBe(false);
    expect(getPollSchema.safeParse({ id_or_key: "abc/def" }).success).toBe(false);
  });

  it("rejects dot-only string keys before building a URL", async () => {
    const { getPoll } = await import("../src/tools/polls.js");
    await expect(getPoll({ id_or_key: ".." })).rejects.toThrow(/id_or_key/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("createPoll", () => {
  it("POSTs /b2/polls with a FLAT body (no `poll` wrapper)", async () => {
    mockFetch(200, { polls: [{ id: 11 }] });
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({ title: "Choose", poll_type: "proposal", group_id: 3 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/polls?");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toEqual({ title: "Choose", poll_type: "proposal", group_id: 3 });
    expect(body.poll).toBeUndefined();
  });

  it("rejects unknown poll_type at schema layer", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "made_up", group_id: 1 }).success,
    ).toBe(false);
  });

  it("accepts every documented poll_type", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "proposal", group_id: 1 }).success,
    ).toBe(true);

    for (const t of ["poll", "count", "score", "ranked_choice", "meeting", "dot_vote"]) {
      expect(
        createPollSchema.safeParse({ title: "x", poll_type: t, group_id: 1, options: ["A"] })
          .success,
      ).toBe(true);
    }
  });

  it("requires either group_id or discussion_id", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(createPollSchema.safeParse({ title: "x", poll_type: "proposal" }).success).toBe(false);
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "proposal", discussion_id: 1 }).success,
    ).toBe(true);
  });

  it("requires options for every non-proposal poll_type", async () => {
    const { createPollSchema } = await import("../src/tools/polls.js");
    expect(createPollSchema.safeParse({ title: "x", poll_type: "poll", group_id: 1 }).success).toBe(
      false,
    );
    expect(
      createPollSchema.safeParse({ title: "x", poll_type: "poll", group_id: 1, options: ["A"] })
        .success,
    ).toBe(true);
  });
});

describe("listPolls", () => {
  it("GETs /b2/polls with group_id, status, limit, offset", async () => {
    mockFetch(200, { polls: [] });
    const { listPolls } = await import("../src/tools/polls.js");
    await listPolls({ group_id: 3, status: "closed", limit: 25, offset: 100 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b2/polls?");
    expect(url).toContain("group_id=3");
    expect(url).toContain("status=closed");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=100");
  });

  it("rejects invalid status", async () => {
    const { listPollsSchema } = await import("../src/tools/polls.js");
    expect(listPollsSchema.safeParse({ group_id: 1, status: "bogus" }).success).toBe(false);
  });

  it("rejects limit > 200", async () => {
    const { listPollsSchema } = await import("../src/tools/polls.js");
    expect(listPollsSchema.safeParse({ group_id: 1, limit: 500 }).success).toBe(false);
  });
});
