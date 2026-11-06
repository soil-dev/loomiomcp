/**
 * Loomio 3.14 versioned its APIs (`/api/user0`, `/api/server0`) and
 * kept `/api/b2` / `/api/b3` as compatibility paths with the pre-3.14
 * poll vocabulary. src/loomio/api-dialect.ts decides per Loomio
 * version which generation the connector talks to; these tests pin the
 * decision, the paths every tool builds from it, the probe path, the
 * 403 catalogue's recognition of both generations and the wire bodies
 * of the dialect-sensitive writes.
 */

import { describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import {
  apiDialect,
  apiDialectKnown,
  compareVersions,
  dialectForVersion,
  isServerApiPath,
  isUserApiPath,
  parseVersion,
  serverApiPath,
  userApiPath,
  VERSIONED_API_SINCE,
} from "../src/loomio/api-dialect.js";
import { classifyForbidden } from "../src/loomio/client.js";
import { setCachedHealth } from "../src/loomio/health-cache.js";
import {
  acceptVersionToken,
  checkLoomioHealth,
  healthProbePath,
  resetHealthForTests,
} from "../src/loomio/health.js";
import { joinTopics, topicJoinFields } from "../src/loomio/shape.js";
import { redactPath } from "../src/log.js";
import {
  discussionRow,
  EXAMPLE_ORG,
  groupsIndexBody,
  pollRow,
  pollShowBody,
  pollsListBody,
  topicRow,
} from "./fixtures.js";
import { fetchCallsTo, mockFetchRoutes, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

/** Seed the health cache as a probe that saw `version` would. */
function seenVersion(version: string | null): void {
  setCachedHealth({
    key_status: "valid",
    loomio_version: version,
    checked_at: "2026-11-06T00:00:00Z",
  });
}

function requestUrl(index = 0): URL {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  return new URL(String(call![0]));
}

function requestBody(index = 0): Record<string, unknown> {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  return JSON.parse(String((call![1] as { body?: unknown }).body)) as Record<string, unknown>;
}

describe("dialectForVersion", () => {
  it("versioned from 3.14.0 (the release that added /user0 and /server0), legacy before", () => {
    expect(VERSIONED_API_SINCE).toBe("3.14.0");
    expect(dialectForVersion("3.13.2")).toBe("legacy");
    expect(dialectForVersion("3.14.0")).toBe("versioned");
    expect(dialectForVersion("3.14.1")).toBe("versioned");
    expect(dialectForVersion("3.15.0")).toBe("versioned");
    expect(dialectForVersion("4.0.0")).toBe("versioned");
    expect(dialectForVersion("v3.14.0")).toBe("versioned");
    expect(dialectForVersion("3.9.0")).toBe("legacy");
  });

  it("legacy when the version is unknown or unparseable — the compatibility paths answer on every supported Loomio", () => {
    expect(dialectForVersion(null)).toBe("legacy");
    expect(dialectForVersion(undefined)).toBe("legacy");
    expect(dialectForVersion("")).toBe("legacy");
    expect(dialectForVersion("latest")).toBe("legacy");
  });

  it("parseVersion / compareVersions handle a missing patch and a suffix", () => {
    expect(parseVersion("3.14")).toEqual([3, 14, 0]);
    expect(parseVersion("3.14.1-rc1")).toEqual([3, 14, 1]);
    expect(parseVersion("x")).toBeUndefined();
    expect(compareVersions([3, 14, 0], [3, 13, 9])).toBeGreaterThan(0);
    expect(compareVersions([3, 14, 0], [3, 14, 0])).toBe(0);
    expect(compareVersions([3, 9, 0], [3, 14, 0])).toBeLessThan(0);
  });
});

describe("apiDialect / userApiPath / serverApiPath", () => {
  it("follow the version the last probe reported; legacy before any probe", () => {
    resetHealthForTests();
    expect(apiDialectKnown()).toBe(false);
    expect(apiDialect()).toBe("legacy");
    expect(userApiPath("/polls/12")).toBe("/b2/polls/12");
    expect(serverApiPath("/users")).toBe("/b3/users");

    seenVersion("3.15.0");
    expect(apiDialectKnown()).toBe(true);
    expect(apiDialect()).toBe("versioned");
    expect(userApiPath("/polls/12")).toBe("/user0/polls/12");
    expect(userApiPath("polls")).toBe("/user0/polls");
    expect(serverApiPath("/memberships/5")).toBe("/server0/memberships/5");

    seenVersion("3.13.1");
    expect(apiDialect()).toBe("legacy");
    expect(userApiPath("/groups")).toBe("/b2/groups");

    // A probe whose version call failed does not erase the known version
    // (security review F-18-02): the dialect is sticky until another
    // version is reported.
    seenVersion(null);
    expect(apiDialectKnown()).toBe(true);
    expect(apiDialect()).toBe("legacy");
    seenVersion("3.15.0");
    seenVersion(null);
    expect(apiDialect()).toBe("versioned");
    resetHealthForTests();
  });

  it("an explicit dialect overrides the cache", () => {
    expect(userApiPath("/groups", "versioned")).toBe("/user0/groups");
    expect(serverApiPath("/groups", "legacy")).toBe("/b3/groups");
  });

  it("isUserApiPath / isServerApiPath recognise both generations, redacted or not", () => {
    for (const p of ["/api/b2/polls", "/b2/polls/:id", "/api/user0/threads/9/items"]) {
      expect(isUserApiPath(p), p).toBe(true);
      expect(isServerApiPath(p), p).toBe(false);
    }
    for (const p of ["/api/b3/users/1", "/b3/memberships/:id", "/api/server0/groups"]) {
      expect(isServerApiPath(p), p).toBe(true);
      expect(isUserApiPath(p), p).toBe(false);
    }
    expect(isUserApiPath("/api/v1/boot/version")).toBe(false);
    expect(isUserApiPath(undefined)).toBe(false);
  });
});

describe("the key-health probe path", () => {
  it("is /b2/groups before a version is known and /user0/groups once a 3.14+ probe answered", () => {
    expect(healthProbePath(null)).toBe("/b2/groups");
    expect(healthProbePath(undefined)).toBe("/b2/groups");
    expect(healthProbePath("3.13.1")).toBe("/b2/groups");
    expect(healthProbePath("3.14.0")).toBe("/user0/groups");
    expect(healthProbePath("3.15.0")).toBe("/user0/groups");
  });
});

describe("redactPath on the versioned paths", () => {
  it("collapses ids and keys under /user0 and /server0 exactly as under /b2 and /b3", () => {
    expect(redactPath("/user0/polls/abcDEF?compact=1")).toBe("/user0/polls/:id");
    expect(redactPath("/user0/threads/901/items")).toBe("/user0/threads/:id/items");
    expect(redactPath("/server0/users/42/deactivate")).toBe("/server0/users/:id/deactivate");
    expect(redactPath("/server0/users/identity/saml/jane@example.org")).toBe(
      "/server0/users/identity/:type/:uid",
    );
  });
});

describe("classifyForbidden on the versioned paths", () => {
  const GENERIC = JSON.stringify({ error: "You are not authorized to access this page." });

  it("GET /user0/discussions is the visibility-gated list, like GET /b2/discussions", () => {
    const c = classifyForbidden(GENERIC, { path: "/api/user0/discussions", method: "GET" });
    expect(c.kind).toBe("unauthenticated");
    expect(c.message).toMatch(/not visible to the connector's user/);
  });

  it("/user0/threads is visibility-filtered: the key and nothing else", () => {
    const c = classifyForbidden(GENERIC, { path: "/api/user0/threads/:id/items" });
    expect(c.message).toMatch(/exactly one thing/);
  });

  it("/server0 is the Server API secret, named with Loomio's current setting and the pre-3.14 one", () => {
    const c = classifyForbidden(GENERIC, { path: "/api/server0/users", keyStatus: "valid" });
    expect(c.kind).toBe("unauthenticated");
    expect(c.message).toMatch(/LOOMIO_B3_API_KEY/);
    expect(c.message).toMatch(/SERVER_API_KEY \(B3_API_KEY before Loomio 3\.14\)/);
    expect(c.message).not.toMatch(/rotated/);
  });

  it("GET /user0/groups/:id names a hidden group", () => {
    const c = classifyForbidden(JSON.stringify({ error: "Not authorized to show Group." }), {
      path: "/api/user0/groups/:id",
    });
    expect(c.kind).toBe("not_authorized");
    expect(c.message).toMatch(/HIDDEN/);
  });
});

describe("tools on a Loomio ≥ 3.14 instance", () => {
  it("read the versioned paths and relay the versioned vocabulary untouched", async () => {
    seenVersion("3.15.0");
    mockFetchRoutes({
      "/user0/polls/301": { status: 200, body: pollShowBody() },
    });
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(requestUrl().pathname).toBe("/api/user0/polls/301");
    expect(r.poll.vote_count_eligible).toBe(6);
    expect(r.poll.scores_by_option).toEqual([3, 1, 0]);
    expect(r.poll).not.toHaveProperty("voters_count");
    resetHealthForTests();
  });

  it("list_polls / get_discussion / list_thread_items / search all take /user0", async () => {
    seenVersion("3.14.0");
    mockFetchRoutes({
      "/user0/polls": { status: 200, body: pollsListBody() },
      "/user0/discussions/601": {
        status: 200,
        body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
      },
      "/user0/search": { status: 200, body: { search_results: [] } },
    });
    const { listPolls } = await import("../src/tools/polls.js");
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const { searchContent } = await import("../src/tools/search.js");
    await listPolls({ group_id: 7 });
    await getDiscussion({ id_or_key: 601 });
    await searchContent({ query: "budget" });
    const paths = vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u)).pathname);
    expect(paths).toEqual(["/api/user0/polls", "/api/user0/discussions/601", "/api/user0/search"]);
    resetHealthForTests();
  });

  it("create_poll sends the current setting names and reminder value as they are", async () => {
    seenVersion("3.15.0");
    mockFetchRoutes({
      "/user0/polls": {
        status: 200,
        body: pollShowBody({ polls: [pollRow({ poll_type: "score" })] }),
      },
    });
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({
      title: "Rate the venues",
      poll_type: "score",
      group_id: 7,
      options: ["Hall", "Garden"],
      closing_at: "2030-01-01T12:00:00Z",
      score_min: 1,
      score_max: 10,
      notify_on_closing_soon: "voters_uncast",
    });
    expect(requestUrl().pathname).toBe("/api/user0/polls");
    const poll = requestBody()["poll"] as Record<string, unknown>;
    expect(poll).toMatchObject({
      score_min: 1,
      score_max: 10,
      notify_on_closing_soon: "voters_uncast",
    });
    expect(poll).not.toHaveProperty("min_score");
    resetHealthForTests();
  });

  it("update_discussion sends polls_one_at_a_time and attachments_admin_only as named, without probing", async () => {
    seenVersion("3.15.0");
    mockFetchRoutes({
      "/user0/discussions/601": {
        status: 200,
        body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
      },
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({
      id_or_key: 601,
      polls_one_at_a_time: true,
      attachments_admin_only: false,
    });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(requestUrl().pathname).toBe("/api/user0/discussions/601");
    expect(requestBody()).toEqual({
      discussion: { polls_one_at_a_time: true, attachments_admin_only: false },
    });
    resetHealthForTests();
  });
});

describe("tools on a Loomio < 3.14 instance (legacy dialect)", () => {
  it("create_poll translates the renamed settings and the reminder value back to the old names", async () => {
    seenVersion("3.13.1");
    mockFetchRoutes({
      "/b2/polls": {
        status: 200,
        body: pollShowBody({ polls: [pollRow({ poll_type: "dot_vote" })] }),
      },
    });
    const { createPoll } = await import("../src/tools/polls.js");
    await createPoll({
      title: "Allocate the budget",
      poll_type: "dot_vote",
      group_id: 7,
      options: ["Roof", "Garden"],
      closing_at: "2030-01-01T12:00:00Z",
      points_per_voter: 5,
      choice_count_min: 1,
      notify_on_closing_soon: "voters_uncast",
    });
    expect(requestUrl().pathname).toBe("/api/b2/polls");
    const poll = requestBody()["poll"] as Record<string, unknown>;
    expect(poll).toMatchObject({
      dots_per_person: 5,
      minimum_stance_choices: 1,
      notify_on_closing_soon: "undecided_voters",
    });
    expect(poll).not.toHaveProperty("points_per_voter");
    expect(poll).not.toHaveProperty("choice_count_min");
    resetHealthForTests();
  });

  it("update_discussion sends polls_one_at_a_time INVERTED as allow_concurrent_polls", async () => {
    seenVersion("3.13.1");
    mockFetchRoutes({
      "/b2/discussions/601": {
        status: 200,
        body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
      },
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true, title: "T" });
    expect(requestBody()).toEqual({ discussion: { title: "T", allow_concurrent_polls: false } });
    resetHealthForTests();
  });

  it("update_discussion refuses attachments_admin_only before any request: the server has no such column", async () => {
    seenVersion("3.13.1");
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await expect(
      updateDiscussion({ id_or_key: 601, attachments_admin_only: true }),
    ).rejects.toThrow(
      /attachments_admin_only needs Loomio 3\.14 or later.*reports version 3\.13\.1.*Nothing was changed/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    resetHealthForTests();
  });

  it("a legacy-vocabulary response (the /b2 compatibility path) reaches the caller in the current vocabulary", async () => {
    seenVersion("3.13.1");
    const legacy = {
      ...pollRow(),
      voters_count: 6,
      decided_voters_count: 4,
      undecided_voters_count: 2,
      cast_stances_pct: 40,
      stance_counts: [3, 1, 0],
      quorum_count: 0,
      quorum_votes_required: 0,
      min_score: 1,
      max_score: 1,
      dots_per_person: 1,
      minimum_stance_choices: 1,
      maximum_stance_choices: 1,
      notify_on_closing_soon: "undecided_voters",
    } as unknown as ReturnType<typeof pollRow>;
    for (const k of [
      "vote_count_eligible",
      "vote_count_cast",
      "vote_count_uncast",
      "participation_pct",
      "scores_by_option",
      "quorum_threshold",
      "quorum_shortfall",
      "score_min",
      "score_max",
      "points_per_voter",
      "choice_count_min",
      "choice_count_max",
    ]) {
      delete (legacy as Record<string, unknown>)[k];
    }
    mockFetchRoutes({ "/b2/polls/301": { status: 200, body: pollShowBody({ polls: [legacy] }) } });
    const { getPoll } = await import("../src/tools/polls.js");
    const r = await getPoll({ id_or_key: 301 });
    expect(requestUrl().pathname).toBe("/api/b2/polls/301");
    expect(r.poll).toMatchObject({
      vote_count_eligible: 6,
      vote_count_cast: 4,
      vote_count_uncast: 2,
      participation_pct: 40,
      scores_by_option: [3, 1, 0],
      score_min: 1,
      score_max: 1,
      points_per_voter: 1,
      choice_count_min: 1,
      choice_count_max: 1,
      notify_on_closing_soon: "voters_uncast",
    });
    for (const old of ["voters_count", "stance_counts", "min_score", "dots_per_person"]) {
      expect(r.poll).not.toHaveProperty(old);
    }
    resetHealthForTests();
  });
});

describe("update_discussion before any probe reported a version", () => {
  it("probes first (the thread setting's name depends on the version), then writes in the dialect found", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": { status: 200, body: { version: "3.15.0" } },
      "/user0/discussions/601": {
        status: 200,
        body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
      },
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: false });
    const paths = vi
      .mocked(fetch)
      .mock.calls.map(([u]) => new URL(String(u)).pathname)
      .sort();
    expect(paths).toEqual(["/api/b2/groups", "/api/user0/discussions/601", "/api/v1/boot/version"]);
    const patch = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).includes("/discussions/601"))!;
    expect(JSON.parse(String((patch[1] as { body?: unknown }).body))).toEqual({
      discussion: { polls_one_at_a_time: false },
    });
    resetHealthForTests();
  });

  it("a title-only update never probes: nothing in it depends on the version", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/discussions/601": {
        status: 200,
        body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
      },
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, title: "Only the title" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(requestUrl().pathname).toBe("/api/b2/discussions/601");
  });
});

