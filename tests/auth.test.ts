/**
 * OAuth core (src/auth/token.ts, src/auth/provider.ts) — v0.0.17 hardening
 * from the 2026-10-25 security review, plus the compatibility promise that
 * came with it: artefacts v0.0.16 issued keep working until the legacy
 * sunset, so the release forces nobody to re-authenticate.
 *
 *   - nit 2:  HKDF sub-keys per artefact kind + "v2." tag + strict schemas
 *             (a blob of one kind never verifies as another).
 *   - §6:     authorization codes are signed blobs — /token on another
 *             instance works; single use per instance.
 *   - F-05:   S256 challenge shape, verifier 43–128 unreserved chars.
 *   - nit 4:  redirect_uri required at /token when the auth request sent
 *             one; one generic invalid_grant text.
 *   - nit 17: every failed exchange burns the code.
 *   - nit 1:  90-day refresh-chain horizon (orig_iat).
 *   - F-09 / F-13 / nit 22: registration caps and redirect policy in the
 *             open-DCR stores (policy unit tests: redirect-policy.test.ts).
 *
 * HTTP-level wiring (route order, limiter, 404s) is in oauth-http.test.ts.
 */

import { createHash, createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixedClientStore,
  InMemoryClientsStore,
  OAuthProvider,
  StatelessClientsStore,
} from "../src/auth/provider.js";
import {
  issueToken,
  LEGACY_ACCEPT_UNTIL_MS,
  MIN_SIGNING_KEY_CHARS,
  type SignedTokenClaims,
  SigningKeys,
  signBlob,
  TokenExpiredError,
  TokenSignatureError,
  verifyToken,
} from "../src/auth/token.js";
import { V0016 } from "./oauth-legacy-fixtures.js";

const KEY = "0123456789abcdef0123456789abcdef";
const KEYS = new SigningKeys(KEY);
const CB = "http://127.0.0.1:9999/cb";
const RESOURCE = "https://mcp.example.org/mcp";
const DAY = 24 * 60 * 60 * 1000;

const PKCE_VERIFIER = "test-verifier-1234567890abcdefghijklmnopqrstuv";
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

type RegArg = Parameters<StatelessClientsStore["registerClient"]>[0];
type AuthParams = Parameters<OAuthProvider["authorize"]>[1];

afterEach(() => {
  vi.useRealTimers();
});

