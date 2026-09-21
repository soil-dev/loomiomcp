/**
 * Key-health probe (src/loomio/health.ts).
 *
 * The probe is the connector's only defence against the silent-failure
 * mode where Loomio rotates the API key and every call 403s while the
 * process looks healthy. These tests pin: the three verdicts and what
 * produces each; that a CDN/WAF 403 is NOT reported as a rejected key;
 * that the public version probe never touches the verdict and never
 * carries the credential; the 60 s cache and its `force` bypass; and
 * the forced `loomio.auth` / `loomio.version_drift` events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { setupLoomioTest } from "./test-helpers.js";
import {
  HEALTH_CACHE_TTL_MS,
  checkLoomioHealth,
  getCachedHealth,
  resetHealthForTests,
} from "../src/loomio/health.js";
import { USER_AGENT } from "../src/loomio/client.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

type Route = { status: number; body: unknown; headers?: Record<string, string> } | Error;

const GENERIC_403 = { status: 403, body: { error: "You are not authorized to access this page." } };
const VERSION_OK = { status: 200, body: { version: "3.8.1", release: "abc", reload: false } };

/**
 * Route mock responses by path suffix. The probe issues its two GETs in
 * parallel, so ordering-based `mockFetch` queues would be fragile here.
 */
function mockRoutes(routes: Record<string, Route>): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
    if (!hit) throw new Error(`unmocked route: ${path}`);
    if (hit instanceof Error) throw hit;
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      headers: new Headers(hit.headers ?? {}),
      json: async () => hit.body,
      text: async () => (typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body)),
      statusText: String(hit.status),
    } as Awaited<ReturnType<typeof fetch>>;
  });
}

function callsTo(suffix: string) {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(suffix));
}

