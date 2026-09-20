/**
 * GET /health (src/http/health.ts).
 *
 * Three layers: the pure projection + handler with a fake Express
 * response (so the body contract and status mapping are pinned
 * precisely), the real Express mount on an ephemeral port hit with
 * Node's built-in fetch (which is NOT the mocked `undici` module) to
 * prove the route, headers and rate limiter are actually wired, and the
 * fully assembled `createApp` to prove the page survives its neighbours
 * (the OAuth router's unscoped `app.use`, the bearer-guarded /mcp).
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { setupLoomioTest } from "./test-helpers.js";
import { FixedClientStore, OAuthProvider } from "../src/auth/provider.js";
import { createApp } from "../src/http/app.js";
import {
  DEFAULT_HEALTH_PATH,
  healthzBody,
  healthzHandler,
  healthzStatusCode,
  mountHealth,
  resolveHealthPath,
} from "../src/http/health.js";
import { resetHealthForTests } from "../src/loomio/health.js";
import type { LoomioHealth } from "../src/loomio/health.js";
import { VERSION } from "../src/version.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

function mockUpstream(
  groupsStatus: number,
  groupsBody: unknown,
  version: unknown = { version: "3.8.1" },
) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const [status, body] = path.endsWith("/v1/boot/version")
      ? [200, version]
      : [groupsStatus, groupsBody];
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      statusText: String(status),
    } as Awaited<ReturnType<typeof fetch>>;
  });
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

// Silence the probe's forced `loomio.auth` events during these tests;
// tests/health.test.ts asserts on them, this file only needs them quiet.
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  resetHealthForTests();
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
});
afterEach(() => stderrSpy?.mockRestore());

describe("healthzBody / healthzStatusCode", () => {
  const base = { loomio_version: "3.8.1", checked_at: "2026-09-20T10:00:00.000Z" };

  it("valid → 200 ok", () => {
    const h: LoomioHealth = { key_status: "valid", ...base };
    expect(healthzStatusCode(h)).toBe(200);
    expect(healthzBody(h)).toEqual({
      status: "ok",
      connector_version: VERSION,
      key_status: "valid",
      loomio_version: "3.8.1",
      checked_at: base.checked_at,
    });
  });

  it("rejected and unreachable → 503 degraded", () => {
    for (const key_status of ["rejected", "unreachable"] as const) {
      const h: LoomioHealth = { key_status, ...base, detail: "secret-ish operator text" };
      expect(healthzStatusCode(h)).toBe(503);
      expect(healthzBody(h).status).toBe("degraded");
      expect(healthzBody(h).key_status).toBe(key_status);
    }
  });

  it("exposes ONLY the five public fields — never detail", () => {
    const h: LoomioHealth = {
      key_status: "unreachable",
      ...base,
      detail: "https://loomio.internal/api",
    };
    expect(Object.keys(healthzBody(h)).sort()).toEqual(
      ["checked_at", "connector_version", "key_status", "loomio_version", "status"].sort(),
    );
    expect(JSON.stringify(healthzBody(h))).not.toContain("loomio.internal");
  });
});

describe("healthzHandler", () => {
  it("answers 200 + no-store when the key is valid", async () => {
    mockUpstream(200, { groups: [] });
    const res = fakeRes();
    await healthzHandler({} as express.Request, res as unknown as express.Response, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({ status: "ok", key_status: "valid", loomio_version: "3.8.1" });
  });

  it("answers 503 when the key is rejected, with the body an uptime check can match on", async () => {
    mockUpstream(403, { error: "You are not authorized to access this page." });
    const res = fakeRes();
    await healthzHandler({} as express.Request, res as unknown as express.Response, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).toContain('"key_status":"rejected"');
    expect(JSON.stringify(res.body)).not.toContain('"key_status":"valid"');
    expect(JSON.stringify(res.body)).not.toContain("test-key");
  });

  it("answers 503 when Loomio is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = fakeRes();
    await healthzHandler({} as express.Request, res as unknown as express.Response, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      status: "degraded",
      key_status: "unreachable",
      loomio_version: null,
    });
    expect(res.body).not.toHaveProperty("detail");
  });
});

describe("GET /health mounted on Express", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let base = "";

  beforeEach(async () => {
    const app = express();
    app.set("trust proxy", 1);
    mountHealth(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    delete process.env["MCP_HTTP_RATE_LIMIT_MAX"];
  });

  it("needs no auth, sets no-store, and returns 200 with the JSON contract", async () => {
    mockUpstream(200, { groups: [] });
    const res = await globalThis.fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    // The per-IP limiter is in front (draft-7 standard headers).
    expect(res.headers.get("ratelimit-policy")).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "ok",
      connector_version: VERSION,
      key_status: "valid",
      loomio_version: "3.8.1",
      checked_at: expect.any(String),
    });
  });

  it("returns 503 for a rejected key", async () => {
    mockUpstream(403, { error: "You are not authorized to access this page." });
    const res = await globalThis.fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('"key_status":"rejected"');
  });

  it("moves to LOOMIO_MCP_HEALTH_PATH when set (hosting front-ends may reserve /health)", async () => {
    process.env["LOOMIO_MCP_HEALTH_PATH"] = "/-/health";
    const app = express();
    app.set("trust proxy", 1);
    mountHealth(app);
    const local = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const origin = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
      mockUpstream(200, { groups: [] });
      const moved = await globalThis.fetch(`${origin}/-/health`);
      expect(moved.status).toBe(200);
      expect(await moved.text()).toContain('"key_status":"valid"');
      // The default path is no longer served — one page, one checker target.
      expect((await globalThis.fetch(`${origin}${DEFAULT_HEALTH_PATH}`)).status).toBe(404);
    } finally {
      delete process.env["LOOMIO_MCP_HEALTH_PATH"];
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("resolveHealthPath: default, override, and loud refusal of a malformed value", () => {
    delete process.env["LOOMIO_MCP_HEALTH_PATH"];
    expect(resolveHealthPath()).toBe("/health");
    process.env["LOOMIO_MCP_HEALTH_PATH"] = "";
    expect(resolveHealthPath()).toBe("/health");
    process.env["LOOMIO_MCP_HEALTH_PATH"] = "/health";
    expect(resolveHealthPath()).toBe("/health");
    try {
      for (const bad of ["health", "/health?x=1", "/health z", "//evil.example/x"]) {
        process.env["LOOMIO_MCP_HEALTH_PATH"] = bad;
        expect(() => resolveHealthPath(), bad).toThrow(/LOOMIO_MCP_HEALTH_PATH/);
      }
    } finally {
      delete process.env["LOOMIO_MCP_HEALTH_PATH"];
    }
  });

  it("is rate limited per IP like /mcp (plain-JSON 429, not JSON-RPC)", async () => {
    // The limiter reads its config when the route is mounted, so set the
    // knob and mount a fresh app for this test.
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "2";
    const app = express();
    app.set("trust proxy", 1);
    mountHealth(app);
    const local = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/health`;
      mockUpstream(200, { groups: [] });
      expect((await globalThis.fetch(url)).status).toBe(200);
      expect((await globalThis.fetch(url)).status).toBe(200);
      const third = await globalThis.fetch(url);
      expect(third.status).toBe(429);
      expect(third.headers.get("cache-control")).toBe("no-store");
      expect(await third.json()).toEqual({ error: "too_many_requests" });
      // The whole burst cost Loomio exactly one probe pair (60 s cache).
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });
});

describe("GET /health through the assembled app (createApp)", () => {
  // The bare-express mounts above prove the handler and the limiter. This
  // proves the ROUTE ORDER in src/http/app.ts: /health is reachable and
  // unauthenticated beside the SDK's OAuth router (an unscoped `app.use`
  // in oauth-routes.ts) and the bearer-guarded /mcp. A catch-all or auth
  // middleware mounted ahead of it — in app.ts, in oauth-routes.ts, or
  // inside the SDK router after a dependency bump — would 404/401 the
  // page while every isolated test stayed green, and the uptime check
  // this page exists for would fail closed.
  let server: ReturnType<express.Express["listen"]> | undefined;
  let provider: OAuthProvider | undefined;
  let base = "";

  beforeEach(async () => {
    const issuerUrl = new URL("http://127.0.0.1/");
    provider = new OAuthProvider({
      clientsStore: new FixedClientStore({
        clientId: "test-client",
        clientSecret: "s".repeat(32),
        redirectUris: ["http://127.0.0.1/callback"],
      }),
      signingKey: "k".repeat(32),
      resourceUrl: new URL("/mcp", issuerUrl),
      enableAuthCodeGc: false,
    });
    const app = createApp({
      oauthProvider: provider,
      issuerUrl,
      jsonLimit: "1mb",
      allowedOrigins: [],
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    provider?.shutdown();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("is served 200 + no-store with no bearer, while /mcp still demands one and OAuth discovery still answers", async () => {
    mockUpstream(200, { groups: [] });
    const hz = await globalThis.fetch(`${base}/health`);
    expect(hz.status).toBe(200);
    expect(hz.headers.get("cache-control")).toBe("no-store");
    expect(hz.headers.get("ratelimit-policy")).toBeTruthy();
    expect(await hz.json()).toMatchObject({
      status: "ok",
      key_status: "valid",
      connector_version: VERSION,
    });

    // Neighbours are intact: the OAuth router still serves discovery and
    // /mcp is still bearer-guarded — mounting /health loosened neither.
    const meta = await globalThis.fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ issuer: expect.stringContaining("127.0.0.1") });
    const mcp = await globalThis.fetch(`${base}/mcp`);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toMatch(/Bearer/);

    // Only the health page cost Loomio anything: one probe pair.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("answers 503 with the rejected verdict through the same route", async () => {
    mockUpstream(403, { error: "You are not authorized to access this page." });
    const hz = await globalThis.fetch(`${base}/health`);
    expect(hz.status).toBe(503);
    expect(hz.headers.get("cache-control")).toBe("no-store");
    expect(await hz.text()).toContain('"key_status":"rejected"');
  });
});
