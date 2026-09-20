/**
 * Loomio API authentication scheme, request identity, and how the
 * client explains refusals.
 *
 * Loomio changed auth in July 2026: b2 and b3 authenticate via
 * `Authorization: Bearer <key>`, and a key passed in the query string
 * is rejected outright — the request is treated as unauthenticated and
 * comes back 403, exactly as if no credential had been sent. These
 * tests pin the scheme so a regression surfaces here rather than as a
 * blanket 403 against the live instance.
 *
 * They also pin the `User-Agent` (a CDN/WAF in front of an instance
 * blocks default library UAs) and the 403 / 429 classification: Loomio
 * 3.1.1+ answers 403 with distinguishable bodies, and the client must
 * name the actual cause instead of listing every possible one.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { expectBearerAuth, mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";
import { resetCachedHealth, setCachedHealth } from "../src/loomio/health-cache.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
afterEach(() => resetCachedHealth());

const GENERIC_BODY = "You are not authorized to access this page.";
const CLOUDFLARE_BODY = {
  type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
  title: "Error 1010: Access denied",
  status: 403,
};

function userAgentOf(index: number): string | undefined {
  const opts = vi.mocked(fetch).mock.calls[index]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return opts?.headers?.["User-Agent"];
}

describe("b2 auth", () => {
  it("sends the API key as a bearer token, never in the URL", async () => {
    mockFetch(200, {});
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7, limit: 10 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expectBearerAuth(0, "test-key");
    // Ordinary params still travel in the query string.
    expect(String(url)).toContain("group_id=7");
    expect(String(url)).not.toContain("api_key");
  });

  it("keeps the key out of the URL on writes too", async () => {
    mockFetch(200, {});
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 1, body: "hello" });

    expectBearerAuth(0, "test-key");
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).not.toContain("api_key");
  });

  it("raises a clear error when LOOMIO_API_KEY is unset", async () => {
    delete process.env["LOOMIO_API_KEY"];
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 1 })).rejects.toThrow(/LOOMIO_API_KEY/);
    // The failure must happen before any network call.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("User-Agent", () => {
  it("is loomiomcp/<VERSION> on b2 reads and writes and on b3", async () => {
    const { VERSION } = await import("../src/version.js");
    const { USER_AGENT } = await import("../src/loomio/client.js");
    expect(USER_AGENT).toBe(`loomiomcp/${VERSION}`);

    mockFetch(200, {});
    const { listDiscussions } = await import("../src/tools/discussions.js");
    await listDiscussions({ group_id: 7 });
    expect(userAgentOf(0)).toBe(USER_AGENT);

    mockFetch(200, {});
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: 1, body: "hello" });
    expect(userAgentOf(1)).toBe(USER_AGENT);

    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    mockFetch(200, {});
    const { deactivateUser } = await import("../src/tools/admin.js");
    await deactivateUser({ id: 42 });
    expect(userAgentOf(2)).toBe(USER_AGENT);
    delete process.env["LOOMIO_B3_API_KEY"];
  });
});

describe("classifyForbidden", () => {
  it("(1) Cloudflare/WAF problem body → not a Loomio permissions error", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const c = classifyForbidden(JSON.stringify(CLOUDFLARE_BODY), { path: "/b2/groups" });
    expect(c.kind).toBe("waf");
    expect(c.message).toContain("CDN/WAF");
    expect(c.message).toContain("Error 1010: Access denied");
    expect(c.message).toMatch(/User-Agent/);
    expect(c.message).toMatch(/not a Loomio permissions error/i);
    expect(c.message).not.toMatch(/rotated/i);
  });

  it("(1b) any non-JSON 403 body is an intermediary, not Loomio", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    expect(classifyForbidden("<html><title>Access denied</title></html>").kind).toBe("waf");
    expect(classifyForbidden("").kind).toBe("waf");
  });

  it("(2) generic body on a visibility-gated list → unauthenticated OR group not visible, with the remedy", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of ["/b2/discussions", "/api/b2/polls"]) {
      const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), { path });
      expect(c.kind).toBe("unauthenticated");
      expect(c.message).toContain(path);
      expect(c.message).toMatch(/UNAUTHENTICATED/);
      expect(c.message).toMatch(/password changes/);
      expect(c.message).toMatch(/3\.3\.1/);
      // Only DiscussionsController#index and PollsController#index go
      // through `records_visible_in_group`, so only here may the message
      // hedge towards visibility.
      expect(c.message).toMatch(/not visible/);
      expect(c.message).toContain("/health");
      expect(c.message).toContain("/api/b2/groups");
      expect(c.message).toContain("/profile/api_access");
    }
  });

  it("(2) generic body on /b2/memberships → key rejected, and NOT a visibility problem", async () => {
    // Loomio 3.8.1 Api::B2::MembershipsController#index scopes by
    // MembershipQuery.visible_to with no can?(:show, group): a non-member
    // gets 200 + []. The generic body there can only come from
    // authenticate_api_key!. The same holds for every show/:id path
    // (load_and_authorize → "Not authorized to …") and for writes.
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of [
      "/b2/memberships",
      "/api/b2/discussions/:id",
      "/b2/polls/:id",
      "/b2/comments",
    ]) {
      const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), { path });
      expect(c.kind).toBe("unauthenticated");
      expect(c.message).toContain(path);
      expect(c.message).toMatch(/UNAUTHENTICATED/);
      expect(c.message).toMatch(/key was rejected/);
      expect(c.message).toMatch(/not a visibility or role problem/);
      expect(c.message).not.toMatch(/not visible/);
      expect(c.message).not.toMatch(/visibility problem/);
      expect(c.message).toContain("/profile/api_access");
    }
  });

  it("(2, health says rejected) → states definitively that the key is rejected", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of ["/b2/polls", "/b2/memberships"]) {
      const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
        path,
        keyStatus: "rejected",
      });
      expect(c.kind).toBe("unauthenticated");
      expect(c.message).toMatch(/^Loomio rejected the connector's API key/);
      expect(c.message).toContain("/profile/api_access");
      expect(c.message).not.toMatch(/not visible/);
    }
  });

  it("(2, fresh valid, visibility-gated list) → points at group visibility first", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
      path: "/b2/polls",
      keyStatus: "valid",
    });
    expect(c.kind).toBe("unauthenticated");
    expect(c.message).toMatch(/visibility problem/);
    expect(c.message).toMatch(/not visible/);
    expect(c.message).toMatch(/within the last minute/);
  });

  it("(2, fresh valid, any other path) → rotated in between, never 'visibility problem'", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of ["/b2/memberships", "/b2/discussions/:id"]) {
      const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
        path,
        keyStatus: "valid",
      });
      expect(c.kind).toBe("unauthenticated");
      expect(c.message).toMatch(/rotated in between/);
      expect(c.message).not.toMatch(/visibility problem/);
      expect(c.message).not.toMatch(/not visible/);
      expect(c.message).toContain("/profile/api_access");
    }
  });

  it("(2, POST to a list path) → key rejected, never 'group not visible' — only the GET index is gated", async () => {
    // create_discussion / create_poll POST to /b2/discussions and
    // /b2/polls. Loomio's #create never calls records_visible_in_group;
    // its refusals come from the service's authorize! with a message, so
    // the generic body on a write is the key and nothing else.
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of ["/b2/discussions", "/api/b2/polls"]) {
      for (const keyStatus of [undefined, "valid"] as const) {
        const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
          path,
          method: "POST",
          keyStatus,
        });
        expect(c.kind).toBe("unauthenticated");
        expect(c.message).toMatch(/not a visibility or role problem/);
        expect(c.message).not.toMatch(/\?group_id= list/);
        expect(c.message).not.toMatch(/not visible/);
        expect(c.message).not.toMatch(/visibility problem/);
        if (keyStatus === "valid") expect(c.message).toMatch(/rotated in between/);
      }
    }
    // The same paths on GET (explicit, any casing, or omitted) still hedge.
    for (const method of ["GET", "get", undefined]) {
      const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
        path: "/b2/polls",
        method,
      });
      expect(c.message).toMatch(/not visible/);
    }
  });

  it("(2, POST /b2/polls) names the one bare refusal a valid key can hit on a write", async () => {
    // PollService.invite raises a bare AccessDenied for an anonymous poll
    // that is not active — after PollService.create saved it.
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const polls = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
      path: "/api/b2/polls",
      method: "POST",
    });
    expect(polls.message).toMatch(/anonymous poll/);
    expect(polls.message).toMatch(/AFTER the poll itself was saved/);
    const discussions = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
      path: "/api/b2/discussions",
      method: "POST",
    });
    expect(discussions.message).not.toMatch(/anonymous poll/);
    const pollsIndex = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), {
      path: "/api/b2/polls",
    });
    expect(pollsIndex.message).not.toMatch(/anonymous poll/);
  });

  it("(2, /b3/ path) → the b3 SERVER secret, never the per-user key — whatever the health verdict", async () => {
    // Api::B3::UsersController#authenticate_api_key! secure_compares the
    // bearer against ENV['B3_API_KEY'] (unset / ≤ 16 chars also refuses)
    // and raises a bare AccessDenied: the same body as b2's
    // unauthenticated response, but about LOOMIO_B3_API_KEY. The health
    // probe tests the b2 key, so its verdict must not colour this.
    const { classifyForbidden } = await import("../src/loomio/client.js");
    for (const path of ["/api/b3/users/:id/deactivate", "/b3/users/:id/reactivate"]) {
      for (const keyStatus of [undefined, "valid", "rejected"] as const) {
        const c = classifyForbidden(JSON.stringify({ error: GENERIC_BODY }), { path, keyStatus });
        expect(c.kind).toBe("unauthenticated");
        expect(c.message).toContain(path);
        expect(c.message).toMatch(/LOOMIO_B3_API_KEY/);
        expect(c.message).toMatch(/ENV\['B3_API_KEY'\]/);
        expect(c.message).toMatch(/16 characters/);
        // None of the per-user-key remediation, and no health colouring.
        expect(c.message).not.toContain("/profile/api_access");
        expect(c.message).not.toMatch(/password changes|rotated|update LOOMIO_API_KEY/);
        expect(c.message).not.toMatch(
          /GET \/api\/b2\/groups|key-health probe|failing the same way/,
        );
        expect(c.message).not.toMatch(/not visible|visibility/);
      }
    }
  });

  it("(3, v1 path) does not vouch for the API key — v1 never evaluates it", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const v1 = classifyForbidden(JSON.stringify({ error: "Not authorized to show Group." }), {
      path: "/api/v1/groups/:id",
    });
    expect(v1.kind).toBe("not_authorized");
    expect(v1.message).not.toMatch(/API key is valid/);
    expect(v1.message).toMatch(/does not evaluate the API key/);
    const b2 = classifyForbidden(JSON.stringify({ error: "Not authorized to show Group." }), {
      path: "/api/b2/groups/:id",
    });
    expect(b2.message).toMatch(/API key is valid/);
  });

  it("(3) 'Not authorized to <action> <Model>.' → surfaced verbatim as a permission gap", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const c = classifyForbidden(JSON.stringify({ error: "Not authorized to show Group." }));
    expect(c.kind).toBe("not_authorized");
    expect(c.message).toContain("Not authorized to show Group.");
    expect(c.message).toMatch(/lacks permission for this action or record/);
    expect(c.message).toMatch(/key is valid/i);
  });

  it("(4) 'User is not an admin' → group admin (coordinator) role", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const c = classifyForbidden(JSON.stringify({ error: "User is not an admin" }));
    expect(c.kind).toBe("not_admin");
    expect(c.message).toMatch(/group admin \(coordinator\) role/);
    expect(c.message).toMatch(/ON THAT GROUP/);
  });

  it("(5) numeric body → subscription/plan limit; so does the thread-limit body", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const cap = classifyForbidden(JSON.stringify({ error: 403 }));
    expect(cap.kind).toBe("plan_limit");
    expect(cap.message).toMatch(/subscription\/plan limit/);
    const threads = classifyForbidden(
      JSON.stringify({
        error:
          "This organization has reached its thread limit. Please upgrade to continue using Loomio.",
        action: "upgrade",
      }),
    );
    expect(threads.kind).toBe("plan_limit");
    expect(threads.message).toContain("thread limit");
  });

  it("(6) anything else → unknown, body included", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const c = classifyForbidden(JSON.stringify({ error: "Something new" }));
    expect(c.kind).toBe("unknown");
    expect(c.message).toContain("Something new");
  });

  it("clips every echoed body to ~200 chars (cases 1, 3, 5, 6)", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const big = "x".repeat(10_000);
    const cases = [
      JSON.stringify({ type: "https://cloudflare.example/err", title: `Error 1010: ${big}` }),
      JSON.stringify({ error: `Not authorized to ${big}` }),
      JSON.stringify({ error: big, action: "upgrade" }),
      JSON.stringify({ error: big }),
    ];
    for (const body of cases) {
      const { message } = classifyForbidden(body, { path: "/b2/polls" });
      expect(message.length).toBeLessThan(700);
      expect(message).toContain("[truncated, ");
    }
  });

  it("never claims Loomio's 403 is undiagnosable, and never mentions 401", async () => {
    const { classifyForbidden } = await import("../src/loomio/client.js");
    const bodies = [
      JSON.stringify(CLOUDFLARE_BODY),
      "<html/>",
      JSON.stringify({ error: GENERIC_BODY }),
      JSON.stringify({ error: "Not authorized to show Group." }),
      JSON.stringify({ error: "User is not an admin" }),
      JSON.stringify({ error: 403 }),
      JSON.stringify({ error: "odd" }),
    ];
    for (const body of bodies) {
      for (const keyStatus of [undefined, "valid", "rejected", "unreachable"] as const) {
        const { message } = classifyForbidden(body, { keyStatus });
        expect(message).not.toMatch(/same 403/i);
        expect(message).not.toMatch(/401/);
        expect(message).not.toMatch(/undiagnosable/i);
      }
    }
  });
});

describe("403 through the client", () => {
  it("throws LoomioAuthError(403) carrying the classified kind and message", async () => {
    mockFetch(403, { error: GENERIC_BODY });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("unauthenticated");
    expect(err.message).toContain("/b2/discussions");
    expect(err.message).toContain("/profile/api_access");
    expect(err.message).not.toMatch(/same 403/);
  });

  it("uses the health cache: a cached `rejected` makes the message definitive", async () => {
    setCachedHealth({
      key_status: "rejected",
      loomio_version: "3.8.1",
      checked_at: new Date().toISOString(),
    });
    mockFetch(403, { error: GENERIC_BODY });
    const { listPolls } = await import("../src/tools/polls.js");
    const err = await listPolls({ group_id: 7 }).catch((e) => e);
    expect(err.message).toMatch(/^Loomio rejected the connector's API key/);
  });

  it("uses a FRESH cached `valid` to point at visibility on a gated list", async () => {
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 10_000,
    );
    mockFetch(403, { error: GENERIC_BODY });
    const { listPolls } = await import("../src/tools/polls.js");
    const err = await listPolls({ group_id: 7 }).catch((e) => e);
    expect(err.message).toMatch(/most likely a visibility problem/);
  });

  it("ignores a STALE cached `valid`: after a rotation the 403 must not read as 'not a key problem'", async () => {
    // Startup probe said valid; the key was rotated hours later; under
    // stdio nothing re-probes. The classification must fall back to the
    // neutral wording, not blame group visibility.
    const { HEALTH_CACHE_TTL_MS } = await import("../src/loomio/health-cache.js");
    for (const ageMs of [HEALTH_CACHE_TTL_MS + 1, 10 * 60_000, 3 * 24 * 3_600_000]) {
      setCachedHealth(
        { key_status: "valid", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
        Date.now() - ageMs,
      );
      mockFetch(403, { error: GENERIC_BODY });
      const { listPolls } = await import("../src/tools/polls.js");
      const err = await listPolls({ group_id: 7 }).catch((e) => e);
      expect(err.message).not.toMatch(/visibility problem/);
      expect(err.message).not.toMatch(/passed a key-health probe/);
      expect(err.message).toMatch(/UNAUTHENTICATED/);
      expect(err.message).toContain("/profile/api_access");

      mockFetch(403, { error: GENERIC_BODY });
      const { getDiscussion } = await import("../src/tools/discussions.js");
      const show = await getDiscussion({ id_or_key: 5 }).catch((e) => e);
      expect(show.message).not.toMatch(/visibility problem/);
      expect(show.message).toMatch(/key was rejected/);
    }
  });

  it("a stale `rejected` is not stated as definitive either", async () => {
    setCachedHealth(
      { key_status: "rejected", loomio_version: "3.8.1", checked_at: new Date().toISOString() },
      Date.now() - 10 * 60_000,
    );
    mockFetch(403, { error: GENERIC_BODY });
    const { listPolls } = await import("../src/tools/polls.js");
    const err = await listPolls({ group_id: 7 }).catch((e) => e);
    expect(err.message).not.toMatch(/^Loomio rejected the connector's API key/);
    expect(err.message).toMatch(/UNAUTHENTICATED/);
  });

  it("classifies the other Loomio bodies on the wire too", async () => {
    const { listDiscussions } = await import("../src/tools/discussions.js");

    mockFetch(403, { error: "User is not an admin" });
    expect((await listDiscussions({ group_id: 7 }).catch((e) => e)).kind).toBe("not_admin");

    mockFetch(403, { error: 403 });
    expect((await listDiscussions({ group_id: 7 }).catch((e) => e)).kind).toBe("plan_limit");

    mockFetch(403, CLOUDFLARE_BODY);
    const waf = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(waf.kind).toBe("waf");
    expect(waf.message).toContain("Error 1010");
  });

  it("redacts ids from the path in the message", async () => {
    mockFetch(403, { error: "Not authorized to show Discussion." });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const err = await getDiscussion({ id_or_key: 254022621 }).catch((e) => e);
    expect(err.message).toContain("/b2/discussions/:id");
    expect(err.message).not.toContain("254022621");
  });
});

describe("429 (rate limited)", () => {
  it("text/plain from Rack::Attack → LoomioApiError(429) with a retry message and Retry-After", async () => {
    mockFetch(429, "Retry later\n", { "Content-Type": "text/plain", "Retry-After": "120" });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).toMatch(/5-minute window/);
    expect(err.message).toContain("Retry after 120 seconds");
    expect(err.message).toContain("Retry later");
  });

  it("without Retry-After it still tells the caller to wait", async () => {
    mockFetch(429, "Retry later\n", { "Content-Type": "text/plain" });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/No Retry-After header/);
  });

  it("Loomio's JSON invitation throttle body is surfaced verbatim", async () => {
    mockFetch(429, {
      flash: { error: "Daily invitation limit reached. Contact support immediately." },
    });
    const { manageMemberships } = await import("../src/tools/memberships.js");
    const err = await manageMemberships({ group_id: 7, emails: ["a@example.org"] }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toContain("Daily invitation limit reached");
    expect(err.message).not.toMatch(/Rack::Attack/);
  });

  it("clips a huge non-JSON 429 body", async () => {
    mockFetch(429, "x".repeat(10_000), { "Content-Type": "text/plain" });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message.length).toBeLessThan(900);
    expect(err.message).toContain("[truncated, 10000 chars]");
  });
});

describe("other error statuses", () => {
  it("401 on a b2 path is attributed to an intermediary (b2/b3 answer auth failures with 403)", async () => {
    mockFetch(401, { error: "proxy auth required" });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    // Still an auth-class error so fan-out tools propagate it instead of
    // counting it as a per-group miss — but the blame is placed correctly,
    // and it carries no ForbiddenKind (that is the 403 catalogue).
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(401);
    expect(err.kind).toBeUndefined();
    expect(err.message).toMatch(/b2\/b3 API answers its own authentication failures with 403/);
    expect(err.message).toMatch(/in front of Loomio/);
    expect(err.message).toContain("proxy auth required");
    // The universal claim was false: Loomio's v1 RestfulController does
    // render 401 ("you gotta be signed in").
    expect(err.message).not.toMatch(/API itself never answers 401/);
    expect(err.message).not.toMatch(/key is invalid/i);
  });

  it("401 on a v1 path names Loomio's own session-only 401 as a possible source", async () => {
    // createDiscussion's privacy resolver reads GET /v1/groups/{id}.
    mockFetch(401, { error: "you gotta be signed in" });
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { createDiscussion } = await import("../src/tools/discussions.js");
    const err = await createDiscussion({ title: "T", group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("/v1/groups/:id");
    expect(err.message).toMatch(/v1 \(browser API\)/);
    expect(err.message).toMatch(/signed-in browser session/);
    expect(err.message).toMatch(/does not read the key/);
    expect(err.message).toContain("you gotta be signed in");
  });

  it("clips a multi-KB HTML error page from a CDN/proxy (5xx) instead of echoing it whole", async () => {
    const page = `<html><body>${"Bad gateway. ".repeat(800)}</body></html>`;
    mockFetch(502, page, { "Content-Type": "text/html" });
    const { LoomioApiError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioApiError);
    expect(err.status).toBe(502);
    expect(err.message.length).toBeLessThan(600);
    expect(err.message).toContain(`[truncated, ${page.length} chars]`);
    expect(err.message).toMatch(/^Loomio API error 502: <html>/);
  });

  it("clips a huge JSON 403 body through the client too", async () => {
    mockFetch(403, { error: "z".repeat(10_000) });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.kind).toBe("unknown");
    expect(err.message.length).toBeLessThan(600);
  });

  it("an empty non-JSON body falls back to the status text", async () => {
    mockFetch(503, "", { "Content-Type": "text/html" });
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toBe("Loomio API error 503: 503");
  });

  it("422 validation errors are still flattened field: message", async () => {
    mockFetch(422, { errors: { title: ["can't be blank"], group: "is required" } });
    const { createDiscussion } = await import("../src/tools/discussions.js");
    // createDiscussion first auto-resolves privacy via a group read; give it a discussion-less 200.
    const err = await createDiscussion({ title: "T", group_id: 7, private: true }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.message).toContain("title: can't be blank");
    expect(err.message).toContain("group: is required");
  });
});

describe("LOOMIO_API_BASE_URL validation never echoes the configured value", () => {
  afterEach(() => {
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("refuses userinfo before undici can quote the whole URL back", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "https://ops:hunter2@loomio.example.org/api";
    const { LoomioAuthError } = await import("../src/loomio/client.js");
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(LoomioAuthError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/must not contain credentials/);
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("ops:");
    expect(err.message).not.toContain("loomio.example.org");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("an unparsable value is reported without being repeated", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "not a url with token=abc123";
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.message).toMatch(/not a valid URL/);
    expect(err.message).not.toContain("abc123");
  });

  it("a wrong scheme names only protocol and host", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "http://loomio.example.org:8080/api?debug=1";
    const { listDiscussions } = await import("../src/tools/discussions.js");
    const err = await listDiscussions({ group_id: 7 }).catch((e) => e);
    expect(err.message).toMatch(/must be https/);
    expect(err.message).toContain("http://loomio.example.org:8080");
    expect(err.message).not.toContain("debug=1");
  });
});
