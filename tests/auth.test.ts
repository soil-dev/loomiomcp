import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  issueToken,
  verifyToken,
  TokenSignatureError,
  TokenExpiredError,
} from "../src/auth/token.js";
import {
  FixedClientStore,
  InMemoryClientsStore,
  OAuthProvider,
  StatelessClientsStore,
} from "../src/auth/provider.js";

function autoApproveProvider(signingKey: string): OAuthProvider {
  return new OAuthProvider({
    clientsStore: new InMemoryClientsStore(),
    signingKey,
    enableAuthCodeGc: false,
  });
}

const KEY = "0123456789abcdef0123456789abcdef";

const PKCE_VERIFIER = "test-verifier-1234567890abcdefghijklmnopqrstuv";
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

describe("issueToken / verifyToken", () => {
  it("round-trips claims", () => {
    const claims = {
      type: "access" as const,
      clientId: "abc",
      scopes: ["read"],
      expiresAt: Date.now() + 60_000,
      nonce: "n1",
    };
    const tok = issueToken(claims, KEY);
    const back = verifyToken(tok, KEY);
    expect(back.clientId).toBe("abc");
    expect(back.scopes).toEqual(["read"]);
    expect(back.type).toBe("access");
  });

  it("rejects modified payload", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() + 60_000, nonce: "n" },
      KEY,
    );
    const [body, sig] = tok.split(".") as [string, string];
    const tampered = `${body.slice(0, -2)}AB.${sig}`;
    expect(() => verifyToken(tampered, KEY)).toThrow(TokenSignatureError);
  });

  it("rejects expired tokens", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() - 1_000, nonce: "n" },
      KEY,
    );
    expect(() => verifyToken(tok, KEY)).toThrow(TokenExpiredError);
  });

  it("rejects wrong signing key", () => {
    const tok = issueToken(
      { type: "access", clientId: "abc", scopes: [], expiresAt: Date.now() + 60_000, nonce: "n" },
      KEY,
    );
    expect(() => verifyToken(tok, `${KEY}wrong`)).toThrow(TokenSignatureError);
  });
});

describe("InMemoryClientsStore", () => {
  it("registers a fresh client_id on every call", () => {
    const store = new InMemoryClientsStore();
    const a = store.registerClient({
      redirect_uris: ["https://a.test/cb"],
    } as Parameters<typeof store.registerClient>[0]);
    const b = store.registerClient({
      redirect_uris: ["https://a.test/cb"],
    } as Parameters<typeof store.registerClient>[0]);
    expect(a.client_id).not.toBe(b.client_id);
    expect(store.getClient(a.client_id)).toBeDefined();
  });
});