/** v0.0.16's exact construction: b64url(JSON).b64url(HMAC-SHA256(raw key, payload)). */
function legacyMint(claims: object, key: string = KEY): string {
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${p}.${createHmac("sha256", key).update(p).digest("base64url")}`;
}

function provider(
  opts: { store?: StatelessClientsStore; key?: string; resource?: string | null } = {},
) {
  const key = opts.key ?? KEY;
  const store = opts.store ?? new StatelessClientsStore(key);
  const p = new OAuthProvider({
    clientsStore: store,
    signingKey: key,
    ...(opts.resource === null ? {} : { resourceUrl: opts.resource ?? RESOURCE }),
    enableAuthCodeGc: false,
  });
  return { p, store };
}

/**
 * Run authorize() and return the code. `query` simulates the /authorize
 * request the SDK handed over (res.req); undefined → no request attached.
 */
async function authorizeCode(
  p: OAuthProvider,
  client: ReturnType<StatelessClientsStore["registerClient"]>,
  over: Partial<AuthParams> = {},
  query?: Record<string, string>,
): Promise<string> {
  let redirected: string | undefined;
  const res = {
    redirect(url: string) {
      redirected = url;
    },
    ...(query ? { req: { method: "GET", query } as unknown as Request } : {}),
  } as unknown as Response;
  await p.authorize(
    client,
    { codeChallenge: PKCE_CHALLENGE, redirectUri: CB, scopes: [], ...over } as AuthParams,
    res,
  );
  return new URL(redirected!).searchParams.get("code")!;
}

function decode(blob: string): Record<string, unknown> {
  const payload = blob.startsWith("v2.") ? blob.split(".")[1]! : blob.split(".")[0]!;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function accessClaims(over: Partial<SignedTokenClaims> = {}): SignedTokenClaims {
  return {
    type: "access",
    clientId: "abc",
    scopes: [],
    iat: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: "n".repeat(22),
    ...over,
  } as SignedTokenClaims;
}

describe("signed tokens (token.ts)", () => {
  it("round-trips v2 claims under the type's own sub-key", () => {
    const tok = issueToken(accessClaims({ scopes: ["read"] }), KEYS);
    expect(tok.startsWith("v2.")).toBe(true);
    const back = verifyToken(tok, KEYS, "access");
    expect(back.legacy).toBe(false);
    expect(back.claims.clientId).toBe("abc");
    expect(back.claims.scopes).toEqual(["read"]);
  });

  it("rejects a modified payload, an expired token and a different key", () => {
    const tok = issueToken(accessClaims(), KEYS);
    const [tag, body, sig] = tok.split(".") as [string, string, string];
    expect(() => verifyToken(`${tag}.${body.slice(0, -2)}AB.${sig}`, KEYS, "access")).toThrow(
      TokenSignatureError,
    );
    expect(() =>
      verifyToken(issueToken(accessClaims({ expiresAt: Date.now() - 1 }), KEYS), KEYS, "access"),
    ).toThrow(TokenExpiredError);
    expect(() => verifyToken(tok, new SigningKeys(`${KEY}-other`), "access")).toThrow(
      TokenSignatureError,
    );
  });

  it("domain separation (nit 2): an artefact of one kind fails the SIGNATURE check as any other", () => {
    const access = issueToken(accessClaims(), KEYS);
    expect(() => verifyToken(access, KEYS, "refresh")).toThrow(TokenSignatureError);
    // A blob MACed under the access sub-key but claiming to be a refresh token.
    const lying = signBlob(KEYS, "access", { ...accessClaims(), type: "refresh", orig_iat: 1 });
    expect(() => verifyToken(lying, KEYS, "refresh")).toThrow(TokenSignatureError);
    expect(() => verifyToken(lying, KEYS, "access")).toThrow(TokenSignatureError);
    // Client and code blobs carrying a token's claims are still not tokens.
    for (const kind of ["client", "code"] as const) {
      expect(() => verifyToken(signBlob(KEYS, kind, accessClaims()), KEYS, "access")).toThrow(
        TokenSignatureError,
      );
    }
    // Stripping the "v2." tag does not downgrade a v2 blob to the legacy path.
    expect(() => verifyToken(access.slice(3), KEYS, "access")).toThrow(TokenSignatureError);
  });

  it("strict schemas: an extra claim or a missing iat/nonce is refused", () => {
    const extra = signBlob(KEYS, "access", { ...accessClaims(), k: "client" });
    expect(() => verifyToken(extra, KEYS, "access")).toThrow(TokenSignatureError);
    const { iat: _iat, ...noIat } = accessClaims();
    expect(() => verifyToken(signBlob(KEYS, "access", noIat), KEYS, "access")).toThrow(
      TokenSignatureError,
    );
    // A refresh token without orig_iat is malformed in v2.
    const noOrig = signBlob(KEYS, "refresh", { ...accessClaims(), type: "refresh" });
    expect(() => verifyToken(noOrig, KEYS, "refresh")).toThrow(TokenSignatureError);
  });

  it(`refuses signing keys shorter than ${MIN_SIGNING_KEY_CHARS} chars after the legacy sunset (nit 3)`, () => {
    const after = Date.parse("2027-01-31T00:00:00Z");
    const before = Date.parse("2026-10-25T00:00:00Z");
    expect(() => new SigningKeys("x".repeat(MIN_SIGNING_KEY_CHARS - 1), after)).toThrow(
      /at least 32/,
    );
    expect(() => new SigningKeys("x".repeat(MIN_SIGNING_KEY_CHARS), after)).not.toThrow();
    // v0.0.16's 16-char floor still works inside the grace period, so the
    // upgrade re-authenticates nobody (round 1) — never below 16.
    expect(() => new SigningKeys("x".repeat(16), before)).not.toThrow();
    expect(() => new SigningKeys("x".repeat(15), before)).toThrow(/at least 32/);
    expect(
      () => new OAuthProvider({ clientsStore: new InMemoryClientsStore(), signingKey: "short" }),
    ).toThrow();
    expect(() => new StatelessClientsStore("0123456789abcde")).toThrow(); // 15 chars
  });

  it("legacy (v0.0.16) tokens of the right type verify until the sunset, then never", () => {
    const claims = {
      type: "access",
      clientId: "abc",
      scopes: [],
      expiresAt: LEGACY_ACCEPT_UNTIL_MS + 10 * DAY,
      nonce: "0123456789abcdef",
    };
    const tok = legacyMint(claims);
    const before = verifyToken(tok, KEYS, "access", LEGACY_ACCEPT_UNTIL_MS - 1);
    expect(before.legacy).toBe(true);
    expect(() => verifyToken(tok, KEYS, "refresh", LEGACY_ACCEPT_UNTIL_MS - 1)).toThrow(
      TokenSignatureError,
    );
    expect(() => verifyToken(tok, KEYS, "access", LEGACY_ACCEPT_UNTIL_MS)).toThrow(
      TokenSignatureError,
    );
  });
});

describe("v0.0.16 artefacts minted by the real v0.0.16 code (no forced re-auth)", () => {
  const T0 = Date.parse(V0016.t0);
  const legacyProvider = () =>
    provider({
      key: V0016.key,
      resource: V0016.resource,
      store: new StatelessClientsStore(V0016.key),
    });

  it("a v0.0.16 confidential client_id resolves, with the SAME client_secret Claude.ai stored", () => {
    vi.useFakeTimers({ now: T0 + 60_000 });
    const got = new StatelessClientsStore(V0016.key).getClient(V0016.confidential.client_id);
    expect(got?.client_secret).toBe(V0016.confidential.client_secret);
    expect(got?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(got?.client_name).toBe("Claude");
    // Public loopback client too.
    const pub = new StatelessClientsStore(V0016.key).getClient(V0016.public.client_id);
    expect(pub?.token_endpoint_auth_method).toBe("none");
    expect(pub?.client_secret).toBeUndefined();
  });

  it("a v0.0.16 access token still authenticates /mcp", async () => {
    vi.useFakeTimers({ now: T0 + 60_000 });
    const info = await legacyProvider().p.verifyAccessToken(V0016.access_token);
    expect(info.clientId).toBe(V0016.confidential.client_id);
  });

  it("a v0.0.16 refresh token refreshes into v2 tokens whose chain horizon starts at its issue time", async () => {
    vi.useFakeTimers({ now: T0 + 10 * DAY });
    const { p, store } = legacyProvider();
    const client = store.getClient(V0016.confidential.client_id)!;
    const fresh = await p.exchangeRefreshToken(client, V0016.refresh_token);
    expect(fresh.access_token.startsWith("v2.")).toBe(true);
    const refresh = decode(fresh.refresh_token!);
    expect(refresh["orig_iat"]).toBe(T0); // expiresAt − 30 d of the legacy token
    expect(refresh["expiresAt"]).toBe(T0 + 10 * DAY + 30 * DAY);
    expect((await p.verifyAccessToken(fresh.access_token)).clientId).toBe(client.client_id);
  });

  it("after the sunset a v0.0.16 client_id is unknown (the client re-registers once)", () => {
    vi.useFakeTimers({ now: LEGACY_ACCEPT_UNTIL_MS });
    expect(
      new StatelessClientsStore(V0016.key).getClient(V0016.confidential.client_id),
    ).toBeUndefined();
  });

  it("F-09 at use time: a v0.0.16 client registered with an off-policy redirect no longer resolves", () => {
    vi.useFakeTimers({ now: T0 + 60_000 });
    expect(new StatelessClientsStore(V0016.key).getClient(V0016.evil.client_id)).toBeUndefined();
  });
});

describe("open-DCR stores: registration caps and redirect policy (F-09, F-13, nit 22)", () => {
  const store = new StatelessClientsStore(KEY);

  it("a client registered on one instance resolves on another (same key), secret included", () => {
    const reg = store.registerClient({ redirect_uris: [CB] } as RegArg);
    expect(reg.client_id.startsWith("v2.")).toBe(true);
    const got = new StatelessClientsStore(KEY).getClient(reg.client_id);
    expect(got?.redirect_uris).toEqual([CB]);
    expect(got?.client_secret).toBe(reg.client_secret);
    expect(got?.client_secret_expires_at).toBe(0);
  });

  it("rejects a client_id signed with another key, garbage and oversized ids", () => {
    const reg = store.registerClient({ redirect_uris: [CB] } as RegArg);
    expect(new StatelessClientsStore(`${KEY}-different`).getClient(reg.client_id)).toBeUndefined();
    expect(store.getClient("not-a-signed-client-id")).toBeUndefined();
    expect(store.getClient("")).toBeUndefined();
    expect(store.getClient(`v2.${"x".repeat(3000)}.sig`)).toBeUndefined();
    expect(store.getClient("x".repeat(20_000))).toBeUndefined();
  });

  it("preserves public-client registrations without a client_secret", () => {
    const reg = store.registerClient({
      redirect_uris: [CB],
      token_endpoint_auth_method: "none",
    } as RegArg);
    expect(reg.client_secret).toBeUndefined();
    const got = store.getClient(reg.client_id);
    expect(got?.token_endpoint_auth_method).toBe("none");
    expect(got?.client_secret).toBeUndefined();
  });

  it("two identical registrations in the same second get distinct client_ids (random nonce, nit 2)", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00Z") });
    const a = store.registerClient({ redirect_uris: [CB], client_name: "x" } as RegArg);
    const b = store.registerClient({ redirect_uris: [CB], client_name: "x" } as RegArg);
    expect(a.client_id).not.toBe(b.client_id);
    expect(a.client_secret).not.toBe(b.client_secret);
  });

  it("a client_id is not a token and a token is not a client_id", async () => {
    const reg = store.registerClient({ redirect_uris: [CB] } as RegArg);
    await expect(provider({ store }).p.verifyAccessToken(reg.client_id)).rejects.toThrow(
      "invalid token",
    );
    expect(store.getClient(issueToken(accessClaims(), KEYS))).toBeUndefined();
  });

  it("InMemoryClientsStore registers a fresh client_id on every call and resolves it (restored, round 1)", () => {
    // v0.0.16 pinned this with https://a.test/cb, which the redirect policy
    // now refuses; a loopback URI keeps the register-then-lookup path covered.
    const mem = new InMemoryClientsStore();
    const uri = "http://127.0.0.1:9/cb";
    const a = mem.registerClient({ redirect_uris: [uri] } as RegArg);
    const b = mem.registerClient({ redirect_uris: [uri] } as RegArg);
    expect(a.client_id).not.toBe(b.client_id);
    expect(mem.getClient(a.client_id)?.redirect_uris).toEqual([uri]);
    expect(mem.getClient(b.client_id)?.client_id).toBe(b.client_id);
    expect(mem.getClient("unknown")).toBeUndefined();
  });

  it("refuses off-policy redirect_uris at registration (both stores)", () => {
    for (const s of [store, new InMemoryClientsStore()]) {
      for (const uri of [
        "https://evil.example/phish",
        "http://evil.example/cb",
        "file:///etc/passwd",
        "https://127.0.0.1@evil.example/",
        "https://claude.ai/api/mcp/auth_callback#frag",
      ]) {
        expect(() => s.registerClient({ redirect_uris: [uri] } as RegArg), uri).toThrow(
          expect.objectContaining({ errorCode: "invalid_client_metadata" }),
        );
      }
    }
  });

  it("caps client_name, scope, URI count and the signed blob; Claude's real registration fits", () => {
    const meta = (extra: Partial<RegArg>) => ({ redirect_uris: [CB], ...extra }) as RegArg;
    const meta400 = expect.objectContaining({ errorCode: "invalid_client_metadata" });
    expect(() => store.registerClient(meta({ client_name: "n".repeat(257) }))).toThrow(meta400);
    expect(() => store.registerClient(meta({ scope: "s".repeat(257) }))).toThrow(meta400);
    const eleven = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${9000 + i}/cb`);
    expect(() => store.registerClient(meta({ redirect_uris: eleven }))).toThrow(meta400);
    // Ten 500-char URIs pass each per-field cap but not the ~2 KB blob cap.
    const long = Array.from(
      { length: 10 },
      (_, i) => `http://127.0.0.1:${9000 + i}/${"p".repeat(470)}`,
    );
    expect(() => store.registerClient(meta({ redirect_uris: long }))).toThrow(/too large/);

    const claude = store.registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    } as RegArg);
    expect(Buffer.byteLength(claude.client_id)).toBeLessThan(1024);
    expect(store.getClient(claude.client_id)).toBeDefined();
  });

  it("an operator-listed https host is accepted by register and lookup", () => {
    const wide = new StatelessClientsStore(KEY, { httpsHosts: new Set(["vscode.dev"]) });
    const reg = wide.registerClient({ redirect_uris: ["https://vscode.dev/redirect"] } as RegArg);
    expect(wide.getClient(reg.client_id)).toBeDefined();
    // The same blob on an instance WITHOUT that host listed does not resolve.
    expect(new StatelessClientsStore(KEY).getClient(reg.client_id)).toBeUndefined();
  });
});

