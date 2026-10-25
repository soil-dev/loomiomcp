/**
 * The HTTP entry's startup refusal for the b3 secret on an open-DCR
 * deployment (src/http/config.ts `b3ExposureError` /
 * `b3ExposureWarning`). In insecure-auto-approve mode every client that
 * reaches the URL registers itself and gets the full tool list, so the
 * b3 tools (every roster with emails, invitations to arbitrary
 * addresses, membership writes anywhere) must not be registered there
 * on a public URL. Pure functions: nothing here starts a server.
 */

import { describe, expect, it } from "vitest";
import {
  B3_TOOL_NAMES,
  b3ExposureError,
  b3ExposureWarning,
  isLocalOnly,
  type Mode,
  resolveBaseConfig,
  resolveBind,
  selectMode,
  trustProxyWarning,
} from "../src/http/config.js";

const AUTO: Mode = { kind: "insecure-auto-approve" };
const STATIC: Mode = {
  kind: "static-client",
  clientId: "client",
  clientSecret: "secret",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
};
const PUBLIC = "https://mcp.example.org";
const LOCAL = "http://localhost:8080";
const B3 = { LOOMIO_B3_API_KEY: "b3-secret-value" };

describe("b3ExposureError (startup refusal)", () => {
  it("refuses open DCR on a public URL with the b3 secret set and read-only off, naming all nine tools and the ways out", () => {
    const msg = b3ExposureError({ ...B3 }, AUTO, PUBLIC);
    expect(msg).toBeDefined();
    for (const name of B3_TOOL_NAMES) expect(msg).toContain(name);
    expect(msg).toMatch(/Unset LOOMIO_B3_API_KEY/);
    expect(msg).toMatch(/LOOMIO_MCP_READONLY=1/);
    expect(msg).toMatch(/static-client mode/);
    // Never echoes the secret itself.
    expect(msg).not.toContain(B3.LOOMIO_B3_API_KEY);
  });

  it("the acknowledgement flag that lets auto-approve run on a public URL does not let the b3 tools through", () => {
    const env = {
      ...B3,
      MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
      MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "yes",
    };
    const mode = selectMode(env, PUBLIC);
    expect(mode).toEqual({ ok: AUTO });
    expect(b3ExposureError(env, AUTO, PUBLIC)).toBeDefined();
  });

  it("allows the safe combinations: static-client mode, no b3 secret, read-only mode (b3 tools never register), a localhost URL", () => {
    expect(b3ExposureError({ ...B3 }, STATIC, PUBLIC)).toBeUndefined();
    expect(b3ExposureError({}, AUTO, PUBLIC)).toBeUndefined();
    expect(b3ExposureError({ ...B3, LOOMIO_B3_API_KEY: "" }, AUTO, PUBLIC)).toBeUndefined();
    for (const ro of ["1", "true", "YES", "on"]) {
      expect(b3ExposureError({ ...B3, LOOMIO_MCP_READONLY: ro }, AUTO, PUBLIC), ro).toBeUndefined();
    }
    expect(b3ExposureError({ ...B3 }, AUTO, LOCAL)).toBeUndefined();
    expect(b3ExposureError({ ...B3 }, AUTO, "http://127.0.0.1:8080")).toBeUndefined();
  });

  it("a read-only value outside the truthy spellings does not count as read-only", () => {
    expect(b3ExposureError({ ...B3, LOOMIO_MCP_READONLY: "0" }, AUTO, PUBLIC)).toBeDefined();
    expect(b3ExposureError({ ...B3, LOOMIO_MCP_READONLY: "false" }, AUTO, PUBLIC)).toBeDefined();
  });
});