// ── Security review 2026-11-06 (F-18-01 … F-18-11) ──────────────────────────

const DISCUSSION_601 = {
  status: 200,
  body: { discussions: [discussionRow()], topics: [topicRow()], groups: [EXAMPLE_ORG] },
};

describe("F-18-01: the Loomio version is accepted only as a short semver-shaped token", () => {
  it("acceptVersionToken", () => {
    expect(acceptVersionToken("3.15.0")).toBe("3.15.0");
    expect(acceptVersionToken(" v3.14.1-rc1 ")).toBe("v3.14.1-rc1");
    expect(acceptVersionToken("3.14")).toBe("3.14");
    expect(acceptVersionToken("3.15.0+build.7")).toBe("3.15.0+build.7");
    expect(acceptVersionToken("")).toBeNull();
    expect(acceptVersionToken(123)).toBeNull();
    expect(acceptVersionToken("3.15.0\nevil")).toBeNull();
    expect(acceptVersionToken("3.15.0 junk")).toBeNull();
    expect(acceptVersionToken("latest")).toBeNull();
    expect(acceptVersionToken(`3.15.0-${"a".repeat(40)}`)).toBeNull();
    expect(acceptVersionToken("9".repeat(70))).toBeNull();
  });

  it("a probe answering a multi-KB or newline-bearing version yields loomio_version null and the legacy dialect", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": { status: 200, body: { version: `3.15.0\n${"x".repeat(5000)}` } },
    });
    const h = await checkLoomioHealth({ force: true });
    expect(h.key_status).toBe("valid");
    expect(h.loomio_version).toBeNull();
    expect(apiDialectKnown()).toBe(false);
    expect(apiDialect()).toBe("legacy");
    resetHealthForTests();
  });
});