describe("StatelessClientsStore", () => {
  type RegArg = Parameters<StatelessClientsStore["registerClient"]>[0];

  it("recognises a client registered on a *different* instance (same key)", () => {
    // instance A registers; instance B (fresh process, same signing key)
    // must resolve it without any shared storage — this is the whole fix.
    const a = new StatelessClientsStore(KEY);
    const reg = a.registerClient({ redirect_uris: ["https://a.test/cb"] } as RegArg);

    const b = new StatelessClientsStore(KEY);
    const got = b.getClient(reg.client_id);
    expect(got).toBeDefined();
    expect(got?.redirect_uris).toEqual(["https://a.test/cb"]);
    // Derived secret is identical across instances → client_secret_post works.
    expect(got?.client_secret).toBe(reg.client_secret);
    expect(got?.client_secret_expires_at).toBe(0);
  });

  it("rejects a client_id signed with a different key", () => {
    const reg = new StatelessClientsStore(KEY).registerClient({
      redirect_uris: ["https://a.test/cb"],
    } as RegArg);
    expect(new StatelessClientsStore(`${KEY}-different`).getClient(reg.client_id)).toBeUndefined();
  });

  it("returns undefined for a garbage / unsigned client_id", () => {
    const store = new StatelessClientsStore(KEY);
    expect(store.getClient("not-a-signed-client-id")).toBeUndefined();
    expect(store.getClient("")).toBeUndefined();
  });

  it("preserves public-client registrations without forcing a client_secret", () => {
    const store = new StatelessClientsStore(KEY);
    const reg = store.registerClient({
      redirect_uris: ["https://a.test/cb"],
      token_endpoint_auth_method: "none",
    } as RegArg);

    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.client_secret).toBeUndefined();
    expect(reg.client_secret_expires_at).toBeUndefined();

    const got = store.getClient(reg.client_id);
    expect(got).toBeDefined();
    expect(got?.token_endpoint_auth_method).toBe("none");
    expect(got?.client_secret).toBeUndefined();
    expect(got?.client_secret_expires_at).toBeUndefined();
  });

  it("rejects oversized signed-client ids before attempting verification", () => {
    const store = new StatelessClientsStore(KEY);
    expect(store.getClient("x".repeat(20_000))).toBeUndefined();
  });

  it("refresh succeeds on a different instance than the one that registered/authorized", async () => {
    // The regression test for the re-auth bug: registration + the initial
    // dance happen on instance 1; a day later the refresh lands on a fresh
    // instance 2 (new store + provider, same key). It must work.
    const store1 = new StatelessClientsStore(KEY);
    const p1 = new OAuthProvider({
      clientsStore: store1,
      signingKey: KEY,
      enableAuthCodeGc: false,
    });
    const client = store1.registerClient({ redirect_uris: ["https://a.test/cb"] } as RegArg);

    let redirected: string | undefined;
    const res = {
      redirect(url: string) {
        redirected = url;
      },
    } as unknown as import("express").Response;
    await p1.authorize(
      client,
      {
        codeChallenge: PKCE_CHALLENGE,
        redirectUri: "https://a.test/cb",
        scopes: [],
      } as Parameters<typeof p1.authorize>[1],
      res,
    );
    const code = new URL(redirected!).searchParams.get("code")!;
    const tokens = await p1.exchangeAuthorizationCode(
      client,
      code,
      PKCE_VERIFIER,
      "https://a.test/cb",
    );

    // Instance 2: brand-new store + provider, same signing key.
    const store2 = new StatelessClientsStore(KEY);
    const p2 = new OAuthProvider({
      clientsStore: store2,
      signingKey: KEY,
      enableAuthCodeGc: false,
    });
    const clientOnInstance2 = store2.getClient(client.client_id);
    expect(clientOnInstance2).toBeDefined();

    const refreshed = await p2.exchangeRefreshToken(clientOnInstance2!, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();
    // And the new access token verifies on instance 2.
    const info = await p2.verifyAccessToken(refreshed.access_token);
    expect(info.clientId).toBe(client.client_id);
  });
});

describe("FixedClientStore", () => {
  it("returns the configured client by id and rejects others", () => {
    const store = new FixedClientStore({
      clientId: "fixed-client",
      clientSecret: "0123456789abcdef0123",
      redirectUris: ["https://a.test/cb"],
    });
    expect(store.getClient("fixed-client")?.client_id).toBe("fixed-client");
    expect(store.getClient("other")).toBeUndefined();
  });

  it("enforces minimum secret length", () => {
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

describe("OAuthProvider", () => {
  it("requires a non-trivial signing key", () => {
    expect(
      () =>
        new OAuthProvider({
          clientsStore: new InMemoryClientsStore(),
          signingKey: "short",
        }),
    ).toThrow();
  });

  it("authorize → token round trip", async () => {
    const provider = autoApproveProvider(KEY);
    const store = provider.clientsStore as InMemoryClientsStore;
    const client = store.registerClient({
      redirect_uris: ["https://a.test/cb"],
    } as Parameters<typeof store.registerClient>[0]);

    let redirected: string | undefined;
    const res = {
      redirect(url: string) {
        redirected = url;
      },
    } as unknown as import("express").Response;

    await provider.authorize(
      client,
      {
        codeChallenge: PKCE_CHALLENGE,
        redirectUri: "https://a.test/cb",
        scopes: [],
      } as Parameters<typeof provider.authorize>[1],
      res,
    );
    expect(redirected).toBeDefined();
    const code = new URL(redirected!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code!,
      PKCE_VERIFIER,
      "https://a.test/cb",
    );
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
  });
});
