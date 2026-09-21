/**
 * The HTTP client's 0.0.12 surface (src/loomio/client.ts): the write
 * verbs and their read-only guard, the nested-vs-flat body helpers,
 * array / csv query encoding, the per-tool read profiles, and the
 * success-path body handling (empty body → `{}`, non-JSON 2xx → a
 * named error).
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
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";

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
    for (const profile of ["list", "show", "groups"] as const) {
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

describe("apiBaseUrl", () => {
  it("returns the default or the validated override", async () => {
    const { apiBaseUrl } = await import("../src/loomio/client.js");
    expect(apiBaseUrl()).toBe("https://www.loomio.com/api");
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api";
    expect(apiBaseUrl()).toBe("https://loomio.example.org/api");
    delete process.env["LOOMIO_API_BASE_URL"];
  });
});