function headersOf(call: (typeof fetch)["mock"]["calls"][number] | undefined) {
  return (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

// The probe emits FORCED events (they bypass the verbose gate by
// design), so every test here would otherwise print JSON to the test
// runner's stderr. Capture instead: the forced-event tests read the
// captured lines back, the rest simply stay quiet.
let stderrLines: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrEvents(): Array<Record<string, unknown>> {
  return stderrLines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  resetHealthForTests();
  delete process.env["LOOMIO_MCP_LOG_VERBOSE"];
  stderrLines = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});
afterEach(() => {
  stderrSpy?.mockRestore();
  vi.useRealTimers();
});

describe("checkLoomioHealth verdicts", () => {
  it("valid: authenticated GET /b2/groups answers 200", async () => {
    mockRoutes({
      "/b2/groups": { status: 200, body: { groups: [] } },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("valid");
    expect(h.loomio_version).toBe("3.8.1");
    expect(h.detail).toBeUndefined();
    expect(Date.parse(h.checked_at)).not.toBeNaN();
  });

  it("valid even with zero groups (Loomio returns current_user.groups, possibly empty)", async () => {
    mockRoutes({
      "/b2/groups": { status: 200, body: { groups: [] } },
      "/v1/boot/version": VERSION_OK,
    });
    expect((await checkLoomioHealth()).key_status).toBe("valid");
  });

  it("rejected: 403 with Loomio's unauthenticated body", async () => {
    mockRoutes({ "/b2/groups": GENERIC_403, "/v1/boot/version": VERSION_OK });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("rejected");
    expect(h.reason).toBe("unauthenticated_body");
    expect(h.detail).toMatch(/no active user owns this API key/i);
    expect(h.detail).toContain("/profile/api_access");
    // The version probe is independent of the key.
    expect(h.loomio_version).toBe("3.8.1");
  });

  it("unreachable: 403 with an uncatalogued body → reason unrecognised_403; the body stays in detail only", async () => {
    mockRoutes({
      "/b2/groups": { status: 403, body: { error: "odd body SECRET-MARKER-42" } },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("unrecognised_403");
    expect(h.detail).toContain("SECRET-MARKER-42");
    // The forced event carries the reason code, never the body fragment.
    const auth = stderrEvents().filter((e) => e["event"] === "loomio.auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ key_status: "unreachable", reason: "unrecognised_403" });
    expect(auth[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(stderrEvents())).not.toContain("SECRET-MARKER");
  });

  it("unreachable, NOT rejected: a 403 answered by a CDN/WAF in front of Loomio", async () => {
    mockRoutes({
      "/b2/groups": {
        status: 403,
        body: {
          type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
          title: "Error 1010: Access denied",
          status: 403,
        },
      },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("waf");
    expect(h.detail).toMatch(/CDN\/WAF/);
  });

  it("unreachable: 5xx from Loomio", async () => {
    mockRoutes({
      "/b2/groups": { status: 502, body: "Bad Gateway" },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("http_502");
    expect(h.detail).toContain("HTTP 502");
  });

  it("unreachable: network error, with the error message as detail (and reason network_error)", async () => {
    mockRoutes({ "/b2/groups": new Error("ECONNREFUSED"), "/v1/boot/version": VERSION_OK });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("network_error");
    expect(h.detail).toContain("ECONNREFUSED");
    // The transport error text reaches `detail` for the operator, not the log event.
    const auth = stderrEvents().filter((e) => e["event"] === "loomio.auth");
    expect(auth[0]).toMatchObject({ reason: "network_error" });
    expect(JSON.stringify(auth)).not.toContain("ECONNREFUSED");
  });

  it("unreachable: configuration error (bad base URL) — and never throws", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "ftp://loomio.example.org/api";
    mockRoutes({});
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("config_error");
    expect(h.detail).toMatch(/must be https/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    // The configured host is operator-facing detail; the forced event
    // must not carry it (logs are aggregated; the URL is deployment config).
    expect(JSON.stringify(stderrEvents())).not.toContain("loomio.example.org");
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("unreachable: a base URL with userinfo is refused before the request, password never echoed", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "https://ops:hunter2@loomio.example.org/api";
    mockRoutes({});
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("unreachable");
    expect(h.reason).toBe("config_error");
    expect(h.detail).toMatch(/must not contain credentials/);
    expect(JSON.stringify(h)).not.toContain("hunter2");
    expect(JSON.stringify(stderrEvents())).not.toContain("hunter2");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("never puts the API key in the result", async () => {
    mockRoutes({ "/b2/groups": GENERIC_403, "/v1/boot/version": new Error("boom test-key") });
    const h = await checkLoomioHealth();
    // The version-probe error is swallowed (loomio_version: null), and the
    // key-probe detail is fixed text; the key must not surface anywhere.
    expect(JSON.stringify(h)).not.toContain("test-key");
  });
});

describe("checkLoomioHealth requests", () => {
  it("authenticates the groups probe and sends the version probe WITHOUT a credential", async () => {
    mockRoutes({ "/b2/groups": { status: 200, body: {} }, "/v1/boot/version": VERSION_OK });
    await checkLoomioHealth();

    const groups = headersOf(callsTo("/b2/groups")[0]);
    expect(groups["Authorization"]).toBe("Bearer test-key");
    expect(groups["User-Agent"]).toBe(USER_AGENT);

    const version = headersOf(callsTo("/v1/boot/version")[0]);
    expect(version["Authorization"]).toBeUndefined();
    expect(version["User-Agent"]).toBe(USER_AGENT);

    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).not.toContain("test-key");
  });

  it("parses {version} from /v1/boot/version and tolerates its absence", async () => {
    mockRoutes({
      "/b2/groups": { status: 200, body: {} },
      "/v1/boot/version": { status: 200, body: { version: "3.9.2" } },
    });
    expect((await checkLoomioHealth()).loomio_version).toBe("3.9.2");

    for (const bad of [
      { status: 404, body: "not found" },
      { status: 200, body: "<html>maintenance</html>" },
      { status: 200, body: { version: 42 } },
      { status: 200, body: {} },
      new Error("timeout"),
    ] as Route[]) {
      resetHealthForTests();
      mockRoutes({ "/b2/groups": { status: 200, body: {} }, "/v1/boot/version": bad });
      const h = await checkLoomioHealth();
      expect(h.loomio_version).toBeNull();
      // …and the key verdict is untouched by a failing version probe.
      expect(h.key_status).toBe("valid");
    }
  });
});

describe("checkLoomioHealth cache", () => {
  it("serves the cached result within 60 s, re-probes after, and honours force", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T10:00:00Z"));
    mockRoutes({ "/b2/groups": { status: 200, body: {} }, "/v1/boot/version": VERSION_OK });

    const first = await checkLoomioHealth();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(getCachedHealth()).toBe(first);

    // Within the TTL: no network.
    vi.setSystemTime(new Date("2026-09-20T10:00:59Z"));
    expect(await checkLoomioHealth()).toBe(first);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    // force bypasses the TTL.
    const forced = await checkLoomioHealth({ force: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    expect(forced).not.toBe(first);

    // Past the TTL: re-probe.
    vi.setSystemTime(new Date(Date.parse("2026-09-20T10:00:59Z") + HEALTH_CACHE_TTL_MS + 1));
    await checkLoomioHealth();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it("dedupes concurrent callers onto one in-flight probe", async () => {
    mockRoutes({ "/b2/groups": { status: 200, body: {} }, "/v1/boot/version": VERSION_OK });
    const [a, b, c] = await Promise.all([
      checkLoomioHealth(),
      checkLoomioHealth(),
      checkLoomioHealth({ force: true }),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("getCachedHealth is undefined before the first probe", () => {
    expect(getCachedHealth()).toBeUndefined();
  });
});

describe("forced events", () => {
  it("emits loomio.auth on the first result and on every key_status change, without verbose logging", async () => {
    mockRoutes({ "/b2/groups": { status: 200, body: {} }, "/v1/boot/version": VERSION_OK });
    await checkLoomioHealth();
    // Same verdict again: no new event.
    await checkLoomioHealth({ force: true });
    // Rotated under us: verdict flips → event.
    mockRoutes({ "/b2/groups": GENERIC_403, "/v1/boot/version": VERSION_OK });
    await checkLoomioHealth({ force: true });

    const auth = stderrEvents().filter((e) => e["event"] === "loomio.auth");
    expect(auth.map((e) => e["key_status"])).toEqual(["valid", "rejected"]);
    expect(auth[0]).toMatchObject({ loomio_version: "3.8.1" });
    expect(auth[0]).not.toHaveProperty("reason");
    // A closed-vocabulary reason, never the free-text detail: the event
    // is forced (cannot be switched off) and detail may quote upstream text.
    expect(auth[1]).toMatchObject({ reason: "unauthenticated_body" });
    expect(auth[1]).not.toHaveProperty("detail");
    // Verbose gate was off — only forced events reached stderr, so no
    // per-request `loomio.request` lines.
    expect(stderrEvents().some((e) => e["event"] === "loomio.request")).toBe(false);
    // And never the key.
    expect(JSON.stringify(stderrEvents())).not.toContain("test-key");
  });

  it("emits loomio.version_drift once when major.minor differs from the tested version", async () => {
    mockRoutes({
      "/b2/groups": { status: 200, body: {} },
      "/v1/boot/version": { status: 200, body: { version: "3.9.0" } },
    });
    await checkLoomioHealth();
    await checkLoomioHealth({ force: true });
    const drift = stderrEvents().filter((e) => e["event"] === "loomio.version_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ loomio_version: "3.9.0", tested_loomio_version: "3.8.1" });
  });

  it("stays quiet on a patch-level difference or an unknown version", async () => {
    mockRoutes({
      "/b2/groups": { status: 200, body: {} },
      "/v1/boot/version": { status: 200, body: { version: "3.8.7" } },
    });
    await checkLoomioHealth();
    resetHealthForTests();
    mockRoutes({
      "/b2/groups": { status: 200, body: {} },
      "/v1/boot/version": new Error("down"),
    });
    await checkLoomioHealth();
    expect(stderrEvents().some((e) => e["event"] === "loomio.version_drift")).toBe(false);
  });
});

describe("groups body cache (for check_connection)", () => {
  const GROUPS_BODY = {
    groups: [{ id: 7, name: "Finance", handle: "finance-team", parent_id: 2 }],
    parent_groups: [{ id: 2, name: "Example Org" }],
    memberships: [
      { id: 900, group_id: 7, user_id: 55, admin: false, accepted_at: "2026-01-01T00:00:00Z" },
    ],
    users: [{ id: 55, name: "Connector Bot", username: "bot" }],
    meta: { root: "groups", total: 1 },
  };

  it("keeps the parsed 200 body beside the verdict and sends the groups read profile", async () => {
    const { getCachedGroupsIndex, getFreshGroupsIndex } = await import("../src/loomio/health.js");
    mockRoutes({
      "/b2/groups": { status: 200, body: GROUPS_BODY },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("valid");
    expect(getCachedGroupsIndex()).toEqual(GROUPS_BODY);
    expect(getFreshGroupsIndex()).toEqual(GROUPS_BODY);
    // The verdict itself never carries the groups (it is what /health serialises).
    expect(h).not.toHaveProperty("groups");
    const url = new URL(String(callsTo("/b2/groups")[0]?.[0]));
    expect(url.searchParams.get("exclude_types")).toBe("tag translation");
  });

  it("is undefined when the probe did not answer 200, or answered non-JSON", async () => {
    const { getCachedGroupsIndex } = await import("../src/loomio/health.js");
    mockRoutes({ "/b2/groups": GENERIC_403, "/v1/boot/version": VERSION_OK });
    await checkLoomioHealth();
    expect(getCachedGroupsIndex()).toBeUndefined();

    resetHealthForTests();
    mockRoutes({
      "/b2/groups": { status: 200, body: "<html>login</html>" },
      "/v1/boot/version": VERSION_OK,
    });
    const h = await checkLoomioHealth();
    expect(h.key_status).toBe("valid");
    expect(getCachedGroupsIndex()).toBeUndefined();
  });

  it("a later non-200 probe replaces the body, so the cache never pairs a rejected verdict with stale groups", async () => {
    const { getCachedGroupsIndex } = await import("../src/loomio/health.js");
    mockRoutes({
      "/b2/groups": { status: 200, body: GROUPS_BODY },
      "/v1/boot/version": VERSION_OK,
    });
    await checkLoomioHealth();
    expect(getCachedGroupsIndex()).toBeDefined();
    mockRoutes({ "/b2/groups": GENERIC_403, "/v1/boot/version": VERSION_OK });
    await checkLoomioHealth({ force: true });
    expect(getCachedGroupsIndex()).toBeUndefined();
  });

  it("getFreshGroupsIndex expires with the verdict's TTL; getCachedGroupsIndex does not", async () => {
    const { getCachedGroupsIndex, getFreshGroupsIndex } = await import("../src/loomio/health.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T10:00:00Z"));
    mockRoutes({
      "/b2/groups": { status: 200, body: GROUPS_BODY },
      "/v1/boot/version": VERSION_OK,
    });
    await checkLoomioHealth();
    vi.setSystemTime(new Date(Date.parse("2026-09-20T10:00:00Z") + HEALTH_CACHE_TTL_MS + 1));
    expect(getFreshGroupsIndex()).toBeUndefined();
    expect(getCachedGroupsIndex()).toEqual(GROUPS_BODY);
  });

  it("resetHealthForTests clears it", async () => {
    const { getCachedGroupsIndex } = await import("../src/loomio/health.js");
    mockRoutes({
      "/b2/groups": { status: 200, body: GROUPS_BODY },
      "/v1/boot/version": VERSION_OK,
    });
    await checkLoomioHealth();
    resetHealthForTests();
    expect(getCachedGroupsIndex()).toBeUndefined();
  });
});