describe("F-18-02: a transient version failure never downgrades the dialect; an unknown version is refused, not guessed", () => {
  it("a fresh verdict with loomio_version null after a known 3.15.0 keeps /user0 and probes nothing", async () => {
    seenVersion("3.15.0");
    setCachedHealth({
      key_status: "valid",
      loomio_version: null,
      checked_at: "2026-11-06T00:00:00Z",
    });
    mockFetchRoutes({ "/user0/discussions/601": DISCUSSION_601 });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(requestUrl().pathname).toBe("/api/user0/discussions/601");
    expect(requestBody()).toEqual({ discussion: { polls_one_at_a_time: true } });
    resetHealthForTests();
  });

  it("no version ever reported (version route down, key fine): both settings refuse with the same message, nothing is written, one probe pair for repeated calls", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": new Error("blocked"),
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    const expected =
      /Loomio version is unknown.*GET \/v1\/boot\/version.*run check_connection.*Nothing was changed/s;
    await expect(updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true })).rejects.toThrow(
      expected,
    );
    await expect(
      updateDiscussion({ id_or_key: 601, attachments_admin_only: true }),
    ).rejects.toThrow(expected);
    await expect(
      updateDiscussion({ id_or_key: 601, polls_one_at_a_time: false, title: "x" }),
    ).rejects.toThrow(expected);
    // Bounded (F-18-10): the first call probed once; the next two reused the fresh verdict.
    expect(fetchCallsTo("/b2/groups")).toHaveLength(1);
    expect(fetchCallsTo("/v1/boot/version")).toHaveLength(1);
    expect(fetchCallsTo("/discussions/601")).toHaveLength(0);
    resetHealthForTests();
  });
});

