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
  type Mode,
  selectMode,
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
