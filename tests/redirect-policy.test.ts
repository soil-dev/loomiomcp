/**
 * The open-DCR redirect_uri policy (src/auth/redirect-policy.ts, review
 * F-09). v0.0.16 signed any redirect_uri the SDK's SafeUrlSchema let
 * through (everything but javascript:/data:/vbscript:) and /authorize
 * auto-approves, so the connector's origin was an open redirect. Every
 * "refused" row below was accepted by v0.0.16's /register
 * (secreview open-redirect/repro.out, oauth-abuse.out 3c/3f).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_REDIRECT_URIS,
  DEFAULT_REDIRECT_POLICY,
  describeRedirectPolicy,
  parseRedirectHosts,
  redirectUriProblem,
  redirectUrisProblem,
} from "../src/auth/redirect-policy.js";

const ok = (uri: string, policy = DEFAULT_REDIRECT_POLICY) => redirectUriProblem(uri, policy);

describe("redirectUriProblem (default policy)", () => {
  it.each([
    ...DEFAULT_ANTHROPIC_REDIRECT_URIS,
    "http://127.0.0.1:33418/callback",
    "http://localhost/cb",
    "http://[::1]:5000/oauth/cb?x=1",
    "https://localhost:8443/cb",
    "com.example.app:/oauth2redirect", // RFC 8252 §7.1 private-use scheme
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "vscode://vscode.github-authentication/did-authenticate",
    "windsurf://codeium.windsurf/oauth",
  ])("accepts %s", (uri) => {
    expect(ok(uri)).toBeUndefined();
  });

  it.each([
    ["https://evil.example/phish?x=1", /allow-list/],
    ["https://claude.ai/api/mcp/auth_callback?x=1", /allow-list/], // not exact
    ["https://claude.ai.evil.example/api/mcp/auth_callback", /allow-list/],
    ["http://evil.example/cb", /plain http/],
    ["http://127.0.0.1.evil.example/cb", /plain http/],
    ["https://claude.ai/api/mcp/auth_callback#frag", /fragment/],
    ["http://127.0.0.1:9/cb#", /fragment/],
    ["https://127.0.0.1@evil.example/", /userinfo/],
    ["https://@claude.ai/api/mcp/auth_callback", /userinfo/],
    ["http://user:pw@localhost/cb", /userinfo/],
    ["javascript:alert(1)", /scheme/],
    ["data:text/html,hi", /scheme/],
    ["vbscript:msgbox", /scheme/],
    ["file:///etc/passwd", /scheme/],
    ["ftp://evil.example/", /scheme/],
    ["blob:https://evil.example/uuid", /scheme/],
    ["about:blank", /scheme/],
    ["filesystem:https://evil.example/x", /scheme/],
    ["JAVASCRIPT:alert(1)", /scheme/],
    // Round 1 (F-09 residual): OS / browser protocol handlers are launchers,
    // not app callbacks. v0.0.17's first cut signed every one of these and
    // /authorize 302'd to them (secreview sec2/t-redirect*.mjs).
    ["ms-excel:ofe|u|https://evil.example/x.xlsx", /scheme ms-excel: is not allowed/],
    ["MS-WORD:ofe|u|https://evil.example/x.docx", /scheme ms-word:/],
    ["ms-officecmd:x", /scheme/],
    ["ms-msdt:/id%20PCWDiagnostic", /scheme/],
    ["ms-settings:", /scheme/],
    ["search-ms:query=x&crumb=location:%5C%5Cevil.example@SSL%5Cs", /scheme/],
    ["search:query=x", /scheme/],
    ["shell:startup", /scheme/],
    ["itms-services://?action=download-manifest&url=https://evil.example/m.plist", /scheme/],
    ["itms-apps://apps.apple.com/app/id1", /scheme/],
    ["view-source:https://evil.example/", /scheme/],
    ["intent://evil.example/#Intent;end", /fragment/],
    ["intent://evil.example/", /scheme/],
    ["jar:https://evil.example/x.jar!/", /scheme/],
    ["ws://evil.example/", /scheme/],
    ["wss://evil.example/", /scheme/],
    ["mailto:victim@example.org", /scheme/],
    ["tel:+15555550100", /scheme/],
    ["sms:+15555550100", /scheme/],
    ["chrome://settings", /scheme/],
    ["chrome-extension://abcdef/page.html", /scheme/],
    ["edge://settings", /scheme/],
    ["smb://evil.example/share", /scheme/],
    ["ldap://evil.example/dc=x", /scheme/],
    ["ssh://evil.example", /scheme/],
    ["telnet://evil.example", /scheme/],
    ["jnlp://evil.example/app.jnlp", /scheme/],
    ["mhtml:https://evil.example/x.mht", /scheme/],
    ["res://ieframe.dll/", /scheme/],
    ["web+evil:https://evil.example/", /scheme/],
    ["x-apple.systempreferences:com.apple.preference", /scheme/],
    ["microsoft-edge:https://evil.example/", /scheme/],
    ["http://localhost/\\evil", /backslash/],
    [" http://localhost/cb", /whitespace/],
    ["http://localhost/cb\n", /control/],
    [`http://localhost/${"a".repeat(600)}`, /longer than 512/],
    ["not a url", /whitespace|not a valid URL/],
  ])("refuses %s", (uri, why) => {
    expect(ok(uri)).toMatch(why);
  });
});

describe("Anthropic callbacks", () => {
  it("include the announced claude.com callback, alone or next to claude.ai (round 1)", () => {
    // Anthropic's connector guidance: the callback "may change to
    // https://claude.com/api/mcp/auth_callback". v0.0.16 accepted it; the
    // first v0.0.17 cut refused it — and with it the whole registration.
    const claudeCom = "https://claude.com/api/mcp/auth_callback";
    expect(DEFAULT_ANTHROPIC_REDIRECT_URIS).toContain(claudeCom);
    expect(redirectUrisProblem([claudeCom], DEFAULT_REDIRECT_POLICY)).toBeUndefined();
    expect(
      redirectUrisProblem(
        ["https://claude.ai/api/mcp/auth_callback", claudeCom],
        DEFAULT_REDIRECT_POLICY,
      ),
    ).toBeUndefined();
    // Exact match only: any other claude.com path still needs the host knob.
    expect(ok("https://claude.com/api/mcp/other")).toMatch(/allow-list/);
    expect(ok("https://claude.com/api/mcp/auth_callback?x=1")).toMatch(/allow-list/);
  });
});

describe("redirectUrisProblem", () => {
  it("requires 1–10 URIs and names the offending index, never the value", () => {
    expect(redirectUrisProblem([], DEFAULT_REDIRECT_POLICY)).toMatch(/at least one/);
    expect(redirectUrisProblem(undefined, DEFAULT_REDIRECT_POLICY)).toMatch(/at least one/);
    const eleven = Array.from({ length: 11 }, (_, i) => `http://localhost:${9000 + i}/cb`);
    expect(redirectUrisProblem(eleven, DEFAULT_REDIRECT_POLICY)).toMatch(/at most 10/);
    expect(redirectUrisProblem(eleven.slice(0, 10), DEFAULT_REDIRECT_POLICY)).toBeUndefined();
    const msg = redirectUrisProblem(
      ["http://localhost/cb", "https://evil.example/secret-path"],
      DEFAULT_REDIRECT_POLICY,
    );
    expect(msg).toMatch(/^redirect_uris\[1\]/);
    expect(msg).not.toContain("evil.example");
  });
});

describe("MCP_OAUTH_REDIRECT_HOSTS", () => {
  it("adds exact https hosts (case-normalised), never http and never sub-domains", () => {
    const r = parseRedirectHosts(" vscode.dev , ChatGPT.com ");
    expect(r).toHaveProperty("ok");
    const policy = (r as { ok: Parameters<typeof redirectUriProblem>[1] }).ok;
    expect(ok("https://vscode.dev/redirect", policy)).toBeUndefined();
    expect(ok("https://chatgpt.com/connector_platform_oauth_redirect", policy)).toBeUndefined();
    expect(ok("https://evil.vscode.dev/redirect", policy)).toMatch(/allow-list/);
    expect(ok("http://vscode.dev/redirect", policy)).toMatch(/plain http/);
    expect(ok("https://vscode.dev/redirect#x", policy)).toMatch(/fragment/);
    expect(describeRedirectPolicy(policy)).toContain("vscode.dev");
  });

  it("`*` re-opens any https host but keeps every shape rule", () => {
    const r = parseRedirectHosts("*");
    const policy = (r as { ok: Parameters<typeof redirectUriProblem>[1] }).ok;
    expect(policy.httpsHosts).toBe("*");
    expect(ok("https://evil.example/cb", policy)).toBeUndefined();
    expect(ok("http://evil.example/cb", policy)).toMatch(/plain http/);
    expect(ok("https://a@evil.example/cb", policy)).toMatch(/userinfo/);
    expect(describeRedirectPolicy(policy)).toContain("ANY https host");
  });

  it.each([
    "https://vscode.dev",
    "vscode.dev/cb",
    "vscode.dev:443",
    "*.vscode.dev",
    "*,vscode.dev",
    "user@vscode.dev",
  ])("refuses the malformed entry %s", (raw) => {
    expect(parseRedirectHosts(raw)).toHaveProperty("error");
  });

  it("unset or empty means no extra hosts", () => {
    for (const raw of [undefined, "", " , "]) {
      const r = parseRedirectHosts(raw) as { ok: { httpsHosts: Set<string> } };
      expect(r.ok.httpsHosts).toEqual(new Set());
    }
  });
});
