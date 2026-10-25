/**
 * The OAuth surface over real HTTP: `createApp` on an ephemeral loopback
 * port, driven with Node's built-in fetch (no Loomio call is made — none of
 * these routes reaches the API). Unit tests in auth.test.ts pin the
 * provider; these pin what only the assembled Express stack shows — route
 * order, the SDK router's prefix mounts, the limiter's position, and that
 * the provider sees the real /authorize request. Each case FAILS against
 * v0.0.16 (see the finding id in its name) unless noted.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClientStore, OAuthProvider, StatelessClientsStore } from "../src/auth/provider.js";
import { createApp } from "../src/http/app.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CB = "http://127.0.0.1:9999/cb";

interface Instance {
  base: string;
  provider: OAuthProvider;
  server: ReturnType<express.Express["listen"]>;
}

const STATIC = { clientId: "static-client", clientSecret: "static-secret-0123456789" };

async function start(mode: "open-dcr" | "static" = "open-dcr"): Promise<Instance> {
  // Both instances advertise the same issuer (one service, N replicas).
  const issuerUrl = new URL("http://127.0.0.1/");
  const provider = new OAuthProvider({
    clientsStore:
      mode === "static"
        ? new FixedClientStore({ ...STATIC, redirectUris: [CB] })
        : new StatelessClientsStore(KEY),
    signingKey: KEY,
    resourceUrl: new URL("/mcp", issuerUrl),
    enableAuthCodeGc: false,
  });
  const app = createApp({
    oauthProvider: provider,
    issuerUrl,
    jsonLimit: "1mb",
    allowedOrigins: [],
  });
  const server = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, provider, server };
}

let instances: Instance[] = [];
beforeEach(() => {
  instances = [];
});
afterEach(async () => {
  for (const i of instances) {
    i.provider.shutdown();
    await new Promise<void>((resolve) => i.server.close(() => resolve()));
  }
});
async function instance(mode: "open-dcr" | "static" = "open-dcr"): Promise<Instance> {
  const i = await start(mode);
  instances.push(i);
  return i;
}

async function register(base: string, meta: Record<string, unknown>) {
  const r = await globalThis.fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(base: string, params: Record<string, string>) {
  const url = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await globalThis.fetch(url, { redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}

async function codeFor(base: string, clientId: string, challenge: string, withRedirect = true) {
  const r = await authorize(base, {
    client_id: clientId,
    ...(withRedirect ? { redirect_uri: CB } : {}),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  expect(r.status).toBe(302);
  return new URL(r.location!).searchParams.get("code")!;
}

async function token(base: string, form: Record<string, string>, path = "/token") {
  const r = await globalThis.fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 80) };
  }
  return { status: r.status, body };
}

describe("/token guard chain (F-11)", () => {
  it("answers 404 for every /token sub-path — the SDK's client authentication is never reachable there", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    for (const path of ["/token/x", "/token/a/b/c", "/TOKEN/x"]) {
      const r = await token(
        base,
        {
          grant_type: "authorization_code",
          code: "x",
          code_verifier: "y",
          client_id: reg.body.client_id!,
          client_secret: "WRONG",
        },
        path,
      );
      expect({ path, status: r.status, body: r.body }).toEqual({
        path,
        status: 404,
        body: { error: "not_found" },
      });
    }
    // The canonical path and its trivially-equivalent spellings keep the pre-check.
    for (const path of ["/token", "/token/", "/token?x=1"]) {
      const r = await token(
        base,
        {
          grant_type: "authorization_code",
          code: "x",
          code_verifier: "y",
          client_id: reg.body.client_id!,
          client_secret: "WRONG",
        },
        path,
      );
      expect(r.status, path).toBe(401);
    }
  });

  it("counts failed client authentications: the 51st attempt from one address is 429", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    const statuses: number[] = [];
    for (let i = 0; i < 52; i++) {
      const r = await token(base, {
        grant_type: "authorization_code",
        code: "x",
        code_verifier: "y",
        client_id: reg.body.client_id!,
        client_secret: "WRONG",
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 50).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(50)).toEqual([429, 429]);
  });

  it("burns a code presented with a wrong client secret (nit 17)", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    const { verifier, challenge } = pkce();
    const code = await codeFor(base, reg.body.client_id!, challenge);
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CB,
      client_id: reg.body.client_id!,
    };
    expect((await token(base, { ...form, client_secret: "WRONG" })).status).toBe(401);
    const retry = await token(base, { ...form, client_secret: reg.body.client_secret! });
    expect(retry).toEqual({
      status: 400,
      body: { error: "invalid_grant", error_description: "invalid authorization code" },
    });
  });

  it("burns a code the SDK refuses before the provider sees it — missing verifier, malformed resource (nit 17)", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    const creds = { client_id: reg.body.client_id!, client_secret: reg.body.client_secret! };
    for (const broken of [{ code_verifier: undefined }, { resource: "not a url" }]) {
      const { verifier, challenge } = pkce();
      const code = await codeFor(base, reg.body.client_id!, challenge);
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CB,
        ...creds,
      };
      for (const [k, v] of Object.entries(broken)) {
        if (v === undefined) delete form[k];
        else form[k] = v;
      }
      const refused = await token(base, form);
      expect(refused.status, JSON.stringify(broken)).toBe(400);
      expect(refused.body["error"]).toBe("invalid_request");
      // v0.0.16: 200 — the code outlived the failed attempt.
      const retry = await token(base, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CB,
        ...creds,
      });
      expect(retry, JSON.stringify(broken)).toEqual({
        status: 400,
        body: { error: "invalid_grant", error_description: "invalid authorization code" },
      });
    }
  });

  it("does not charge CORS preflights against the /token budget", async () => {
    const { base } = await instance();
    for (let i = 0; i < 55; i++) {
      const r = await globalThis.fetch(`${base}/token`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
      });
      expect(r.status).toBe(204);
    }
    const r = await token(base, { grant_type: "authorization_code", client_id: "x" });
    expect(r.status).toBe(401);
  });

  it("static-client mode, where the secret IS the boundary: no sub-path oracle, guessing is throttled", async () => {
    const { base } = await instance("static");
    const guess = { grant_type: "refresh_token", refresh_token: "x", client_id: STATIC.clientId };
    // v0.0.16: 400 "Invalid client_secret" / "Client secret is required" / "Invalid client_id".
    for (const form of [
      { ...guess, client_secret: "WRONG" },
      guess,
      { ...guess, client_id: "nope", client_secret: "WRONG" },
    ]) {
      expect((await token(base, form, "/token/x")).status).toBe(404);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      statuses.push((await token(base, { ...guess, client_secret: `WRONG-${i}` })).status);
    }
    // 3 sub-path probes + 47 guesses fit the 50 budget; v0.0.16 never answered 429 here.
    expect(statuses.filter((s) => s === 401)).toHaveLength(47);
    expect(statuses.slice(47)).toEqual([429, 429, 429]);
    // The right secret is past the pre-check (the bogus refresh token is what fails).
    const { base: fresh } = await instance("static");
    const right = await token(fresh, { ...guess, client_secret: STATIC.clientSecret });
    expect(right.body["error"]).toBe("invalid_grant");
  });
});

describe("open redirect (F-09) and registration caps (F-13)", () => {
  it("refuses to register an arbitrary https redirect_uri or an oversized client_name", async () => {
    const { base } = await instance();
    for (const meta of [
      { redirect_uris: ["https://evil.example/phish?x=1"] },
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["file:///etc/passwd"] },
      { redirect_uris: [CB], client_name: "N".repeat(3000) },
    ]) {
      const r = await register(base, meta);
      expect(r.status, JSON.stringify(meta).slice(0, 60)).toBe(400);
      expect(r.body.error).toBe("invalid_client_metadata");
    }
  });

  it("will not redirect for a v0.0.16-signed client_id registered to an evil host — 400, no Location", async () => {
    const { base } = await instance();
    const payload = Buffer.from(
      JSON.stringify({
        k: "client",
        redirect_uris: ["https://evil.example/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        iat: Math.floor(Date.now() / 1000),
      }),
    ).toString("base64url");
    const legacyEvil = `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;
    for (const params of [
      {
        client_id: legacyEvil,
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      },
      { client_id: legacyEvil }, // the phase-2 error path used to bounce too
    ]) {
      const r = await authorize(base, params);
      expect(r.status).toBe(400);
      expect(r.location).toBeNull();
      expect(JSON.parse(r.text).error).toBe("invalid_client");
    }
  });
});

describe("/authorize throttle (F-06; round 1)", () => {
  // v0.0.17 switches the SDK's own /authorize limiter off, so the
  // connector's per-IP limiter is the ONLY one; replacing it with a
  // pass-through left every test green before this case.
  it("the 101st request from one address in 15 min is 429 — malformed bodies (parse errors) counted too", async () => {
    const { base } = await instance();
    const statuses: number[] = [];
    for (let n = 0; n < 101; n++) {
      if (n % 2 === 0) {
        statuses.push((await authorize(base, { client_id: "nope" })).status);
      } else {
        // An unsupported charset makes the SDK's body parser throw before
        // its handler; F-06 requires the limiter to have counted it already.
        const r = await globalThis.fetch(`${base}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded; charset=x-bogus" },
          body: "client_id=nope",
          redirect: "manual",
        });
        await r.text();
        statuses.push(r.status);
      }
    }
    expect(statuses.slice(0, 100).includes(429)).toBe(false);
    expect(statuses[100]).toBe(429);
  });
});

describe("MCP_HTTP_RATE_LIMIT_DISABLED (round 1)", () => {
  afterEach(() => {
    delete process.env["MCP_HTTP_RATE_LIMIT_DISABLED"];
    delete process.env["MCP_HTTP_RATE_LIMIT_MAX"];
  });

  it("switches off the /mcp limiter only: /register keeps its 20-per-hour limit, as in v0.0.16", async () => {
    process.env["MCP_HTTP_RATE_LIMIT_DISABLED"] = "1";
    process.env["MCP_HTTP_RATE_LIMIT_MAX"] = "3";
    const { base } = await instance();
    const mcp: number[] = [];
    for (let n = 0; n < 6; n++) {
      const r = await globalThis.fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await r.text();
      mcp.push(r.status);
    }
    expect(mcp.includes(429)).toBe(false);
    const reg: number[] = [];
    for (let n = 0; n < 21; n++) reg.push((await register(base, { redirect_uris: [CB] })).status);
    expect(reg.slice(0, 20).every((st) => st === 201)).toBe(true);
    expect(reg[20]).toBe(429);
  });
});

describe("authorization codes over HTTP", () => {
  it("refuses an oversized code_challenge with an error redirect and no code (F-05)", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    const r = await authorize(base, {
      client_id: reg.body.client_id!,
      response_type: "code",
      code_challenge: "A".repeat(4000),
      code_challenge_method: "S256",
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.location!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("a code from instance A is exchanged on instance B (§6), and only once there", async () => {
    const a = await instance();
    const b = await instance();
    const reg = await register(a.base, { redirect_uris: [CB] });
    const { verifier, challenge } = pkce();
    const code = await codeFor(a.base, reg.body.client_id!, challenge);
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CB,
      client_id: reg.body.client_id!,
      client_secret: reg.body.client_secret!,
    };
    const first = await token(b.base, form);
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_token",
      "token_type",
    ]);
    expect((await token(b.base, form)).status).toBe(400);
  });

  it("requires redirect_uri at /token only when /authorize carried it (nit 4; the omitted case also passed on v0.0.16)", async () => {
    const { base } = await instance();
    const reg = await register(base, { redirect_uris: [CB] });
    const omitted = pkce();
    const omittedCode = await codeFor(base, reg.body.client_id!, omitted.challenge, false);
    const ok = await token(base, {
      grant_type: "authorization_code",
      code: omittedCode,
      code_verifier: omitted.verifier,
      client_id: reg.body.client_id!,
      client_secret: reg.body.client_secret!,
    });
    expect(ok.status).toBe(200);

    const sent = pkce();
    const sentCode = await codeFor(base, reg.body.client_id!, sent.challenge, true);
    const refused = await token(base, {
      grant_type: "authorization_code",
      code: sentCode,
      code_verifier: sent.verifier,
      client_id: reg.body.client_id!,
      client_secret: reg.body.client_secret!,
    });
    expect(refused).toEqual({
      status: 400,
      body: { error: "invalid_grant", error_description: "invalid authorization code" },
    });
  });
});
