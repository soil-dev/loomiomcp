/**
 * The HTTP client's 0.0.12 surface (src/loomio/client.ts): the write
 * verbs and their read-only guard, the nested-vs-flat body helpers,
 * array / csv query encoding, the per-tool read profiles, the
 * success-path body handling (empty body → `{}`, non-JSON 2xx → a
 * named error), the request deadline (60 s for tool calls, a
 * per-call `timeoutMs` for the raw probe primitives), and the paged-read
 * helpers that follow Loomio ≥ 3.11.1's bounded pages.
 *
 * Why these matter: Loomio 3.8.1's `permitted_params` takes the WRAPPED
 * resource hash when present and Rails' `wrap_parameters` only wraps
 * column names, so a flat discussion body silently loses `group_id` —
 * the body shape is load-bearing, not cosmetic. And `compact=1` drops
 * the `topics` side-load the discussion / poll tools join on, so the
 * exact `exclude_types` string per profile is pinned here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import {
  expectBearerAuth,
  mockFetch,
  mockFetchPaged,
  mockFetchRoutes,
  setupLoomioTest,
} from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
afterEach(() => delete process.env["LOOMIO_MCP_READONLY"]);

function requestOf(index = 0) {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(call, `expected a fetch call at index ${index}`).toBeDefined();
  const [url, opts] = call!;
  const r = (opts ?? {}) as RequestInit & { headers?: Record<string, string> };
  return {
    url: new URL(String(url)),
    method: r.method ?? "GET",
    headers: r.headers ?? {},
    rawBody: r.body as string | undefined,
    body: r.body ? (JSON.parse(r.body as string) as Record<string, unknown>) : undefined,
  };
}

describe("write verbs", () => {
  it("loomioPost sends JSON with the bearer key and returns the parsed body", async () => {
    mockFetch(200, { discussions: [{ id: 5 }] });
    const { loomioPost } = await import("../src/loomio/client.js");
    const out = await loomioPost<{ discussions: { id: number }[] }>("/b2/discussions", {
      discussion: { title: "T" },
    });
    expect(out.discussions[0]?.id).toBe(5);
    const req = requestOf();
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/api/b2/discussions");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.body).toEqual({ discussion: { title: "T" } });
    expectBearerAuth(0, "test-key");
  });

  it("loomioPatch sends PATCH with a JSON body to the member route", async () => {
    mockFetch(200, { polls: [{ id: 9 }] });
    const { loomioPatch } = await import("../src/loomio/client.js");
    await loomioPatch("/b2/polls/9", { poll: { title: "Renamed" } });
    const req = requestOf();
    expect(req.method).toBe("PATCH");
    expect(req.url.pathname).toBe("/api/b2/polls/9");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.body).toEqual({ poll: { title: "Renamed" } });
    expectBearerAuth(0, "test-key");
  });

  it("loomioDelete sends DELETE with an empty JSON object and no query", async () => {
    mockFetch(200, { comments: [{ id: 3, discarded_at: "2026-09-20T10:00:00Z" }] });
    const { loomioDelete } = await import("../src/loomio/client.js");
    const out = await loomioDelete<{ comments: { discarded_at: string }[] }>("/b2/comments/3");
    expect(out.comments[0]?.discarded_at).toBeTruthy();
    const req = requestOf();
    expect(req.method).toBe("DELETE");
    expect(req.url.pathname).toBe("/api/b2/comments/3");
    expect(req.url.search).toBe("");
    expect(req.rawBody).toBe("{}");
    expectBearerAuth(0, "test-key");
  });

  it("writes accept extra query params (kept for the rare controller that reads them)", async () => {
    mockFetch(200, {});
    const { loomioPost } = await import("../src/loomio/client.js");
    await loomioPost("/b2/memberships", { emails: ["a@example.org"] }, { params: { group_id: 4 } });
    expect(requestOf().url.searchParams.get("group_id")).toBe("4");
  });

  it("never sends form encoding any more", async () => {
    mockFetch(200, {});
    const client = await import("../src/loomio/client.js");
    await client.loomioPost("/b2/comments", { discussion_id: 1, body: "x" });
    expect(requestOf().headers["Content-Type"]).toBe("application/json");
    // The option is gone from the API surface, not just unused.
    expect("encodeForm" in client).toBe(false);
  });
});

describe("read-only guard on every write verb", () => {
  beforeEach(() => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
  });

  it.each([
    ["POST", (c: typeof import("../src/loomio/client.js")) => c.loomioPost("/b2/discussions", {})],
    ["PATCH", (c: typeof import("../src/loomio/client.js")) => c.loomioPatch("/b2/polls/1", {})],
    ["DELETE", (c: typeof import("../src/loomio/client.js")) => c.loomioDelete("/b2/comments/1")],
  ])("%s is refused with a clear message and no network call", async (method, call) => {
    const client = await import("../src/loomio/client.js");
    const err = await call(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(client.LoomioReadOnlyError);
    expect((err as Error).message).toContain(`${method} requests are refused`);
    expect((err as Error).message).toMatch(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("the guard runs before the key is read (a read-only deployment need not even hold a key)", async () => {
    delete process.env["LOOMIO_API_KEY"];
    const { loomioDelete } = await import("../src/loomio/client.js");
    await expect(loomioDelete("/b2/comments/1")).rejects.toThrow(/read-only mode/);
  });

  it("reads still go through", async () => {
    mockFetch(200, { threads: [] });
    const { loomioGet } = await import("../src/loomio/client.js");
    await expect(loomioGet("/b2/threads")).resolves.toEqual({ threads: [] });
  });
});

describe("b3 write verbs (Loomio 3.13 provisioning, user (de|re)activation)", () => {
  const B3 = "b3-secret-longer-than-sixteen-chars";
  beforeEach(() => {
    process.env["LOOMIO_B3_API_KEY"] = B3;
  });
  afterEach(() => {
    delete process.env["LOOMIO_B3_API_KEY"];
  });

  it("loomioPostB3 defaults to an empty JSON object body (what (de|re)activate take) and sends the b3 secret, not the per-user key", async () => {
    mockFetch(200, { success: true });
    const { loomioPostB3 } = await import("../src/loomio/client.js");
    await loomioPostB3("/b3/users/4/deactivate");
    const req = requestOf();
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/api/b3/users/4/deactivate");
    expect(req.url.search).toBe("");
    expect(req.rawBody).toBe("{}");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expectBearerAuth(0, B3);
    expect(req.headers["Authorization"]).not.toContain("test-key");
  });

  it("loomioPostB3 sends a given body verbatim as JSON", async () => {
    mockFetch(200, { added_emails: [], removed_emails: [] });
    const { loomioPostB3 } = await import("../src/loomio/client.js");
    await loomioPostB3("/b3/memberships", { group_id: 3, emails: ["a@example.org"] });
    expect(requestOf().body).toEqual({ group_id: 3, emails: ["a@example.org"] });
    expect(requestOf().headers["Content-Type"]).toBe("application/json");
    expectBearerAuth(0, B3);
  });

  it("loomioPatchB3 / loomioDeleteB3 use the b3 secret, JSON, and the member route", async () => {
    mockFetch(200, { membership: { id: 5 } });
    mockFetch(200, { success: true });
    const { loomioDeleteB3, loomioPatchB3 } = await import("../src/loomio/client.js");
    await loomioPatchB3("/b3/memberships/5", { membership: { delegate: true } });
    await loomioDeleteB3("/b3/memberships/5");
    const patch = requestOf(0);
    expect(patch.method).toBe("PATCH");
    expect(patch.url.pathname).toBe("/api/b3/memberships/5");
    expect(patch.body).toEqual({ membership: { delegate: true } });
    expect(patch.headers["Content-Type"]).toBe("application/json");
    expectBearerAuth(0, B3);
    const del = requestOf(1);
    expect(del.method).toBe("DELETE");
    expect(del.rawBody).toBe("{}");
    expect(del.headers["Content-Type"]).toBe("application/json");
    expectBearerAuth(1, B3);
  });

  it.each([
    [
      "POST",
      (c: typeof import("../src/loomio/client.js")) => c.loomioPostB3("/b3/memberships", {}),
    ],
    [
      "PATCH",
      (c: typeof import("../src/loomio/client.js")) => c.loomioPatchB3("/b3/memberships/1", {}),
    ],
    [
      "DELETE",
      (c: typeof import("../src/loomio/client.js")) => c.loomioDeleteB3("/b3/memberships/1"),
    ],
  ])(
    "b3 %s is refused in read-only mode before the secret is read or a request made",
    async (method, call) => {
      process.env["LOOMIO_MCP_READONLY"] = "1";
      delete process.env["LOOMIO_B3_API_KEY"];
      const client = await import("../src/loomio/client.js");
      const err = await call(client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(client.LoomioReadOnlyError);
      expect((err as Error).message).toContain(`${method} requests are refused`);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it("the b2 write verbs still send the per-user key (the auth parameter defaults to b2)", async () => {
    mockFetch(200, {});
    const { loomioPost } = await import("../src/loomio/client.js");
    await loomioPost("/b2/memberships", { group_id: 1, emails: ["a@example.org"] });
    expectBearerAuth(0, "test-key");
    expect(requestOf().headers["Authorization"]).not.toContain(B3);
  });
});

describe("body helpers", () => {
  it("nestedBody wraps the attributes under the resource key and drops undefined", async () => {
    const { nestedBody } = await import("../src/loomio/client.js");
    expect(
      nestedBody("discussion", { title: "T", group_id: 7, private: undefined, tags: ["a"] }),
    ).toEqual({ discussion: { title: "T", group_id: 7, tags: ["a"] } });
  });

  it("nestedBody puts service-level keys (poll recipient_*) at the TOP level beside the resource", async () => {
    const { nestedBody } = await import("../src/loomio/client.js");
    expect(
      nestedBody(
        "poll",
        { title: "P", poll_type: "proposal" },
        { recipient_audience: "group", recipient_emails: undefined },
      ),
    ).toEqual({ poll: { title: "P", poll_type: "proposal" }, recipient_audience: "group" });
  });

  it("nestedBody('membership', …) is the b3 role-update shape: {membership: {admin, delegate}}", async () => {
    const { nestedBody } = await import("../src/loomio/client.js");
    expect(nestedBody("membership", { admin: true, delegate: undefined })).toEqual({
      membership: { admin: true },
    });
  });

  it("flatBody keeps null (a deliberate clear) but drops undefined", async () => {
    const { flatBody } = await import("../src/loomio/client.js");
    expect(flatBody({ body: "x", body_format: undefined, parent_id: null })).toEqual({
      body: "x",
      parent_id: null,
    });
  });
});

describe("query encoding", () => {
  it("arrays become repeated key[]= pairs (Rails convention, e.g. search's tag)", async () => {
    mockFetch(200, {});
    const { loomioGet } = await import("../src/loomio/client.js");
    await loomioGet("/b2/search", { query: "budget", tag: ["finance", "2026"] });
    const params = requestOf().url.searchParams;
    expect(params.getAll("tag[]")).toEqual(["finance", "2026"]);
    expect(params.get("query")).toBe("budget");
  });

  it("csvParam joins for Loomio's comma-separated parameters", async () => {
    const { csvParam } = await import("../src/loomio/client.js");
    expect(csvParam([1, 2, 3])).toBe("1,2,3");
    expect(csvParam(["Discussion", "Poll"])).toBe("Discussion,Poll");
    expect(csvParam([])).toBe("");
  });

  it("undefined values are omitted; booleans and numbers are stringified", async () => {
    mockFetch(200, {});
    const { loomioGet } = await import("../src/loomio/client.js");
    await loomioGet("/b2/threads", { limit: 20, offset: undefined, compact: 1 });
    const params = requestOf().url.searchParams;
    expect(params.get("limit")).toBe("20");
    expect(params.has("offset")).toBe(false);
    expect(params.get("compact")).toBe("1");
  });
});

describe("read profiles", () => {
  it("pin the exact exclude_types strings — `topic` is never excluded on list/show", async () => {
    const { EXCLUDE_TYPES, readParams } = await import("../src/loomio/client.js");
    expect(EXCLUDE_TYPES.list).toBe("group parent membership reaction translation");
    expect(EXCLUDE_TYPES.show).toBe("parent membership reaction translation");
    expect(EXCLUDE_TYPES.groups).toBe("tag translation");
    expect(EXCLUDE_TYPES.threads).toBe("topic group parent membership reaction translation");
    expect(EXCLUDE_TYPES.items_known_thread).toBe(
      "topic group parent membership reaction tag translation discussion",
    );
    expect(EXCLUDE_TYPES.items_with_reactions).toBe(
      "topic group parent membership tag translation",
    );
    // get_thread_markdown's guard: compact minus `topic`, so a discussion
    // or poll show brings its thread's TopicSerializer row.
    expect(EXCLUDE_TYPES.thread_guard).toBe("group parent membership reaction tag translation");
    expect(readParams("thread_guard")).toEqual({ exclude_types: EXCLUDE_TYPES.thread_guard });
    for (const profile of ["list", "show", "groups", "thread_guard"] as const) {
      expect(EXCLUDE_TYPES[profile].split(" ")).not.toContain("topic");
      expect(readParams(profile)).toEqual({ exclude_types: EXCLUDE_TYPES[profile] });
    }
    expect(readParams("compact")).toEqual({ compact: 1 });
  });

  it("never excludes `tag` where a topic row is read: AMS gates the topics' `tags` FIELD on include_type?('tag'), not just the root", async () => {
    // Live 3.8.1: the former list profile (with `tag`) returned topics
    // WITHOUT a `tags` key; the unprofiled request returned it. Every
    // profile that reads TopicSerializer rows must therefore leave `tag`
    // in. The items profiles may exclude it: nothing there carries a
    // `tags` field the tool emits.
    const { EXCLUDE_TYPES } = await import("../src/loomio/client.js");
    for (const profile of ["list", "show", "threads"] as const) {
      expect(EXCLUDE_TYPES[profile].split(" "), profile).not.toContain("tag");
    }
    expect(EXCLUDE_TYPES.groups.split(" ")).toContain("tag");
  });

  it("the known-thread items profile is compact plus `discussion` (the opening post is already in hand); the reactions profile keeps `discussion`", async () => {
    const { EXCLUDE_TYPES } = await import("../src/loomio/client.js");
    const compact = ["topic", "group", "parent", "membership", "reaction", "tag", "translation"];
    const known = EXCLUDE_TYPES.items_known_thread.split(" ");
    for (const t of compact) expect(known).toContain(t);
    expect(known).toContain("discussion");
    expect(EXCLUDE_TYPES.items_with_reactions.split(" ")).not.toContain("discussion");
    expect(EXCLUDE_TYPES.items_with_reactions.split(" ")).not.toContain("reaction");
  });

  it("travel on the wire as a single space-separated value", async () => {
    mockFetch(200, {});
    const { loomioGet, readParams } = await import("../src/loomio/client.js");
    await loomioGet("/b2/discussions", { group_id: 1, status: "open", ...readParams("list") });
    const params = requestOf().url.searchParams;
    expect(params.get("exclude_types")).toBe("group parent membership reaction translation");
    expect(params.has("compact")).toBe(false);
  });
});

describe("success-path bodies", () => {
  it("an empty 2xx body resolves to {} instead of a JSON parse error", async () => {
    mockFetch(200, "");
    const { loomioGet } = await import("../src/loomio/client.js");
    await expect(loomioGet("/b2/comments/1")).resolves.toEqual({});
  });

  it("a whitespace-only body counts as empty", async () => {
    mockFetch(200, "  \n");
    const { loomioDelete } = await import("../src/loomio/client.js");
    await expect(loomioDelete("/b2/comments/1")).resolves.toEqual({});
  });

  it("a non-JSON 2xx body is a named error pointing at LOOMIO_API_BASE_URL / a proxy", async () => {
    mockFetch(200, "<!doctype html><html><title>Loomio</title></html>");
    const { loomioGet, LoomioApiError } = await import("../src/loomio/client.js");
    const err = await loomioGet("/b2/groups").catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/not JSON/);
    expect(err.message).toContain("LOOMIO_API_BASE_URL");
    expect(err.message).toContain("/b2/groups");
  });

  it("404 surfaces as LoomioApiError(404) with Loomio's numeric body flattened", async () => {
    mockFetch(404, { error: 404 });
    const { loomioGet, LoomioApiError } = await import("../src/loomio/client.js");
    const err = await loomioGet("/b2/threads/999").catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("404");
  });
});

describe("request deadline", () => {
  afterEach(() => vi.useRealTimers());

  /** Loomio accepts the connection and never answers; only the client's abort signal can end the wait. */
  function hangUntilAborted(): AbortSignal[] {
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
          if (!signal) {
            reject(new Error("expected the client to attach an abort signal"));
            return;
          }
          signals.push(signal);
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    return signals;
  }

  /** Resolve to the rejection (or the string "resolved") and expose whether it has happened yet. */
  function observe(p: Promise<unknown>) {
    const state = { settled: false, outcome: undefined as unknown };
    const done = p.then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    void done.then((o) => {
      state.settled = true;
      state.outcome = o;
    });
    return { state, done };
  }

  it("fetchWithTimeout honours a per-call timeoutMs: loomioGetRaw aborts at 8 s, not 60 s, and the 504 names 8s", async () => {
    vi.useFakeTimers();
    const signals = hangUntilAborted();
    const { loomioGetRaw, LoomioApiError } = await import("../src/loomio/client.js");
    const { state, done } = observe(loomioGetRaw("/b2/groups", undefined, { timeoutMs: 8_000 }));

    await vi.advanceTimersByTimeAsync(7_999);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await done;
    expect(signals[0]?.aborted).toBe(true);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect((err as InstanceType<typeof LoomioApiError>).status).toBe(504);
    expect((err as Error).message).toMatch(/timed out after 8s/);
    expect((err as Error).message).not.toMatch(/60s/);
    expectBearerAuth(0, "test-key");
  });

  it("loomioGetPublic takes the same opts, still without a credential", async () => {
    vi.useFakeTimers();
    const signals = hangUntilAborted();
    const { loomioGetPublic } = await import("../src/loomio/client.js");
    const { state, done } = observe(
      loomioGetPublic("/v1/boot/version", undefined, { timeoutMs: 8_000 }),
    );
    await vi.advanceTimersByTimeAsync(7_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await done;
    expect(signals[0]?.aborted).toBe(true);
    expect((err as Error).message).toMatch(/timed out after 8s/);
    expect(requestOf().headers["Authorization"]).toBeUndefined();
  });

  it("tool calls keep the 60 s deadline by default, and the message says 60s", async () => {
    // A slow but working Loomio should finish a big read: only the
    // probe, whose consumer gives up at ~10 s, asks for less.
    vi.useFakeTimers();
    const signals = hangUntilAborted();
    const { loomioGet, loomioGetRaw } = await import("../src/loomio/client.js");
    const get = observe(loomioGet("/b2/threads"));
    const raw = observe(loomioGetRaw("/b2/groups"));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(signals).toHaveLength(2);
    expect(get.state.settled).toBe(false);
    expect(raw.state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    for (const err of [await get.done, await raw.done]) {
      expect((err as Error).message).toMatch(/timed out after 60s/);
    }
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });
});