describe("F-18-03: a known but stale version is refreshed before a thread-setting write, once", () => {
  it("re-probes when the known version is older than the cache TTL, then writes in the dialect found", async () => {
    resetHealthForTests();
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.13.1", checked_at: "2026-11-01T00:00:00Z" },
      Date.now() - 120_000,
    );
    expect(apiDialect()).toBe("legacy");
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": { status: 200, body: { version: "3.15.0" } },
      "/user0/discussions/601": DISCUSSION_601,
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true });
    await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: false });
    expect(fetchCallsTo("/b2/groups")).toHaveLength(1);
    expect(fetchCallsTo("/v1/boot/version")).toHaveLength(1);
    const patches = fetchCallsTo("/user0/discussions/601");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String((patches[0]![1] as { body?: unknown }).body))).toEqual({
      discussion: { polls_one_at_a_time: true },
    });
    resetHealthForTests();
  });

  it("a title-only update never probes, even with a stale version", async () => {
    resetHealthForTests();
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.15.0", checked_at: "2026-11-01T00:00:00Z" },
      Date.now() - 120_000,
    );
    mockFetchRoutes({ "/user0/discussions/601": DISCUSSION_601 });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await updateDiscussion({ id_or_key: 601, title: "Only the title" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    resetHealthForTests();
  });
});

