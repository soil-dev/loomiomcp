/**
 * OAuth startup validation (src/http/config.ts, review nit 3 + F-09 knob).
 * Every value `resolveBaseConfig` / `selectMode` accepts must start: v0.0.16
 * accepted `http://[::1]` and a PUBLIC_BASE_URL with a query or fragment,
 * which then crashed inside the SDK's issuer check with a stack trace, and
 * a 15-char static client secret died the same way in FixedClientStore.
 * Pure functions plus one `createApp` per accepted URL; no server listens.
 */

import { describe, expect, it } from "vitest";
import { FixedClientStore, OAuthProvider, StatelessClientsStore } from "../src/auth/provider.js";
import { createApp } from "../src/http/app.js";
import { resolveBaseConfig, resolveRedirectPolicy, selectMode } from "../src/http/config.js";

const KEY = "k".repeat(32);
const base = (over: Record<string, string | undefined>) =>
  resolveBaseConfig({
    PUBLIC_BASE_URL: "https://mcp.example.org",
    MCP_OAUTH_SIGNING_KEY: KEY,
    ...over,
  });

describe("MCP_OAUTH_SIGNING_KEY", () => {
  const BEFORE_SUNSET = Date.parse("2026-10-25T00:00:00Z");
  const AFTER_SUNSET = Date.parse("2027-01-31T00:00:00Z");
  const at = (key: string | undefined, now: number) =>
    resolveBaseConfig(
      { PUBLIC_BASE_URL: "https://mcp.example.org", MCP_OAUTH_SIGNING_KEY: key },
      now,
    );

  it("32+ characters: no error, no warning", () => {
    const r = at(KEY, AFTER_SUNSET) as { ok: { signingKeyWarning?: string } };
    expect(r.ok.signingKeyWarning).toBeUndefined();
  });

  it("16–31 characters (v0.0.16's floor) start with a WARNING until 2027-01-31 — nobody is logged out on upgrade (round 1)", () => {
    for (const n of [16, 31]) {
      const short = "s".repeat(n);
      const r = at(short, BEFORE_SUNSET) as { ok: { signingKeyWarning?: string } };
      expect(r).toHaveProperty("ok");
      expect(r.ok.signingKeyWarning).toMatch(/2027-01-31/);
      expect(r.ok.signingKeyWarning).toMatch(new RegExp(`is ${n} characters`));
      expect(r.ok.signingKeyWarning).not.toContain(short);
    }
  });

  it("…and are refused at the first start after it; the error names the floor and never the value", () => {
    const short = "s".repeat(31);
    const r = at(short, AFTER_SUNSET);
    expect(r).toHaveProperty("error");
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/at least 32/);
    expect(msg).toMatch(/got 31/);
    expect(msg).toMatch(/grace period/);
    expect(msg).not.toContain(short);
  });

  it("under 16 characters (or unset) is refused always", () => {
    for (const key of ["s".repeat(15), undefined]) {
      expect(at(key, BEFORE_SUNSET)).toHaveProperty("error");
    }
    expect((at("s".repeat(15), BEFORE_SUNSET) as { error: string }).error).toMatch(/got 15/);
  });
});

describe("PUBLIC_BASE_URL (the OAuth issuer)", () => {
  it.each([
    ["http://[::1]:8080", /localhost \/ http:\/\/127\.0\.0\.1/],
    ["https://mcp.example.org/?x=1", /query string or fragment/],
    ["https://mcp.example.org/#f", /query string or fragment/],
    ["https://mcp.example.org/?", /query string or fragment/],
    ["http://mcp.example.org", /must be https/],
  ])("refuses %s with a FATAL line instead of an SDK stack trace", (url, why) => {
    expect((base({ PUBLIC_BASE_URL: url }) as { error?: string }).error).toMatch(why);
  });

  it.each([
    "https://mcp.example.org",
    "https://mcp.example.org/",
    "https://[::1]:8443",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ])("every accepted issuer %s also survives the SDK's metadata checks", (url) => {
    const r = base({ PUBLIC_BASE_URL: url });
    expect(r).toHaveProperty("ok");
    const issuerUrl = new URL(url);
    const provider = new OAuthProvider({
      clientsStore: new StatelessClientsStore(KEY),
      signingKey: KEY,
      resourceUrl: new URL("/mcp", issuerUrl),
      enableAuthCodeGc: false,
    });
    expect(() =>
      createApp({ oauthProvider: provider, issuerUrl, jsonLimit: "1mb", allowedOrigins: [] }),
    ).not.toThrow();
    provider.shutdown();
  });
});

describe("static-client secret", () => {
  it("refuses a secret under 16 characters at selectMode (no stack trace), never echoing it", () => {
    const secret = "0123456789abcde";
    const r = selectMode({ MCP_OAUTH_CLIENT_ID: "c", MCP_OAUTH_CLIENT_SECRET: secret });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/at least 16/);
    expect((r as { error: string }).error).not.toContain(secret);
    const ok = selectMode({ MCP_OAUTH_CLIENT_ID: "c", MCP_OAUTH_CLIENT_SECRET: `${secret}f` });
    expect(ok).toHaveProperty("ok");
    // …and whatever selectMode accepts, the store accepts.
    const mode = (
      ok as { ok: { kind: "static-client"; clientSecret: string; redirectUris: string[] } }
    ).ok;
    expect(
      () =>
        new FixedClientStore({
          clientId: "c",
          clientSecret: mode.clientSecret,
          redirectUris: mode.redirectUris,
        }),
    ).not.toThrow();
  });

  it("no longer recommends http://[::1] in the auto-approve refusal", () => {
    const r = selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "1" }, "https://mcp.example.org");
    expect((r as { error: string }).error).not.toMatch(/::1/);
  });
});

describe("MCP_OAUTH_REDIRECT_HOSTS", () => {
  it("defaults to no extra hosts, parses a list, and refuses malformed entries", () => {
    expect(resolveRedirectPolicy({})).toEqual({ ok: { httpsHosts: new Set() } });
    expect(resolveRedirectPolicy({ MCP_OAUTH_REDIRECT_HOSTS: "vscode.dev" })).toEqual({
      ok: { httpsHosts: new Set(["vscode.dev"]) },
    });
    expect(
      resolveRedirectPolicy({ MCP_OAUTH_REDIRECT_HOSTS: "https://x.example/cb" }),
    ).toHaveProperty("error");
  });
});