describe("b3ExposureWarning (the localhost case it lets through)", () => {
  it("warns, naming the nine tools, when auto-approve runs with the b3 tools enabled", () => {
    const msg = b3ExposureWarning({ ...B3 }, AUTO);
    expect(msg).toBeDefined();
    for (const name of B3_TOOL_NAMES) expect(msg).toContain(name);
    expect(msg).not.toContain(B3.LOOMIO_B3_API_KEY);
  });

  it("is silent in static-client mode, without the secret, and in read-only mode", () => {
    expect(b3ExposureWarning({ ...B3 }, STATIC)).toBeUndefined();
    expect(b3ExposureWarning({}, AUTO)).toBeUndefined();
    expect(b3ExposureWarning({ ...B3, LOOMIO_MCP_READONLY: "1" }, AUTO)).toBeUndefined();
  });
});

// ── Bind address (security review F-10) ─────────────────────────────────────
//
// v0.0.16 called `app.listen(port)` — every interface — while the open-DCR
// acknowledgement and the b3 refusal were waived whenever PUBLIC_BASE_URL
// was loopback, so a "local" open-DCR server (b3 tools included) answered
// the whole LAN. These pin the bind rule and that the waivers now need a
// loopback BIND, not just a loopback URL.

describe("resolveBind / isLocalOnly (F-10)", () => {
  it("a loopback PUBLIC_BASE_URL binds that loopback host only", () => {
    expect(resolveBind({}, "http://127.0.0.1:8080")).toEqual({
      ok: { host: "127.0.0.1", loopback: true },
    });
    expect(resolveBind({}, "http://localhost:8080")).toEqual({
      ok: { host: "localhost", loopback: true },
    });
    expect(isLocalOnly({}, "http://127.0.0.1:8080")).toBe(true);
  });

  it("a public PUBLIC_BASE_URL keeps the every-interface bind (Cloud Run needs it)", () => {
    expect(resolveBind({}, PUBLIC)).toEqual({ ok: { host: undefined, loopback: false } });
    expect(isLocalOnly({}, PUBLIC)).toBe(false);
  });

  it("MCP_HTTP_BIND overrides; a non-loopback bind forfeits the localhost waivers", () => {
    expect(resolveBind({ MCP_HTTP_BIND: "0.0.0.0" }, LOCAL)).toEqual({
      ok: { host: "0.0.0.0", loopback: false },
    });
    expect(resolveBind({ MCP_HTTP_BIND: "[::1]" }, LOCAL)).toEqual({
      ok: { host: "::1", loopback: true },
    });
    expect(resolveBind({ MCP_HTTP_BIND: "127.0.0.2" }, PUBLIC)).toEqual({
      ok: { host: "127.0.0.2", loopback: true },
    });
    expect(isLocalOnly({ MCP_HTTP_BIND: "0.0.0.0" }, LOCAL)).toBe(false);
    expect(isLocalOnly({ MCP_HTTP_BIND: "::" }, LOCAL)).toBe(false);
    // A loopback bind does not make a public URL "local".
    expect(isLocalOnly({ MCP_HTTP_BIND: "127.0.0.1" }, PUBLIC)).toBe(false);
  });

  it("refuses a bind value that is not an address, without echoing more than 64 chars", () => {
    const r = resolveBind({ MCP_HTTP_BIND: `evil.example${"x".repeat(200)}` }, LOCAL);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/MCP_HTTP_BIND must be an IP address/);
    expect((r as { error: string }).error.length).toBeLessThan(200);
    expect(
      resolveBaseConfig({
        PUBLIC_BASE_URL: LOCAL,
        MCP_OAUTH_SIGNING_KEY: "k".repeat(32),
        MCP_HTTP_BIND: "lan-host",
      }),
    ).toHaveProperty("error");
  });

  it("open DCR on a loopback URL bound beyond loopback needs the acknowledgement", () => {
    const env = { MCP_OAUTH_INSECURE_AUTO_APPROVE: "1", MCP_HTTP_BIND: "0.0.0.0" };
    const refused = selectMode(env, LOCAL);
    expect(refused).toHaveProperty("error");
    expect((refused as { error: string }).error).toMatch(/MCP_HTTP_BIND listens beyond loopback/);
    expect(selectMode({ ...env, MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "yes" }, LOCAL)).toEqual({
      ok: AUTO,
    });
    // The v0.0.16 waiver still holds for a genuinely local server.
    expect(selectMode({ MCP_OAUTH_INSECURE_AUTO_APPROVE: "1" }, LOCAL)).toEqual({ ok: AUTO });
  });

  it("the b3 refusal applies to a loopback URL bound beyond loopback — even acknowledged", () => {
    const env = { ...B3, MCP_HTTP_BIND: "0.0.0.0", MCP_OAUTH_I_KNOW_WHAT_IM_DOING: "yes" };
    expect(b3ExposureError(env, AUTO, LOCAL)).toMatch(/non-loopback MCP_HTTP_BIND/);
    expect(b3ExposureError({ ...B3, MCP_HTTP_BIND: "127.0.0.1" }, AUTO, LOCAL)).toBeUndefined();
  });
});