describe("F-18-05: the key probe retries once on the generation the same run's version selects", () => {
  it("first probe of a process on a Loomio that no longer serves /b2: 404 there, then /user0/groups → valid", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 404, body: { error: 404 } },
      "/user0/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": { status: 200, body: { version: "3.15.0" } },
    });
    const h = await checkLoomioHealth({ force: true });
    expect(h.key_status).toBe("valid");
    expect(h.loomio_version).toBe("3.15.0");
    expect(fetchCallsTo("/b2/groups")).toHaveLength(1);
    expect(fetchCallsTo("/user0/groups")).toHaveLength(1);
    resetHealthForTests();
  });

  it("a 404 with no version to retry on stays unreachable/http_404 (one request, no guessing)", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 404, body: { error: 404 } },
      "/v1/boot/version": new Error("down"),
    });
    const h = await checkLoomioHealth({ force: true });
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("http_404");
    expect(fetchCallsTo("/groups")).toHaveLength(1);
    resetHealthForTests();
  });
});

describe("F-18-06: the plan-limit 403 names the Server-API membership write on both generations", () => {
  it("/server0/memberships and /b3/memberships get the 'secret was accepted' sentence", () => {
    for (const path of [
      "/api/server0/memberships",
      "/api/server0/memberships/:id",
      "/api/b3/memberships/:id",
    ]) {
      const c = classifyForbidden(JSON.stringify({ error: 403 }), { path });
      expect(c.kind, path).toBe("plan_limit");
      expect(c.message, path).toMatch(/subscription is inactive or expired.*secret was accepted/);
    }
    expect(
      classifyForbidden(JSON.stringify({ error: 403 }), { path: "/api/user0/memberships" }).message,
    ).not.toMatch(/secret was accepted/);
  });
});

