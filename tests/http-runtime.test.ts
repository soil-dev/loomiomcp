/**
 * The HTTP entry's startup wiring (round-2 finding): `buildHttpRuntime`
 * (src/http/runtime.ts) is everything src/http.ts does before it listens.
 * Before it existed nothing imported src/http.ts, so deleting or
 * INVERTING `setOpenDcrMode(...)` — the only switch for the F-16 daily
 * quotas and the nit-19 collapse — left every test green and `tsc` happy;
 * so did dropping the F-02 / F-17 / F-09 fatal refusals or the F-12
 * trust-proxy line. Each case here fails on such a mutation.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken, randomNonce, SigningKeys } from "../src/auth/token.js";
import { resetDailyQuotasForTests } from "../src/daily-quota.js";
import { isOpenDcr, setOpenDcrMode } from "../src/deployment.js";
import { buildHttpRuntime, type HttpRuntime } from "../src/http/runtime.js";
import { resetHealthForTests } from "../src/loomio/health.js";
import { resetUpstreamRateForTests } from "../src/loomio/upstream.js";
import { groupsIndexBody } from "./fixtures.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "http://127.0.0.1:8080";

const OPEN_DCR = {
  LOOMIO_API_KEY: "test-key-123",
  PUBLIC_BASE_URL: BASE,
  MCP_OAUTH_SIGNING_KEY: KEY,
  MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
};
const STATIC = {
  LOOMIO_API_KEY: "test-key-123",
  PUBLIC_BASE_URL: BASE,
  MCP_OAUTH_SIGNING_KEY: KEY,
  MCP_OAUTH_CLIENT_ID: "static-client",
  MCP_OAUTH_CLIENT_SECRET: "static-secret-0123456789",
};

const touched = new Set<string>();
function setEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  for (const [k, v] of Object.entries(env)) {
    touched.add(k);
    process.env[k] = v;
  }
  return process.env;
}

let servers: Server[] = [];

beforeEach(() => {
  setOpenDcrMode(false);
  resetDailyQuotasForTests();
  resetHealthForTests();
  resetUpstreamRateForTests();
  servers = [];
});

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const k of touched) delete process.env[k];
  touched.clear();
  setOpenDcrMode(false);
  vi.mocked(fetch).mockReset();
});

function built(env: NodeJS.ProcessEnv): HttpRuntime {
  const r = buildHttpRuntime(env);
  if ("fatal" in r) throw new Error(`unexpected fatal: ${r.fatal}`);
  return r;
}

async function listen(r: HttpRuntime): Promise<string> {
  await new Promise<void>((resolve) => r.server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(r.server);
  return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
}

function accessToken(): string {
  const now = Date.now();
  return issueToken(
    {
      type: "access",
      clientId: "runtime-test-client",
      resource: new URL("/mcp", BASE).href,
      scopes: [],
      iat: now,
      expiresAt: now + 60_000,
      nonce: randomNonce(),
    },
    new SigningKeys(KEY),
  );
}

async function callTool(base: string, id: number): Promise<{ status: number; text: string }> {
  const r = await globalThis.fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken()}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "list_groups", arguments: {} },
    }),
  });
  return { status: r.status, text: await r.text() };
}

function mockLoomio(): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/v1/boot/version") ? { version: "3.13.1" } : groupsIndexBody();
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
      statusText: "200",
    } as Awaited<ReturnType<typeof fetch>>;
  });
}

describe("buildHttpRuntime: the deployment mode", () => {
  it("open-DCR env turns isOpenDcr() on, and the daily quota is enforced end to end", async () => {
    const r = built(setEnv({ ...OPEN_DCR, MCP_DAILY_TOOL_CALLS: "2" }));
    expect(isOpenDcr()).toBe(true);
    mockLoomio();
    const base = await listen(r);
    const replies = [await callTool(base, 1), await callTool(base, 2), await callTool(base, 3)];
    expect(replies.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(replies[0]?.text).not.toMatch(/today's quota/);
    expect(replies[1]?.text).not.toMatch(/today's quota/);
    expect(replies[2]?.text).toMatch(/used today's quota of 2 tool calls/);
  });

  it("static-client env leaves isOpenDcr() off — and no quota applies", async () => {
    setOpenDcrMode(true); // a stale value must be overwritten, not kept
    const r = built(setEnv({ ...STATIC, MCP_DAILY_TOOL_CALLS: "1" }));
    expect(isOpenDcr()).toBe(false);
    mockLoomio();
    const base = await listen(r);
    await callTool(base, 1);
    expect((await callTool(base, 2)).text).not.toMatch(/today's quota/);
  });
});

describe("buildHttpRuntime: one fatal line, never quoting a secret", () => {
  const cases: Array<[string, Record<string, string>, RegExp, string?]> = [
    [
      "a two-line LOOMIO_API_KEY (F-02)",
      { ...OPEN_DCR, LOOMIO_API_KEY: "line-one-SECRET\nline-two-SECRET" },
      /^LOOMIO_API_KEY contains characters/,
      "SECRET",
    ],
    [
      "a malformed LOOMIO_MCP_GROUP_IDS (F-17)",
      { ...OPEN_DCR, LOOMIO_MCP_GROUP_IDS: "x" },
      /LOOMIO_MCP_GROUP_IDS/,
    ],
    [
      "a malformed MCP_OAUTH_REDIRECT_HOSTS (F-09)",
      { ...OPEN_DCR, MCP_OAUTH_REDIRECT_HOSTS: "a/b" },
      /MCP_OAUTH_REDIRECT_HOSTS/,
    ],
    [
      "a malformed MCP_SHARED_EGRESS_CIDRS",
      { ...OPEN_DCR, MCP_SHARED_EGRESS_CIDRS: "160.79.104.0/33" },
      /MCP_SHARED_EGRESS_CIDRS/,
    ],
    ["no LOOMIO_API_KEY", { ...OPEN_DCR, LOOMIO_API_KEY: "" }, /LOOMIO_API_KEY .*not set/],
    [
      "a short static client secret",
      { ...STATIC, MCP_OAUTH_CLIENT_SECRET: "short-SECRET" },
      /at least 16 characters/,
      "short-SECRET",
    ],
  ];
  for (const [name, env, pattern, secret] of cases) {
    it(name, () => {
      const r = buildHttpRuntime(setEnv(env));
      expect("fatal" in r).toBe(true);
      const line = (r as { fatal: string }).fatal;
      expect(line).toMatch(pattern);
      if (secret) expect(line).not.toContain(secret);
      // A refused start never takes on the mode.
      expect(isOpenDcr()).toBe(false);
    });
  }
});

describe("buildHttpRuntime: startup lines", () => {
  it("logs the effective MCP_HTTP_TRUST_PROXY (decision 4) and the bounds", () => {
    const r = built(setEnv(OPEN_DCR));
    const text = r.startupLines.map((l) => l.text).join("\n");
    expect(text).toContain(
      "MCP_HTTP_TRUST_PROXY=0: client addresses are the TCP peers (X-Forwarded-For ignored).",
    );
    expect(text).toMatch(/upstream bounds: 120 Loomio calls per HTTP request, 16 concurrent/);
    expect(text).toMatch(/daily quotas per source \(per process\): 5000 tool calls/);
    expect(r.startupLines.find((l) => l.text.includes("INSECURE_AUTO_APPROVE"))?.level).toBe(
      "warn",
    );
    const one = built(setEnv({ ...OPEN_DCR, MCP_HTTP_TRUST_PROXY: "1" }));
    expect(one.startupLines.map((l) => l.text).join("\n")).toMatch(
      /MCP_HTTP_TRUST_PROXY=1: client addresses are taken from X-Forwarded-For behind 1 proxy hop/,
    );
  });

  it("names the shared egress ranges and the bound address", async () => {
    const r = built(
      setEnv({ ...OPEN_DCR, MCP_SHARED_EGRESS_CIDRS: "192.0.2.0/24, 2001:db8::/32" }),
    );
    expect(r.startupLines.map((l) => l.text).join("\n")).toContain(
      "shared egress ranges (keyed per client as well): 192.0.2.0/24, 2001:db8::/32",
    );
    // A loopback PUBLIC_BASE_URL binds loopback only (F-10).
    expect(r.bind.host).toBe("127.0.0.1");
    await listen(r);
    expect(r.listeningLine(r.server.address() as AddressInfo)).toMatch(
      /^\[loomiomcp\] HTTP server listening on 127\.0\.0\.1:\d+ \| mode=read-write \| auth=INSECURE_AUTO_APPROVE/,
    );
  });

  it("the server carries the F-14 receive deadlines", () => {
    const r = built(setEnv(STATIC));
    expect([r.server.requestTimeout, r.server.headersTimeout]).toEqual([30_000, 10_000]);
  });
});