describe("FixedClientStore", () => {
  it("returns the configured client by id and rejects others; enforces the secret floor", () => {
    const store = new FixedClientStore({
      clientId: "fixed-client",
      clientSecret: "0123456789abcdef0123",
      redirectUris: ["https://a.test/cb"],
    });
    expect(store.getClient("fixed-client")?.client_id).toBe("fixed-client");
    expect(store.getClient("other")).toBeUndefined();
    expect(
      () =>
        new FixedClientStore({
          clientId: "x",
          clientSecret: "short",
          redirectUris: ["https://a.test/cb"],
        }),
    ).toThrow();
  });
});

describe("authorization codes (§6 signed codes, F-05, nit 4, nit 17)", () => {
  const client = () =>
    new StatelessClientsStore(KEY).registerClient({ redirect_uris: [CB] } as RegArg);
  const INVALID = "invalid authorization code";

  it("authorize → token round trip; the code is a signed v2 blob, not a server-side handle", async () => {
    const { p } = provider();
    const c = client();
    const code = await authorizeCode(p, c);
    expect(code.startsWith("v2.")).toBe(true);
    const tokens = await p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB);
    expect((await p.verifyAccessToken(tokens.access_token)).clientId).toBe(c.client_id);
    // A code is not a token.
    await expect(p.verifyAccessToken(code)).rejects.toThrow("invalid token");
  });

  it("a code issued by instance A is redeemable on instance B (same key, no shared state)", async () => {
    const c = client();
    const code = await authorizeCode(provider().p, c);
    const b = provider();
    const tokens = await b.p.exchangeAuthorizationCode(
      b.store.getClient(c.client_id)!,
      code,
      PKCE_VERIFIER,
      CB,
    );
    expect(tokens.refresh_token).toBeTruthy();
    // …and single-use on the instance that redeemed it.
    await expect(b.p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB)).rejects.toThrow(
      INVALID,
    );
  });

  it("codes expire after 5 minutes and do not verify under another key", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00Z") });
    const c = client();
    const { p } = provider();
    const code = await authorizeCode(p, c);
    await expect(
      provider({ key: `${KEY}-other` }).p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB),
    ).rejects.toThrow(INVALID);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await expect(p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB)).rejects.toThrow(INVALID);
  });

  it("a code claiming to live longer than authorize() ever mints is refused (expiresAt ≤ 5 min)", async () => {
    const { p } = provider();
    const c = client();
    const genuine = decode(await authorizeCode(p, c));
    const forged = signBlob(KEYS, "code", {
      ...genuine,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      nonce: "f".repeat(22),
    });
    await expect(p.exchangeAuthorizationCode(c, forged, PKCE_VERIFIER, CB)).rejects.toThrow(
      INVALID,
    );
    // The same claims with a legal expiry are accepted, so only the expiry was at fault.
    const legal = signBlob(KEYS, "code", { ...genuine, nonce: "g".repeat(22) });
    await expect(p.exchangeAuthorizationCode(c, legal, PKCE_VERIFIER, CB)).resolves.toBeTruthy();
  });

  it("F-05: only an S256-shaped challenge (43 base64url chars) is accepted at /authorize", async () => {
    const { p } = provider();
    for (const bad of [
      "abc",
      "x".repeat(44),
      "A".repeat(90_000),
      `${PKCE_CHALLENGE.slice(0, 42)}=`,
    ]) {
      await expect(authorizeCode(p, client(), { codeChallenge: bad })).rejects.toThrow(
        expect.objectContaining({ errorCode: "invalid_request" }),
      );
    }
  });

  it("F-05: a verifier outside 43–128 unreserved chars is refused even if it hashes to the challenge", async () => {
    const { p } = provider();
    const c = client();
    const short = "s".repeat(42);
    const code = await authorizeCode(p, c, {
      codeChallenge: createHash("sha256").update(short).digest("base64url"),
    });
    await expect(p.exchangeAuthorizationCode(c, code, short, CB)).rejects.toThrow(INVALID);
  });

  it("nit 17: every failed exchange burns the code — wrong verifier, client, redirect_uri or resource", async () => {
    const { p } = provider();
    const c = client();
    const other = client();
    const attempts: Array<(code: string) => Promise<unknown>> = [
      (code) => p.exchangeAuthorizationCode(c, code, `${PKCE_VERIFIER}x`, CB),
      (code) => p.exchangeAuthorizationCode(other, code, PKCE_VERIFIER, CB),
      (code) => p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, "http://127.0.0.1:9999/other"),
      (code) =>
        p.exchangeAuthorizationCode(
          c,
          code,
          PKCE_VERIFIER,
          CB,
          new URL("https://other.example/mcp"),
        ),
    ];
    for (const fail of attempts) {
      const code = await authorizeCode(p, c);
      await expect(fail(code)).rejects.toThrow();
      await expect(p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB)).rejects.toThrow(
        INVALID,
      );
    }
    // The /token pre-check's burn (client authentication failed).
    const code = await authorizeCode(p, c);
    p.burnAuthorizationCode(code);
    await expect(p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB)).rejects.toThrow(INVALID);
  });

  it("nit 4: redirect_uri is required at /token when the authorization request carried it", async () => {
    const { p } = provider();
    const c = client();
    const sent = await authorizeCode(p, c, {}, { redirect_uri: CB });
    await expect(p.exchangeAuthorizationCode(c, sent, PKCE_VERIFIER)).rejects.toThrow(INVALID);
    // Omitted at /authorize (SDK used the sole registered URI) → optional at /token.
    const omitted = await authorizeCode(p, c, {}, { client_id: c.client_id });
    await expect(p.exchangeAuthorizationCode(c, omitted, PKCE_VERIFIER)).resolves.toBeTruthy();
  });

  it("nit 4: one generic message for unknown, foreign-client, wrong-verifier and replayed codes", async () => {
    const { p } = provider();
    const c = client();
    const messages = new Set<string>();
    const grab = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        messages.add((err as Error).message);
      }
    };
    await grab(() => p.exchangeAuthorizationCode(c, "v2.bogus.sig", PKCE_VERIFIER, CB));
    await grab(async () =>
      p.exchangeAuthorizationCode(client(), await authorizeCode(p, c), PKCE_VERIFIER, CB),
    );
    await grab(async () =>
      p.exchangeAuthorizationCode(c, await authorizeCode(p, c), `${PKCE_VERIFIER}y`, CB),
    );
    const code = await authorizeCode(p, c);
    await p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB);
    await grab(() => p.exchangeAuthorizationCode(c, code, PKCE_VERIFIER, CB));
    expect([...messages]).toEqual([INVALID]);
  });

  it("a foreign resource is invalid_target whether or not the code is live (no liveness oracle)", async () => {
    const { p } = provider();
    const c = client();
    const foreign = new URL("https://other.example/mcp");
    await expect(
      p.exchangeAuthorizationCode(c, "v2.dead.code", PKCE_VERIFIER, CB, foreign),
    ).rejects.toThrow(expect.objectContaining({ errorCode: "invalid_target" }));
    const live = await authorizeCode(p, c);
    await expect(p.exchangeAuthorizationCode(c, live, PKCE_VERIFIER, CB, foreign)).rejects.toThrow(
      expect.objectContaining({ errorCode: "invalid_target" }),
    );
  });
});