describe("F-18-07: the thread settings update_discussion can set are relayed, in one vocabulary", () => {
  it("topicJoinFields relays polls_one_at_a_time / attachments_admin_only and inverts a pre-3.14 allow_concurrent_polls", () => {
    const current = topicJoinFields(
      topicRow({ polls_one_at_a_time: true, attachments_admin_only: true }),
    );
    expect(current).toMatchObject({ polls_one_at_a_time: true, attachments_admin_only: true });
    const legacy = topicRow();
    delete (legacy as Record<string, unknown>)["polls_one_at_a_time"];
    delete (legacy as Record<string, unknown>)["attachments_admin_only"];
    (legacy as Record<string, unknown>)["allow_concurrent_polls"] = false;
    const joined = topicJoinFields(legacy);
    expect(joined.polls_one_at_a_time).toBe(true);
    expect(joined).not.toHaveProperty("allow_concurrent_polls");
    expect(joined).not.toHaveProperty("attachments_admin_only");
    const [rec] = joinTopics([{ id: 1, topic_id: legacy.id }], [legacy]);
    expect(rec?.polls_one_at_a_time).toBe(true);
  });

  it("get_discussion and the update_discussion echo carry both settings", async () => {
    seenVersion("3.15.0");
    mockFetchRoutes({ "/user0/discussions/601": DISCUSSION_601 });
    const { getDiscussion, updateDiscussion } = await import("../src/tools/discussions.js");
    const r = await getDiscussion({ id_or_key: 601 });
    expect(r.discussion).toMatchObject({
      polls_one_at_a_time: true,
      attachments_admin_only: false,
    });
    const w = await updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true });
    expect(w.discussion).toMatchObject({
      polls_one_at_a_time: true,
      attachments_admin_only: false,
    });
    resetHealthForTests();
  });
});