// Loomio 3.11.1 (bc1a6cc02) pages the groups index and thread items
// with `page_collection_bounded` (limit default 50, clamped to 500;
// offset; meta.total = the whole collection). The pager follows those
// pages, recognises a pre-3.11.1 reply that ignored the window, and
// stops at a hard page cap that it reports.
describe("paged reads: loomioPager / loomioGetAllPages / mergePageBodies", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, n: i }));
  /** Every page side-loads the same two users and one user per row: merging must dedupe them. */
  const sideLoads = (page: ReadonlyArray<Record<string, unknown>>) => ({
    users: [{ id: 9001 }, { id: 9002 }],
    things: page.map((r) => ({ id: 100_000 + (r["id"] as number) })),
  });

  it("bounded server, 1 234 rows: three requests at offsets 0 / 500 / 1000, every row once, side-loads deduplicated", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(1234), sideLoads, mode: "bounded" },
    });
    const { loomioGetAllPages, B2_PAGE_MAX } = await import("../src/loomio/client.js");
    expect(B2_PAGE_MAX).toBe(500);
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      { compact: 1 },
      { root: "items", maxPages: 10 },
    );
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([
      ["500", "0"],
      ["500", "500"],
      ["500", "1000"],
    ]);
    const items = body["items"] as { id: number }[];
    expect(items).toHaveLength(1234);
    expect(new Set(items.map((r) => r.id)).size).toBe(1234);
    expect(items[0]?.id).toBe(1);
    expect(items[1233]?.id).toBe(1234);
    expect(body["users"]).toEqual([{ id: 9001 }, { id: 9002 }]);
    expect(body["things"]).toHaveLength(1234);
    expect(body["meta"]).toEqual({ root: "items", total: 1234 });
    expect(state).toEqual({
      requests: 3,
      total: 1234,
      rows: 1234,
      legacy: false,
      done: true,
      capped: false,
      lastPageFull: false,
    });
    expectBearerAuth(0, "test-key");
  });

  it("always names limit AND offset (offset=0 included) and keeps the caller's params", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(3), mode: "bounded" },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    await loomioGetAllPages("/b2/things", { exclude_types: "tag" }, { root: "items", maxPages: 2 });
    expect(calls).toEqual([{ path: "/api/b2/things", limit: "500", offset: "0" }]);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(url.searchParams.get("exclude_types")).toBe("tag");
  });

  it("a window (offset + want) is requested as exactly that: offset 600, want 100 → one request limit=100&offset=600", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(1234), mode: "bounded" },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", offset: 600, want: 100, maxPages: 2 },
    );
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([["100", "600"]]);
    expect((body["items"] as { id: number }[])[0]?.id).toBe(601);
    expect(state).toMatchObject({ requests: 1, rows: 100, done: true, capped: false });
  });

  it("legacy server (Loomio < 3.11.1) returning more rows than requested: ONE request, legacy true, the caller slices", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(300), mode: "legacy" },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", offset: 60, want: 20, maxPages: 2 },
    );
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([["20", "60"]]);
    expect(state).toMatchObject({ requests: 1, legacy: true, done: true, capped: false });
    // The whole collection from row 0: slicing is the caller's job.
    expect((body["items"] as unknown[]).length).toBe(300);
  });

  it("legacy server at a non-zero offset whose whole collection is within `limit`: detected by rows === total", async () => {
    mockFetchPaged({ "/b2/things": { root: "items", rows: rows(30), mode: "legacy" } });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { state } = await loomioGetAllPages(
      "/b2/things",
      {},
      {
        root: "items",
        offset: 10,
        maxPages: 2,
      },
    );
    expect(state).toMatchObject({ requests: 1, legacy: true, total: 30 });
  });

  it("legacy server whose whole collection FITS the first request at offset 0: one request, legacy false (indistinguishable, and complete), done", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(120), mode: "legacy" },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", maxPages: 10 },
    );
    expect(calls).toHaveLength(1);
    expect(state).toMatchObject({ requests: 1, legacy: false, done: true, capped: false });
    expect(body["items"]).toHaveLength(120);
  });

  it("meta.total absent: walks full pages and stops on the short one", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(1234), mode: "bounded", noTotal: true },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", maxPages: 10 },
    );
    expect(calls.map((c) => c.offset)).toEqual(["0", "500", "1000"]);
    expect(state).toMatchObject({
      requests: 3,
      total: null,
      rows: 1234,
      done: true,
      capped: false,
    });
    expect(body["items"]).toHaveLength(1234);
  });

  it("a short page is NOT the end while meta.total says more: a Loomio clamping to 100 is walked at offset += rows received", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(250), mode: "bounded", limitMax: 100 },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { state } = await loomioGetAllPages("/b2/things", {}, { root: "items", maxPages: 10 });
    expect(calls.map((c) => [c.limit, c.offset])).toEqual([
      ["500", "0"],
      ["500", "100"],
      ["500", "200"],
    ]);
    expect(state).toMatchObject({ requests: 3, rows: 250, done: true, capped: false });
  });

  it("a repeating page (no unseen ids) stops the walk instead of looping", async () => {
    mockFetchRoutes({
      "/b2/things": {
        status: 200,
        body: { items: rows(3), meta: { root: "items", total: 10 } },
      },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", pageSize: 3, maxPages: 10 },
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ requests: 2, rows: 3, done: true, capped: false });
    expect(body["items"]).toHaveLength(3);
  });

  it("maxPages reached with rows left: capped true, and exactly maxPages requests", async () => {
    const calls = mockFetchPaged({
      "/b2/things": { root: "items", rows: rows(1234), mode: "bounded" },
    });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { body, state } = await loomioGetAllPages<Record<string, unknown>>(
      "/b2/things",
      {},
      { root: "items", maxPages: 2 },
    );
    expect(calls).toHaveLength(2);
    expect(state).toMatchObject({ requests: 2, rows: 1000, total: 1234, done: true, capped: true });
    expect(body["items"]).toHaveLength(1000);
  });

  it("a walk that ENDS on its last allowed page is complete, not capped", async () => {
    mockFetchPaged({ "/b2/things": { root: "items", rows: rows(1000), mode: "bounded" } });
    const { loomioGetAllPages } = await import("../src/loomio/client.js");
    const { state } = await loomioGetAllPages("/b2/things", {}, { root: "items", maxPages: 2 });
    expect(state).toMatchObject({ requests: 2, rows: 1000, capped: false, done: true });
  });

  it("the lazy pager hands out one page per next() and undefined once done", async () => {
    mockFetchPaged({ "/b2/things": { root: "items", rows: rows(700), mode: "bounded" } });
    const { loomioPager } = await import("../src/loomio/client.js");
    const pager = loomioPager<Record<string, unknown>>(
      "/b2/things",
      {},
      {
        root: "items",
        want: 600,
        maxPages: 2,
      },
    );
    const first = await pager.next();
    expect(first?.["items"]).toHaveLength(500);
    expect(pager.state.done).toBe(false);
    const second = await pager.next();
    expect(second?.["items"]).toHaveLength(100);
    expect(pager.state).toMatchObject({ done: true, capped: false, requests: 2 });
    expect(await pager.next()).toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("errors propagate from the page that failed", async () => {
    mockFetch(404, { error: 404 });
    const { loomioGetAllPages, LoomioApiError } = await import("../src/loomio/client.js");
    const err = await loomioGetAllPages("/b2/things", {}, { root: "items", maxPages: 2 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LoomioApiError);
  });

  it("mergePageBodies: arrays concatenated and deduped by id (first arrival kept), rows without an id kept, meta from the first page, inputs untouched, root always present", async () => {
    const { mergePageBodies } = await import("../src/loomio/client.js");
    const a = {
      items: [{ id: 1, v: "a" }, { id: 2 }],
      users: [{ id: 7, v: "first" }],
      notes: [{ text: "x" }],
      meta: { root: "items", total: 4 },
    };
    const b = {
      items: [{ id: 2 }, { id: 3 }],
      users: [{ id: 7, v: "second" }, { id: 8 }],
      notes: [{ text: "x" }],
      meta: { root: "items", total: 99 },
    };
    const before = JSON.stringify(a);
    const merged = mergePageBodies([a, b], "items");
    expect(merged.items.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(merged.users).toEqual([{ id: 7, v: "first" }, { id: 8 }]);
    expect(merged.notes).toHaveLength(2);
    expect(merged.meta).toEqual({ root: "items", total: 4 });
    expect(JSON.stringify(a)).toBe(before);
    expect(merged.items).not.toBe(a.items);
    expect(mergePageBodies([{ meta: {} }], "groups")).toEqual({ meta: {}, groups: [] });
  });
});

describe("apiBaseUrl", () => {
  it("returns the default or the validated override", async () => {
    const { apiBaseUrl } = await import("../src/loomio/client.js");
    expect(apiBaseUrl()).toBe("https://www.loomio.com/api");
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api";
    expect(apiBaseUrl()).toBe("https://loomio.example.org/api");
    delete process.env["LOOMIO_API_BASE_URL"];
  });
});