describe("refresh tokens (nit 1)", () => {
  it("refresh succeeds on a different instance than the one that registered/authorized", async () => {
    const one = provider();
    const c = one.store.registerClient({ redirect_uris: [CB] } as RegArg);
    const tokens = await one.p.exchangeAuthorizationCode(
      c,
      await authorizeCode(one.p, c),
      PKCE_VERIFIER,
      CB,
    );
    const two = provider();
    const refreshed = await two.p.exchangeRefreshToken(
      two.store.getClient(c.client_id)!,
      tokens.refresh_token!,
    );
    expect((await two.p.verifyAccessToken(refreshed.access_token)).clientId).toBe(c.client_id);
  });

  it("orig_iat is carried forward; the chain dies 90 days after the user last authorized", async () => {
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    vi.useFakeTimers({ now: t0 });
    const { p, store } = provider();
    const c = store.registerClient({ redirect_uris: [CB] } as RegArg);
    let tokens = await p.exchangeAuthorizationCode(c, await authorizeCode(p, c), PKCE_VERIFIER, CB);
    for (let day = 25; day <= 75; day += 25) {
      vi.setSystemTime(t0 + day * DAY);
      tokens = await p.exchangeRefreshToken(c, tokens.refresh_token!);
      expect(decode(tokens.refresh_token!)["orig_iat"]).toBe(t0);
    }
    // Issued at day 75: capped at orig_iat + 90 d, not day 75 + 30 d.
    expect(decode(tokens.refresh_token!)["expiresAt"]).toBe(t0 + 90 * DAY);
    vi.setSystemTime(t0 + 90 * DAY + 1);
    await expect(p.exchangeRefreshToken(c, tokens.refresh_token!)).rejects.toThrow();
    // A forged refresh token with a stale orig_iat and a fresh expiry is refused by the horizon.
    const forged = issueToken(
      {
        type: "refresh",
        clientId: c.client_id,
        resource: RESOURCE,
        scopes: [],
        iat: Date.now(),
        orig_iat: t0,
        expiresAt: Date.now() + DAY,
        nonce: "n".repeat(22),
      },
      KEYS,
    );
    await expect(p.exchangeRefreshToken(c, forged)).rejects.toThrow(/too old/);
  });

  it("refuses an access token as a refresh token, another client's token, and a hand-minted far expiry", async () => {
    const { p, store } = provider();
    const c = store.registerClient({ redirect_uris: [CB] } as RegArg);
    const other = store.registerClient({ redirect_uris: [CB] } as RegArg);
    const tokens = await p.exchangeAuthorizationCode(
      c,
      await authorizeCode(p, c),
      PKCE_VERIFIER,
      CB,
    );
    await expect(p.exchangeRefreshToken(c, tokens.access_token)).rejects.toThrow(
      "invalid refresh token",
    );
    await expect(p.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow(
      "invalid refresh token",
    );
    await expect(p.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow("invalid token");
    const farAccess = issueToken(
      accessClaims({
        clientId: c.client_id,
        resource: RESOURCE,
        expiresAt: Date.now() + 365 * DAY,
      }),
      KEYS,
    );
    await expect(p.verifyAccessToken(farAccess)).rejects.toThrow("invalid token");
  });
});