describe("F-18-08: list_groups' scope note names the generation in use", () => {
  it("says /user0/groups once a 3.14+ version is known", async () => {
    seenVersion("3.15.0");
    mockFetchRoutes({ "/user0/groups": { status: 200, body: groupsIndexBody() } });
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups({});
    expect(requestUrl().pathname).toBe("/api/user0/groups");
    expect(r.scope.note).toMatch(/GET \/user0\/groups/);
    expect(r.scope.note).not.toMatch(/\/b2\//);
    resetHealthForTests();
  });
});

describe("F-18-11: the re-probe takes /user0/groups once a 3.14+ version is known", () => {
  it("probes /api/user0/groups (never /b2) and reads Loomio's unauthenticated body there as rejected", async () => {
    resetHealthForTests();
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.15.0", checked_at: "2026-11-06T00:00:00Z" },
      Date.now() - 120_000,
    );
    mockFetchRoutes({
      "/user0/groups": {
        status: 403,
        body: { error: "You are not authorized to access this page." },
      },
      "/v1/boot/version": { status: 200, body: { version: "3.15.0" } },
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("rejected");
    expect(h.reason).toBe("unauthenticated_body");
    expect(fetchCallsTo("/user0/groups")).toHaveLength(1);
    expect(fetchCallsTo("/b2/groups")).toHaveLength(0);
    resetHealthForTests();
  });
});

describe("sweep after the review: a stale known version is not trusted for the thread settings", () => {
  it("known 3.13.1 two minutes ago, version route now failing: the write refuses naming the stale version, nothing is sent", async () => {
    resetHealthForTests();
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.13.1", checked_at: "2026-11-01T00:00:00Z" },
      Date.now() - 120_000,
    );
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": new Error("blocked"),
    });
    const { updateDiscussion } = await import("../src/tools/discussions.js");
    await expect(updateDiscussion({ id_or_key: 601, polls_one_at_a_time: true })).rejects.toThrow(
      /stale \(3\.13\.1, reported 2 min ago.*Nothing was changed/s,
    );
    expect(fetchCallsTo("/b2/groups")).toHaveLength(1);
    expect(fetchCallsTo("/discussions/601")).toHaveLength(0);
    // Reads keep using the sticky version: the legacy paths still answer.
    expect(apiDialect()).toBe("legacy");
    resetHealthForTests();
  });

  it("F-18-05 also retries after an API gateway's JSON 403 on the deprecated prefix", async () => {
    resetHealthForTests();
    mockFetchRoutes({
      "/b2/groups": { status: 403, body: { message: "Forbidden" } },
      "/user0/groups": { status: 200, body: { groups: [], memberships: [] } },
      "/v1/boot/version": { status: 200, body: { version: "3.15.0" } },
    });
    const h = await checkLoomioHealth({ force: true });
    expect(h.key_status).toBe("valid");
    expect(fetchCallsTo("/user0/groups")).toHaveLength(1);
    resetHealthForTests();
  });

  it("check_connection reports the version the paths are chosen from beside this probe's answer", async () => {
    resetHealthForTests();
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.15.0", checked_at: "2026-11-06T00:00:00Z" },
      Date.now() - 120_000,
    );
    mockFetchRoutes({
      "/user0/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": new Error("blocked"),
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection({});
    expect(r.loomio_version).toBeNull();
    expect(r.loomio_version_in_use).toBe("3.15.0");
    expect(r.notes.join(" ")).toMatch(/keeps using version 3\.15\.0/);
    resetHealthForTests();
  });
});