// ── trust proxy default and body cap (F-12, F-14) ───────────────────────────

describe("resolveBaseConfig: MCP_HTTP_TRUST_PROXY and MCP_HTTP_JSON_LIMIT", () => {
  const cfg = (over: Record<string, string> = {}) =>
    resolveBaseConfig({ PUBLIC_BASE_URL: PUBLIC, MCP_OAUTH_SIGNING_KEY: "k".repeat(32), ...over });

  it("trusts no proxy unless told to (F-12: v0.0.16 defaulted to 1)", () => {
    expect((cfg() as { ok: { trustProxy: number } }).ok.trustProxy).toBe(0);
    expect(
      (cfg({ MCP_HTTP_TRUST_PROXY: "1" }) as { ok: { trustProxy: number } }).ok.trustProxy,
    ).toBe(1);
    expect(cfg({ MCP_HTTP_TRUST_PROXY: "true" })).toHaveProperty("error");
    expect(cfg({ MCP_HTTP_TRUST_PROXY: "11" })).toHaveProperty("error");
  });

  it("caps /mcp bodies at 256 KB by default (F-14: v0.0.16 allowed 1 MB) and refuses a typo", () => {
    expect((cfg() as { ok: { jsonLimit: number } }).ok.jsonLimit).toBe(256 * 1024);
    expect(
      (cfg({ MCP_HTTP_JSON_LIMIT: "64kb" }) as { ok: { jsonLimit: number } }).ok.jsonLimit,
    ).toBe(65_536);
    expect(
      (cfg({ MCP_HTTP_JSON_LIMIT: "1mb" }) as { ok: { jsonLimit: number } }).ok.jsonLimit,
    ).toBe(1_048_576);
    expect(cfg({ MCP_HTTP_JSON_LIMIT: "lots" })).toHaveProperty("error");
    expect(cfg({ MCP_HTTP_JSON_LIMIT: "0" })).toHaveProperty("error");
  });

  it("validates the upstream and quota knobs at startup instead of silently defaulting", () => {
    expect(cfg({ MCP_HTTP_UPSTREAM_BUDGET: "0" })).toHaveProperty("ok");
    expect(cfg({ MCP_HTTP_UPSTREAM_BUDGET: "-1" })).toHaveProperty("error");
    expect(cfg({ MCP_DAILY_TOOL_CALLS: "5k" })).toHaveProperty("error");
    expect(cfg({ MCP_DAILY_RESULT_BYTES: "1e9" })).toHaveProperty("error");
    expect(cfg({ MCP_HTTP_UPSTREAM_CONCURRENCY: "0" })).toHaveProperty("error");
    expect(cfg({ MCP_HTTP_UPSTREAM_CONCURRENCY: "8" })).toHaveProperty("ok");
  });
});

describe("trustProxyWarning (F-12 default on Cloud Run)", () => {
  it("warns only when Cloud Run's K_SERVICE is set and no proxy is trusted", () => {
    expect(trustProxyWarning({ K_SERVICE: "loomiomcp" }, 0)).toMatch(/MCP_HTTP_TRUST_PROXY=1/);
    expect(trustProxyWarning({ K_SERVICE: "loomiomcp" }, 1)).toBeUndefined();
    expect(trustProxyWarning({}, 0)).toBeUndefined();
  });
});
