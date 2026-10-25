/**
 * The HTTP transport's hardening (security review 2026-10-25: F-01, F-06,
 * F-12, F-13, F-14, F-16, nits 5, 6, 7 and 21). Everything runs on an
 * ephemeral loopback port with `createApp` and is driven with Node's
 * built-in fetch; the connector's own outbound calls go to the mocked
 * `undici` fetch, so "upstream" below means calls the connector made to
 * that mock. Each case names its finding and FAILS against v0.0.16 unless
 * it says otherwise.
 */

import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type express from "express";
import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthProvider, StatelessClientsStore } from "../src/auth/provider.js";
import { issueToken, randomNonce, SigningKeys } from "../src/auth/token.js";
import {
  chargeDailyToolCall,
  DailyQuotaError,
  recordDailyResultBytes,
  resetDailyQuotasForTests,
} from "../src/daily-quota.js";
import { setOpenDcrMode } from "../src/deployment.js";
import {
  CONNECTIONS_CHECK_INTERVAL_MS,
  createApp,
  createHttpServer,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  terminalErrorHandler,
} from "../src/http/app.js";
import { clientIpKey } from "../src/http/rate-limit.js";
import {
  parseSharedEgressCidrs,
  SHARED_EGRESS_DAILY_FACTOR,
  type SharedEgress,
} from "../src/http/shared-egress.js";
import { createMcpTransport, mcpErrorLine } from "../src/http/transport.js";
import { clientIdTag, withRequestContext } from "../src/log.js";
import { loomioGet } from "../src/loomio/client.js";
import { resetHealthForTests } from "../src/loomio/health.js";
import {
  resetUpstreamRateForTests,
  UpstreamBusyError,
  UpstreamCancelledError,
  UpstreamRateError,
  upstreamRateStats,
  upstreamSlotStats,
  withToolCallSignal,
} from "../src/loomio/upstream.js";
import { createLoomioMcpServer } from "../src/server.js";
import { groupsIndexBody, reportsUsersBody, searchAuthorBody } from "./fixtures.js";
import { setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Env knobs a case may set; all are cleared after every case.
const KNOBS = [
  "MCP_HTTP_RATE_LIMIT_MAX",
  "MCP_HTTP_UPSTREAM_BUDGET",
  "MCP_HTTP_UPSTREAM_CONCURRENCY",
  "MCP_HTTP_UPSTREAM_PER_5MIN",
  "MCP_DAILY_TOOL_CALLS",
  "MCP_DAILY_RESULT_BYTES",
  "LOOMIO_MCP_LOG_VERBOSE",
  "NODE_ENV",
];
const savedNodeEnv = process.env["NODE_ENV"];

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Instance {
  base: string;
  issuer: URL;
  server: Server;
  provider: OAuthProvider;
}

let instances: Instance[] = [];
let stderr: string[] = [];
let consoleErrors: string[] = [];

beforeEach(() => {
  instances = [];
  stderr = [];
  consoleErrors = [];
  resetHealthForTests();
  resetDailyQuotasForTests();
  resetUpstreamRateForTests();
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  for (const i of instances) {
    i.provider.shutdown();
    i.server.closeAllConnections();
    await new Promise<void>((resolve) => i.server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  setOpenDcrMode(false);
  for (const k of KNOBS) delete process.env[k];
  if (savedNodeEnv !== undefined) process.env["NODE_ENV"] = savedNodeEnv;
});

async function start(
  opts: {
    issuer?: string;
    trustProxy?: number;
    jsonLimit?: string | number;
    allowedOrigins?: string[];
    sharedEgress?: SharedEgress;
  } = {},
): Promise<Instance> {
  const issuer = new URL(opts.issuer ?? "http://127.0.0.1/");
  const provider = new OAuthProvider({
    clientsStore: new StatelessClientsStore(KEY),
    signingKey: KEY,
    resourceUrl: new URL("/mcp", issuer),
    enableAuthCodeGc: false,
  });
  const app = createApp({
    oauthProvider: provider,
    issuerUrl: issuer,
    allowedOrigins: opts.allowedOrigins ?? [issuer.origin, "https://claude.ai"],
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
    ...(opts.jsonLimit !== undefined ? { jsonLimit: opts.jsonLimit } : {}),
    ...(opts.sharedEgress ? { sharedEgress: opts.sharedEgress } : {}),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const i = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    issuer,
    server,
    provider,
  };
  instances.push(i);
  return i;
}

/** Options for a bare `createApp` that is listened on by the test itself. */
function appOptions() {
  const issuer = new URL("http://127.0.0.1/");
  const provider = new OAuthProvider({
    clientsStore: new StatelessClientsStore(KEY),
    signingKey: KEY,
    resourceUrl: new URL("/mcp", issuer),
    enableAuthCodeGc: false,
  });
  return { oauthProvider: provider, issuerUrl: issuer, allowedOrigins: [issuer.origin] };
}

/** A valid access token for `issuer`'s /mcp, minted the way the provider does. */
function accessToken(issuer: URL, clientId = "test-client"): string {
  const now = Date.now();
  return issueToken(
    {
      type: "access",
      clientId,
      resource: new URL("/mcp", issuer).href,
      scopes: [],
      iat: now,
      expiresAt: now + 60_000,
      nonce: randomNonce(),
    },
    new SigningKeys(KEY),
  );
}

interface McpReply {
  status: number;
  headers: Headers;
  text: string;
  messages: Array<Record<string, unknown>>;
}

async function postMcp(
  i: Instance,
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<McpReply> {
  const token = opts.token === undefined ? accessToken(i.issuer) : opts.token;
  const r = await globalThis.fetch(`${i.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await r.text();
  const messages: Array<Record<string, unknown>> = [];
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) messages.push(JSON.parse(line.slice(5)));
    }
  } else if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      messages.push(...((Array.isArray(parsed) ? parsed : [parsed]) as typeof messages));
    } catch {
      // not JSON — the assertions look at `text`
    }
  }
  return { status: r.status, headers: r.headers, text, messages };
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const gua = (id: number, groups: number) =>
  call(id, "get_user_activity", {
    user_id: 502,
    group_ids: Array.from({ length: groups }, (_, j) => j + 1),
  });

function toolResult(m: Record<string, unknown>): { isError: boolean; text: string } {
  const result = m["result"] as
    | { isError?: boolean; content?: Array<{ text?: string }> }
    | undefined;
  return { isError: result?.isError === true, text: result?.content?.[0]?.text ?? "" };
}

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>;
}

/** Answer every route the tools under test use. */
function mockLoomio(delayMs = 0): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/v1/boot/version")) return response(200, { version: "3.13.1" });
    if (path.endsWith("/b2/reports")) {
      const gid = Number(url.searchParams.get("group_ids"));
      return response(200, reportsUsersBody({ group_ids: [gid] }));
    }
    if (path.endsWith("/b2/search")) return response(200, searchAuthorBody());
    if (path.endsWith("/b2/groups")) return response(200, groupsIndexBody());
    return response(404, { error: "not found" });
  });
}

const upstreamCalls = () => vi.mocked(fetch).mock.calls.length;

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// ── F-01 (a): per-HTTP-request upstream budget ──────────────────────────────

describe("upstream budget per HTTP request (F-01 a)", () => {
  it("a JSON-RPC batch shares ONE budget: 3 × get_user_activity(50 groups) stops at 120 upstream calls with a clear tool error", async () => {
    mockLoomio();
    const i = await start();
    // No MCP-Protocol-Version header = 2025-03-26, which still has batches.
    const r = await postMcp(i, [gua(1, 50), gua(2, 50), gua(3, 50)]);
    expect(r.status).toBe(200);
    expect(r.messages).toHaveLength(3);
    // v0.0.16: 153 calls (3 × (50 reports + 1 search)), no error.
    expect(upstreamCalls()).toBe(120);
    const results = r.messages.map(toolResult);
    expect(results.some((x) => x.isError && /upstream budget of 120/.test(x.text))).toBe(true);
    expect(results.find((x) => x.isError)?.text).toMatch(/MCP_HTTP_UPSTREAM_BUDGET/);
  });

  it("is per request, not per process — and MCP_HTTP_UPSTREAM_BUDGET=0 lifts it (passes on v0.0.16 too)", async () => {
    mockLoomio();
    process.env["MCP_HTTP_UPSTREAM_BUDGET"] = "60";
    const i = await start();
    for (const id of [1, 2]) {
      const r = await postMcp(i, gua(id, 50));
      expect(toolResult(r.messages[0] as Record<string, unknown>).isError).toBe(false);
    }
    expect(upstreamCalls()).toBe(102);
    vi.mocked(fetch).mockClear();
    process.env["MCP_HTTP_UPSTREAM_BUDGET"] = "0";
    const r = await postMcp(i, [gua(1, 50), gua(2, 50), gua(3, 50)]);
    expect(r.messages.map(toolResult).every((x) => !x.isError)).toBe(true);
    expect(upstreamCalls()).toBe(153);
  });
});

// ── F-01 (d) / (e): batch policy ────────────────────────────────────────────

describe("JSON-RPC batch policy (F-01 d, e)", () => {
  const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });

  it("refuses an array with 400 / -32600 when MCP-Protocol-Version is 2025-06-18 or later", async () => {
    const i = await start();
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const r = await postMcp(i, [list(1), list(2)], {
        headers: { "mcp-protocol-version": version },
      });
      expect(r.status, version).toBe(400);
      expect((r.messages[0]?.["error"] as { code?: number } | undefined)?.code).toBe(-32600);
    }
    expect(upstreamCalls()).toBe(0);
  });

  it("still answers a batch from a 2025-03-26 client, and logs its size on the request event (e)", async () => {
    process.env["LOOMIO_MCP_LOG_VERBOSE"] = "1";
    const i = await start();
    const r = await postMcp(i, [list(1), list(2)], {
      headers: { "mcp-protocol-version": "2025-03-26" },
    });
    expect(r.status).toBe(200);
    expect(r.messages).toHaveLength(2);
    const chain = stderr
      .filter((l) => l.includes('"event":"tool.chain"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(chain.at(-1)?.["batchSize"]).toBe(2);
  });
});

// ── F-01 (b): cancellation ──────────────────────────────────────────────────

/** A Loomio that never answers: each fetch settles only when its signal aborts. */
function hangingLoomio(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  vi.mocked(fetch).mockImplementation((_input, init) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  });
  return signals;
}

describe("cancellation (F-01 b)", () => {
  it("a client that hangs up stops the fan-out: in-flight Loomio requests abort and no further one is sent", async () => {
    const signals = hangingLoomio();
    const i = await start();
    const client = new AbortController();
    const pending = postMcp(i, gua(1, 20), { signal: client.signal }).catch((e: Error) => e.name);
    // 4 report lanes + the author search are in flight.
    expect(await until(() => upstreamCalls() >= 5)).toBe(true);
    client.abort();
    expect(await pending).toBe("AbortError");
    // v0.0.16: the fetch signals were the 60 s deadline's only; nothing aborted.
    expect(await until(() => signals.length > 0 && signals.every((s) => s.aborted))).toBe(true);
    const atAbort = upstreamCalls();
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamCalls()).toBe(atAbort);
    expect(atAbort).toBeLessThanOrEqual(5);
    expect(await until(() => upstreamSlotStats().active === 0)).toBe(true);
  });

  it("registerTool threads the SDK's per-call signal: notifications/cancelled aborts the tool's Loomio request", async () => {
    const signals = hangingLoomio();
    const server = createLoomioMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "http-hardening.test", version: "0" });
    await client.connect(clientSide);
    const ac = new AbortController();
    const pending = client
      .callTool({ name: "list_groups", arguments: {} }, undefined, { signal: ac.signal })
      .catch((e: Error) => e);
    expect(await until(() => signals.length === 1)).toBe(true);
    ac.abort("caller gave up");
    await pending;
    // v0.0.16 dropped `extra`: this signal never fired.
    expect(await until(() => signals[0]?.aborted === true, 1000)).toBe(true);
    await client.close();
    await server.close();
  });

  it("a call made after its signal fired is never sent", async () => {
    mockLoomio();
    const ac = new AbortController();
    ac.abort();
    await expect(
      withToolCallSignal(ac.signal, () => loomioGet("/b2/groups")),
    ).rejects.toBeInstanceOf(UpstreamCancelledError);
    expect(upstreamCalls()).toBe(0);
  });
});

// ── F-01 (c): process-wide concurrency ──────────────────────────────────────

describe("process-wide upstream concurrency (F-01 c)", () => {
  it("never has more than MCP_HTTP_UPSTREAM_CONCURRENCY Loomio requests in flight", async () => {
    process.env["MCP_HTTP_UPSTREAM_CONCURRENCY"] = "2";
    let inflight = 0;
    let peak = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return response(200, { groups: [] });
    });
    await Promise.all(Array.from({ length: 6 }, () => loomioGet("/b2/groups")));
    expect(upstreamCalls()).toBe(6);
    expect(peak).toBe(2); // v0.0.16: 6
  });

  it("bounds the wait queue (32 per slot): the overflow fails fast and is never sent", async () => {
    process.env["MCP_HTTP_UPSTREAM_CONCURRENCY"] = "1";
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    vi.mocked(fetch).mockImplementation(async () => {
      await gate;
      return response(200, { groups: [] });
    });
    const outcomes = Array.from({ length: 40 }, () =>
      loomioGet("/b2/groups").then(
        () => "ok",
        (e: unknown) => e,
      ),
    );
    expect(await until(() => upstreamSlotStats().waiting === 32)).toBe(true);
    open();
    const settled = await Promise.all(outcomes);
    expect(settled.filter((x) => x === "ok")).toHaveLength(33);
    const busy = settled.filter((x) => x instanceof UpstreamBusyError);
    expect(busy).toHaveLength(7);
    expect(upstreamCalls()).toBe(33);
    expect(upstreamSlotStats()).toEqual({ active: 0, waiting: 0 });
  });
});

// ── Round 1: fairness across sources, and a rate under Loomio's throttle ────

describe("the upstream queue is fair across sources (round 1)", () => {
  /** Calls to /b2/hold wait for `open()`; anything else answers at once. */
  function gatedLoomio() {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const order: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      order.push(path.slice(path.lastIndexOf("/") + 1));
      if (path.endsWith("/hold")) await gate;
      return response(200, {});
    });
    return { open: () => open(), order };
  }
  const as = <T>(sourceKey: string, fn: () => Promise<T>) => withRequestContext({ sourceKey }, fn);
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) => e,
    );

  it("one source cannot take every slot or the whole queue: a second source is served at once", async () => {
    // v0.0.17's first cut: one FIFO for everyone, so 40 calls from A made
    // B wait behind all of them (secreview sec2/t-starve.mjs: 26 s).
    process.env["MCP_HTTP_UPSTREAM_CONCURRENCY"] = "4";
    const { open } = gatedLoomio();
    const a = Array.from({ length: 40 }, () => settle(as("A", () => loomioGet("/b2/hold"))));
    // A holds 3 of 4 slots (a quarter is kept for others) and may queue
    // 8 per slot = 32; its remaining 5 calls are refused, never sent.
    expect(await until(() => upstreamSlotStats().waiting === 32)).toBe(true);
    expect(upstreamSlotStats().active).toBe(3);
    const b = await settle(as("B", () => loomioGet("/b2/now")));
    expect(b).toBe("ok");
    open();
    const outcomes = await Promise.all(a);
    expect(outcomes.filter((x) => x === "ok")).toHaveLength(35);
    expect(outcomes.filter((x) => x instanceof UpstreamBusyError)).toHaveLength(5);
    expect(upstreamSlotStats()).toEqual({ active: 0, waiting: 0 });
  });

  it("waiters are served round-robin across sources, FIFO within one", async () => {
    process.env["MCP_HTTP_UPSTREAM_CONCURRENCY"] = "1";
    const { open, order } = gatedLoomio();
    const first = settle(as("A", () => loomioGet("/b2/hold")));
    expect(await until(() => upstreamSlotStats().active === 1)).toBe(true);
    const queued = [
      settle(as("A", () => loomioGet("/b2/a1"))),
      settle(as("A", () => loomioGet("/b2/a2"))),
      settle(as("B", () => loomioGet("/b2/b1"))),
      settle(as("A", () => loomioGet("/b2/a3"))),
      settle(as("B", () => loomioGet("/b2/b2"))),
    ];
    expect(await until(() => upstreamSlotStats().waiting === 5)).toBe(true);
    open();
    await Promise.all([first, ...queued]);
    expect(order).toEqual(["hold", "a1", "b1", "a2", "b2", "a3"]);
  });
});

describe("the upstream rate stays under Loomio's per-address throttle (round 1)", () => {
  it("at most MCP_HTTP_UPSTREAM_PER_5MIN calls per 5 minutes, half of them per source; refused calls are never sent", async () => {
    process.env["MCP_HTTP_UPSTREAM_PER_5MIN"] = "10";
    mockLoomio();
    const as = (sourceKey: string) =>
      withRequestContext({ sourceKey }, () => loomioGet("/b2/groups")).then(
        () => "ok",
        (e: unknown) => e,
      );
    const a: unknown[] = [];
    for (let n = 0; n < 6; n++) a.push(await as("A"));
    expect(a.slice(0, 5)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(a[5]).toBeInstanceOf(UpstreamRateError);
    expect(String((a[5] as Error).message)).toMatch(/its share \(5\).*MCP_HTTP_UPSTREAM_PER_5MIN/);
    for (let n = 0; n < 5; n++) expect(await as(`B${n}`)).toBe("ok");
    const c = await as("C");
    expect(c).toBeInstanceOf(UpstreamRateError);
    expect((c as Error).message).toMatch(/limit of 10 Loomio calls in the last 5 minutes/);
    expect(upstreamCalls()).toBe(10);
    // The health probe is counted but never refused …
    const { checkLoomioHealth } = await import("../src/loomio/health.js");
    expect((await checkLoomioHealth({ force: true })).key_status).toBe("valid");
    expect(upstreamCalls()).toBe(12);
    expect(upstreamRateStats().inWindow).toBe(12);
    // … and stdio (no request context) is not a shared service: no window.
    await expect(loomioGet("/b2/groups")).resolves.toBeDefined();
  });

  it("over HTTP: one source's POSTs inside every other limit cannot exceed the window (the sec2/t-throttle repro)", async () => {
    mockLoomio();
    process.env["MCP_HTTP_UPSTREAM_PER_5MIN"] = "40";
    const i = await start();
    const results: Array<{ isError: boolean; text: string }> = [];
    for (let n = 0; n < 12; n++) {
      const r = await postMcp(i, gua(n, 4), { headers: { "mcp-protocol-version": "2025-06-18" } });
      results.push(toolResult(r.messages[0] as Record<string, unknown>));
    }
    // 5 upstream calls per get_user_activity(4 groups); the source's half
    // (20) admits four whole calls; the rest are refused, never sent.
    expect(upstreamCalls()).toBe(20);
    expect(results.filter((x) => !x.isError)).toHaveLength(4);
    expect(results.at(-1)?.text).toMatch(/MCP_HTTP_UPSTREAM_PER_5MIN/);
  });
});

// ── nit 5: limiter before the bearer check ──────────────────────────────────

describe("/mcp rate limit runs before authentication (nit 5)", () => {
  it("meters unauthenticated requests: the 4th 401-bound POST at a limit of 3 is 429", async () => {
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "3";
    const i = await start();
    const statuses: number[] = [];
    for (let n = 0; n < 4; n++) {
      statuses.push(
        (await postMcp(i, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: null })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429]); // v0.0.16: four 401s
  });
});

// ── F-06 / nit 7: JSON errors, nothing attacker-controlled in the logs ──────

describe("terminal error handling (F-06, nit 7)", () => {
  const MARKER = "F06-INJECTED-MARKER";
  const logged = () => [...stderr, ...consoleErrors].join("\n");

  it("a malformed /register body gets a fixed JSON 400 and writes nothing to the logs — NODE_ENV unset", async () => {
    delete process.env["NODE_ENV"];
    const i = await start();
    const r = await globalThis.fetch(`${i.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{bad\n${MARKER} line two\n${MARKER} line three`,
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: "bad_request" });
    // nit 7: no HTML page, parser message or stack trace in the reply…
    expect(text).not.toMatch(/SyntaxError|<pre>|node_modules|\bat /);
    // …and F-06: nothing in stderr — v0.0.16 dumped the body and absolute paths.
    expect(logged()).not.toContain(MARKER);
    expect(logged()).not.toContain("node_modules");
  });

  it("malformed /register bodies are counted: the 21st from one address is 429", async () => {
    const i = await start();
    const statuses: number[] = [];
    for (let n = 0; n < 21; n++) {
      const r = await globalThis.fetch(`${i.base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429); // v0.0.16: never — a parse error skipped the SDK's limiter
  });

  it("maps body-parser's 413 and 415 to fixed codes, quoting nothing", async () => {
    const i = await start();
    const many = new URLSearchParams();
    for (let n = 0; n < 1001; n++) many.set(`${MARKER}${n}`, "x");
    const tooMany = await globalThis.fetch(`${i.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: many,
    });
    expect(tooMany.status).toBe(413);
    expect(await tooMany.json()).toEqual({ error: "payload_too_large" });

    const charset = await postMcp(
      i,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        headers: { "content-type": "application/json; charset=iso-8859-1" },
      },
    );
    expect(charset.status).toBe(415);
    expect(JSON.parse(charset.text)).toEqual({ error: "unsupported_media_type" });
    expect(logged()).not.toContain(MARKER);
  });

  it("a 5xx logs the error class and status only, never its message", () => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      headersSent: false,
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };
    terminalErrorHandler(
      new TypeError(`boom ${MARKER}`),
      {} as express.Request,
      res as unknown as express.Response,
      () => {},
    );
    expect(sent).toEqual({ status: 500, body: { error: "internal_error" } });
    expect(consoleErrors).toEqual(["[loomiomcp] http error: TypeError 500"]);
  });
});

// ── F-12: trust proxy and limiter keys ──────────────────────────────────────

describe("client address for the limiters (F-12)", () => {
  const health = (i: Instance, xff: string) =>
    globalThis
      .fetch(`${i.base}/health`, { headers: { "x-forwarded-for": xff } })
      .then(async (r) => {
        await r.arrayBuffer();
        return r.status;
      });

  it("by default X-Forwarded-For is ignored: a spoofed header cannot buy a fresh bucket", async () => {
    mockLoomio();
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "2";
    const i = await start();
    const statuses = [];
    for (const n of [1, 2, 3]) statuses.push(await health(i, `203.0.113.${n}`));
    expect(statuses).toEqual([200, 200, 429]); // v0.0.16 (trust proxy 1): 200 × 3
  });

  it("behind a trusted proxy, a value that is not an address falls back to the TCP peer", async () => {
    mockLoomio();
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "2";
    const i = await start({ trustProxy: 1 });
    const junk = [];
    for (const n of [1, 2, 3]) junk.push(await health(i, `definitely-not-an-ip-${n}`));
    expect(junk).toEqual([200, 200, 429]); // v0.0.16: each junk value its own bucket
    // A real appended address still keys its own bucket (the Cloud Run contract).
    expect(await health(i, "198.51.100.7")).toBe(200);
  });

  it("the OAuth routes key on the same rule — junk X-Forwarded-For values share one bucket and are never logged", async () => {
    const i = await start({ trustProxy: 1 });
    const statuses: number[] = [];
    for (let n = 0; n < 21; n++) {
      const r = await globalThis.fetch(`${i.base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `F12-JUNK-${n}` },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"] }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    // The SDK's own limiter (now off) keyed on req.ip verbatim and its IP
    // validation echoed the first junk value to stderr.
    expect([...consoleErrors, ...stderr].join("\n")).not.toContain("F12-JUNK");
  });

  it("clientIpKey: req.ip when it is an address, else the socket peer", () => {
    const req = (ip: string | undefined, peer: string) =>
      ({ ip, socket: { remoteAddress: peer } }) as unknown as express.Request;
    expect(clientIpKey(req("203.0.113.5", "10.0.0.1"))).toBe("203.0.113.5");
    expect(clientIpKey(req("x".repeat(15_000), "10.0.0.1"))).toBe("10.0.0.1");
    expect(clientIpKey(req(undefined, "10.0.0.2"))).toBe("10.0.0.2");
  });
});

// ── F-13: client ids in logs ────────────────────────────────────────────────

describe("client ids are logged as digests (F-13)", () => {
  it("tool.call and tool.chain carry a 16-character tag, never the registrant's blob", async () => {
    mockLoomio();
    process.env["LOOMIO_MCP_LOG_VERBOSE"] = "1";
    const i = await start();
    const blob = `client-${"N".repeat(5000)}`;
    const r = await postMcp(i, call(1, "list_groups"), { token: accessToken(i.issuer, blob) });
    expect(toolResult(r.messages[0] as Record<string, unknown>).isError).toBe(false);
    const events = stderr
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const withClient = events.filter(
      (e) => e["event"] === "tool.call" || e["event"] === "tool.chain",
    );
    expect(withClient.map((e) => e["event"]).sort()).toEqual(["tool.call", "tool.chain"]);
    for (const e of withClient) {
      expect(e["clientId"]).toBe(clientIdTag(blob));
      expect(e["clientId"]).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
    expect(stderr.join("")).not.toContain("NNNNNNNNNNNNNNNN"); // v0.0.16: the whole blob, twice
  });
});

// ── F-14: body cap and server timeouts ──────────────────────────────────────

describe("body cap and receive deadlines (F-14)", () => {
  const bigCall = () => call(1, "search_content", { query: "q".repeat(300 * 1024) });

  it("caps a /mcp body at 256 KB by default (v0.0.16: 1 MB)", async () => {
    const i = await start();
    const r = await postMcp(i, bigCall());
    expect(r.status).toBe(413);
    // JSON-RPC shape (round 2): a client shows the reason instead of a
    // bare transport failure; nothing the caller sent is quoted.
    expect(JSON.parse(r.text)).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message:
          "Request body over MCP_HTTP_JSON_LIMIT (262144 bytes): shorten the text or split it across calls.",
      },
      id: null,
    });
    expect(upstreamCalls()).toBe(0);
  });

  it("a 100 000-character CJK body (~300 KB, schema-valid) needs MCP_HTTP_JSON_LIMIT=1mb; ASCII fits the default", async () => {
    const ping = (pad: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { _meta: { pad } },
    });
    const byDefault = await start();
    expect((await postMcp(byDefault, ping("a".repeat(100_000)))).status).toBe(200);
    expect((await postMcp(byDefault, ping("\u8b70".repeat(100_000)))).status).toBe(413);
    const raised = await start({ jsonLimit: "1mb" });
    expect((await postMcp(raised, ping("\u8b70".repeat(100_000)))).status).toBe(200);
  });

  it("hands the SDK transport the same cap for a body it reads itself (its own default is 4 MB)", async () => {
    // Mounted bare — no express.json in front — so the SDK reads the body.
    const app = (await import("express")).default();
    app.post("/mcp", async (req, res) => {
      const server = createLoomioMcpServer();
      const transport = createMcpTransport(1024);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const r = await globalThis.fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(call(1, "search_content", { query: "q".repeat(2048) })),
        },
      );
      expect(r.status).toBe(413);
      expect(await r.text()).toMatch(/must not exceed 1024 bytes/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("createHttpServer bounds receiving a request: 30 s whole, 10 s for the headers, swept every 5 s", () => {
    const server = createHttpServer(createApp(appOptions()));
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect([REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, CONNECTIONS_CHECK_INTERVAL_MS]).toEqual([
      30_000, 10_000, 5_000,
    ]);
    // Node refuses a headersTimeout above requestTimeout.
    expect(HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  it("cuts a trickled body at the request deadline (v0.0.16: open until Node's 300 s)", async () => {
    const app = createApp(appOptions());
    const server = createHttpServer(app, {
      requestTimeoutMs: 400,
      headersTimeoutMs: 400,
      checkIntervalMs: 50,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const startedAt = Date.now();
      const reply = await new Promise<string>((resolve) => {
        let got = "";
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" +
              `Authorization: Bearer ${accessToken(new URL("http://127.0.0.1/"))}\r\n` +
              "Accept: application/json, text/event-stream\r\n" +
              'Content-Length: 400\r\n\r\n{"jsonrpc":"2.0",',
          );
        });
        sock.on("data", (d) => {
          got += d.toString();
        });
        sock.on("close", () => resolve(got));
        sock.on("error", () => resolve(got));
      });
      expect(reply).toMatch(/^HTTP\/1\.1 408/);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── F-16: daily quotas (open DCR only) ──────────────────────────────────────

describe("daily per-source quotas (F-16)", () => {
  const inSource = <T>(fn: () => T) =>
    withRequestContext({ quotaKey: "203.0.113.9" }, async () => fn());

  it("refuses the call after MCP_DAILY_TOOL_CALLS, before it runs", async () => {
    process.env["MCP_DAILY_TOOL_CALLS"] = "2";
    await inSource(() => {
      chargeDailyToolCall();
      chargeDailyToolCall();
      expect(() => chargeDailyToolCall()).toThrow(DailyQuotaError);
      expect(() => chargeDailyToolCall()).toThrow(/MCP_DAILY_TOOL_CALLS.*00:00 UTC/);
    });
  });

  it("refuses once MCP_DAILY_RESULT_BYTES were delivered; 0 disables either quota", async () => {
    process.env["MCP_DAILY_RESULT_BYTES"] = "100";
    await inSource(() => {
      chargeDailyToolCall();
      recordDailyResultBytes(150);
      expect(() => chargeDailyToolCall()).toThrow(/result bytes/);
    });
    resetDailyQuotasForTests();
    process.env["MCP_DAILY_TOOL_CALLS"] = "0";
    process.env["MCP_DAILY_RESULT_BYTES"] = "0";
    await inSource(() => {
      for (let n = 0; n < 10_000; n++) chargeDailyToolCall();
      recordDailyResultBytes(10 ** 12);
      expect(() => chargeDailyToolCall()).not.toThrow();
    });
  });

  it("resets at 00:00 UTC and is a no-op without a source key (stdio, static-client)", async () => {
    process.env["MCP_DAILY_TOOL_CALLS"] = "1";
    const lateDay1 = Date.parse("2026-10-25T23:59:59Z");
    const day2 = Date.parse("2026-10-26T00:00:01Z");
    await inSource(() => {
      chargeDailyToolCall(lateDay1);
      expect(() => chargeDailyToolCall(lateDay1)).toThrow(DailyQuotaError);
      expect(() => chargeDailyToolCall(day2)).not.toThrow();
    });
    await withRequestContext({}, async () => {
      for (let n = 0; n < 5; n++) chargeDailyToolCall();
    });
  });

  it("applies over HTTP in open-DCR mode only", async () => {
    mockLoomio();
    process.env["MCP_DAILY_TOOL_CALLS"] = "2";
    const i = await start();
    const run = async () =>
      toolResult((await postMcp(i, call(1, "list_groups"))).messages[0] as Record<string, unknown>);

    // Static-client (and v0.0.16): no daily quota.
    for (let n = 0; n < 3; n++) expect((await run()).isError).toBe(false);

    setOpenDcrMode(true);
    expect((await run()).isError).toBe(false);
    expect((await run()).isError).toBe(false);
    const third = await run();
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/today's quota of 2 tool calls/);
  });

  it("charges delivered result bytes over HTTP: the call after the byte quota is spent is refused (round 1)", async () => {
    // Before this case only recordDailyResultBytes was unit-tested;
    // deleting the call in registerTool's reply path left the suite green.
    mockLoomio();
    const i = await start();
    const run = async () =>
      toolResult((await postMcp(i, call(1, "list_groups"))).messages[0] as Record<string, unknown>);

    // Static-client: replies are not counted, whatever the quota.
    process.env["MCP_DAILY_RESULT_BYTES"] = "1";
    const first = await run();
    expect(first.isError).toBe(false);
    for (let n = 0; n < 3; n++) expect((await run()).isError).toBe(false);

    // Open DCR: a quota of 1.5 replies admits two calls (the second is
    // allowed because only one reply was delivered when it started).
    const reply = Buffer.byteLength(first.text, "utf8");
    process.env["MCP_DAILY_RESULT_BYTES"] = String(Math.floor(reply * 1.5));
    setOpenDcrMode(true);
    expect((await run()).isError).toBe(false);
    expect((await run()).isError).toBe(false);
    const third = await run();
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/today's quota of \d+ result bytes/);
    expect(third.text).toMatch(/MCP_DAILY_RESULT_BYTES/);
  });
});

// ── Round 2: shared egress addresses (hosted Claude) ────────────────────────

describe("shared egress ranges: per-client keys under an address aggregate (round 2)", () => {
  const egress = (raw: string): SharedEgress => {
    const r = parseSharedEgressCidrs(raw);
    if (!("ok" in r) || !r.ok) throw new Error("expected a range");
    return r.ok;
  };

  it("parses CIDRs (v4, v6, v4-mapped peers) and refuses anything else", () => {
    const e = egress(" 192.0.2.0/24 , 2001:db8::/32 ");
    expect(e.contains("192.0.2.77")).toBe(true);
    expect(e.contains("::ffff:192.0.2.77")).toBe(true);
    expect(e.contains("192.0.3.1")).toBe(false);
    expect(e.contains("2001:db8:1::5")).toBe(true);
    expect(e.contains("not-an-ip")).toBe(false);
    expect(parseSharedEgressCidrs("")).toEqual({ ok: undefined });
    for (const bad of ["192.0.2.0", "192.0.2.0/33", "2001:db8::/129", "host/24", "1.2.3.4/x"]) {
      expect(parseSharedEgressCidrs(bad), bad).toHaveProperty("error");
    }
  });

  it("daily quota: each client behind the address has its own; the address as a whole 20×", async () => {
    process.env["MCP_DAILY_TOOL_CALLS"] = "2";
    const as = (client: string) => (fn: () => void) =>
      withRequestContext(
        { quotaKey: `198.51.100.1|${client}`, sharedEgressKey: "198.51.100.1" },
        async () => fn(),
      );
    await as("c0")(() => {
      chargeDailyToolCall();
      chargeDailyToolCall();
      expect(() => chargeDailyToolCall()).toThrow(/This client \(behind a shared egress address\)/);
    });
    // Another client of the SAME address is not locked out (v0.0.17 round 1: it was).
    for (let n = 1; n < SHARED_EGRESS_DAILY_FACTOR; n++) {
      await as(`c${n}`)(() => {
        chargeDailyToolCall();
        chargeDailyToolCall();
      });
    }
    // 20 clients × 2 = the address's aggregate: the 21st client is refused.
    await as("late")(() => {
      expect(() => chargeDailyToolCall()).toThrow(
        /shared egress address, all its clients together, has used today's quota of 40 tool calls/,
      );
    });
  });

  it("upstream share: a quarter of the address's half per client, the half for the address", async () => {
    process.env["MCP_HTTP_UPSTREAM_PER_5MIN"] = "16"; // half = 8, per client = 2
    mockLoomio();
    const as = (client: string) =>
      withRequestContext({ sourceKey: `A|${client}`, sharedEgressKey: "A" }, () =>
        loomioGet("/b2/groups"),
      ).then(
        () => "ok",
        (e: unknown) => e,
      );
    expect([await as("c1"), await as("c1")]).toEqual(["ok", "ok"]);
    const third = await as("c1");
    expect(third).toBeInstanceOf(UpstreamRateError);
    expect((third as Error).message).toMatch(
      /This client \(behind a shared egress address\) has used its share \(2\)/,
    );
    for (const c of ["c2", "c3", "c4"]) expect([await as(c), await as(c)]).toEqual(["ok", "ok"]);
    const fifth = await as("c5");
    expect((fifth as Error).message).toMatch(/This source address has used its share \(8\)/);
    // Everyone else keeps the other half of the window.
    const other = await withRequestContext({ sourceKey: "B" }, () => loomioGet("/b2/groups"));
    expect(other).toBeDefined();
    expect(upstreamCalls()).toBe(9);
  });

  it("over HTTP, open DCR: one hosted client spending its quota no longer locks out another (the round-2 repro)", async () => {
    mockLoomio();
    process.env["MCP_DAILY_TOOL_CALLS"] = "2";
    setOpenDcrMode(true);
    const run = async (i: Instance, client: string) =>
      toolResult(
        (await postMcp(i, call(1, "list_groups"), { token: accessToken(i.issuer, client) }))
          .messages[0] as Record<string, unknown>,
      );
    // Without the knob: one bucket per address, as in round 1.
    const plain = await start();
    for (let n = 0; n < 2; n++) expect((await run(plain, "attacker")).isError).toBe(false);
    expect((await run(plain, "victim")).text).toMatch(/This source address has used today's quota/);

    resetDailyQuotasForTests();
    const shared = await start({ sharedEgress: egress("127.0.0.0/8") });
    for (let n = 0; n < 2; n++) expect((await run(shared, "attacker")).isError).toBe(false);
    expect((await run(shared, "attacker")).text).toMatch(/This client \(behind a shared egress/);
    expect((await run(shared, "victim")).isError).toBe(false);
  });
});

// ── nit 6: headers, JSON 404/405, CORS ──────────────────────────────────────

describe("HTTP hygiene (nit 6)", () => {
  it("sends no framework fingerprint, and nosniff + no-referrer on every response; HSTS only for an https issuer", async () => {
    const plain = await start();
    const r = await globalThis.fetch(`${plain.base}/icon.svg`);
    await r.arrayBuffer();
    expect(r.headers.get("x-powered-by")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("strict-transport-security")).toBeNull();

    const tls = await start({ issuer: "https://mcp.example.org/" });
    const s = await globalThis.fetch(`${tls.base}/icon.svg`);
    await s.arrayBuffer();
    expect(s.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("answers unknown routes with JSON 404 and other methods on /mcp with JSON 405", async () => {
    const i = await start();
    const missing = await globalThis.fetch(`${i.base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const put = await globalThis.fetch(`${i.base}/mcp`, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("POST");
    expect(((await put.json()) as { error: string }).error).toBe("method_not_allowed");
  });

  it("gives an allow-listed browser origin a real preflight and the grant on the POST — even on its 401", async () => {
    const i = await start();
    const pre = await globalThis.fetch(`${i.base}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, mcp-protocol-version",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(pre.headers.get("access-control-allow-methods")).toBe("POST");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/MCP-Protocol-Version/);
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    expect(pre.headers.get("vary")).toMatch(/Origin/);

    const unauth = await postMcp(
      i,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        token: null,
        headers: { origin: "https://claude.ai" },
      },
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(unauth.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/);
  });

  it("gives any other origin no CORS grant at all", async () => {
    const i = await start();
    const pre = await globalThis.fetch(`${i.base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const post = await postMcp(
      i,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        headers: { origin: "https://evil.example" },
      },
    );
    expect(post.status).toBe(403);
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
    // A non-browser client (no Origin) keeps working, with no CORS headers.
    const bare = await globalThis.fetch(`${i.base}/mcp`, { method: "OPTIONS" });
    expect(bare.status).toBe(204);
    expect(bare.headers.get("allow")).toBe("POST, OPTIONS");
    expect(bare.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not echo an unsupported MCP-Protocol-Version value", async () => {
    const i = await start();
    const r = await postMcp(
      i,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        headers: { "mcp-protocol-version": "1999-01-01<script>alert(1)</script>" },
      },
    );
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("<script>");
    expect(r.text).toMatch(/supported: /);
  });
});

// ── nit 21: MCP_HTTP_DEBUG output ───────────────────────────────────────────

describe("MCP_HTTP_DEBUG error line (nit 21)", () => {
  it("names class and status only by default; with debug, one scrubbed line of at most 200 message chars", () => {
    process.env["LOOMIO_API_KEY"] = "dummy-loomio-key-0123456789";
    const err = Object.assign(
      new Error(
        `upstream said:\r\n${"x".repeat(50)} dummy-loomio-key-0123456789 ${"y".repeat(900)}`,
      ),
      { status: 502 },
    );
    expect(mcpErrorLine(err, false)).toBe("[loomiomcp] /mcp error: Error 502");
    const line = mcpErrorLine(err, true);
    expect(line.startsWith("[loomiomcp] /mcp error: Error 502 — upstream said: ")).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain("dummy-loomio-key-0123456789");
    expect(line).toContain("[redacted]");
    expect(line.split(" — ")[1]?.length).toBeLessThanOrEqual(200); // v0.0.16: the whole message
  });
});
