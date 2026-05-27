import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  issueToken,
  verifyToken,
  TokenSignatureError,
  TokenExpiredError,
} from "../src/auth/token.js";
import { FixedClientStore, InMemoryClientsStore, OAuthProvider } from "../src/auth/provider.js";

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
