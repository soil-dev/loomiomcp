/**
 * Pure config / mode-selection helpers for the HTTP entry. Kept in a
 * separate module so tests can import them without triggering the
 * top-level server-startup code in `src/http.ts`.
 */

import { isTruthyEnvValue } from "../env.js";

export const DEFAULT_ANTHROPIC_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.ai/api/oauth/callback",
  "https://claude.ai/oauth/callback",
];

export const DEFAULT_MCP_CLIENT_ORIGINS = ["https://claude.ai"];

export function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function isLocalhostUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  return isLocalHostname(new URL(url).hostname);
}

export type Mode =
  | { kind: "static-client"; clientId: string; clientSecret: string; redirectUris: string[] }
  | { kind: "insecure-auto-approve" };

export type SelectModeResult = { ok: Mode } | { error: string };

export function selectMode(
  env: NodeJS.ProcessEnv = process.env,
  publicBaseUrl?: string,
): SelectModeResult {
  const CLIENT_ID = env["MCP_OAUTH_CLIENT_ID"];
  const CLIENT_SECRET = env["MCP_OAUTH_CLIENT_SECRET"];
  const REDIRECT_URIS_ENV = env["MCP_OAUTH_REDIRECT_URIS"];
  const insecureAutoApprove =
    env["MCP_OAUTH_INSECURE_AUTO_APPROVE"] === "1" ||
    env["MCP_OAUTH_INSECURE_AUTO_APPROVE"]?.toLowerCase() === "true";

  if (CLIENT_ID && CLIENT_SECRET) {
    const redirectUris = REDIRECT_URIS_ENV
      ? REDIRECT_URIS_ENV.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_ANTHROPIC_REDIRECT_URIS;
    if (!redirectUris.length) {
      return {
        error: "MCP_OAUTH_REDIRECT_URIS was set but contained no usable URIs",
      };
    }
    const bad = redirectUris.find((u) => !URL.canParse(u));
    if (bad) {
      return {
        error: `MCP_OAUTH_REDIRECT_URIS contains a malformed URL: ${bad}`,
      };
    }
    return {
      ok: {
        kind: "static-client",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUris,
      },
    };
  }
  if (CLIENT_ID || CLIENT_SECRET) {
    return {
      error:
        "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must both be set to enable static-client mode (got only one).",
    };
  }
  if (insecureAutoApprove) {
    const isLocal = publicBaseUrl !== undefined && isLocalhostUrl(publicBaseUrl);
    const acknowledged = env["MCP_OAUTH_I_KNOW_WHAT_IM_DOING"]?.toLowerCase() === "yes";
    if (!isLocal && !acknowledged) {
      return {
        error:
          "MCP_OAUTH_INSECURE_AUTO_APPROVE is set but PUBLIC_BASE_URL is not a localhost address. " +
          "This mode lets anyone who can reach the URL register an OAuth client and use the shared " +
          "Loomio API key; it must not be exposed publicly. Either:\n" +
          "  - Point PUBLIC_BASE_URL at http://localhost / 127.0.0.1 / ::1 (recommended), or\n" +
          "  - Set MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes to acknowledge the risk (only do this on a private network).",
      };
    }
    return { ok: { kind: "insecure-auto-approve" } };
  }
  return {
    error:
      "No OAuth mode configured. Either:\n" +
      "  - Set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET (recommended for public deployments)\n" +
      "  - Or set MCP_OAUTH_INSECURE_AUTO_APPROVE=1 (only safe for local development or private-network deployments)",
  };
}

/**
 * The b3 tools `src/server.ts` registers when `LOOMIO_B3_API_KEY` is set
 * and the server is not read-only — named in the startup refusal and
 * warning below so the operator sees what the secret would expose.
 */
export const B3_TOOL_NAMES = [
  "deactivate_user",
  "reactivate_user",
  "get_user",
  "list_users",
  "list_instance_groups",
  "list_instance_memberships",
  "add_group_members",
  "update_membership_roles",
  "revoke_membership",
] as const;

/** True when the b3 tools would be registered: the secret is set and read-only mode is off. */
function b3ToolsEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env["LOOMIO_B3_API_KEY"]) && !isTruthyEnvValue(env["LOOMIO_MCP_READONLY"]);
}

/**
 * Refuse to start an open-DCR deployment that would hand the b3 tools to
 * anyone. In insecure-auto-approve mode any client that reaches the URL
 * registers itself (StatelessClientsStore) and gets the full tool list,
 * and with the b3 secret set and read-only off that list includes every
 * roster with emails (`list_instance_memberships`), invitations to ≤ 50
 * arbitrary addresses per call with no per-actor throttle
 * (`add_group_members`) and instance-wide account and membership changes.
 * SECURITY.md / DEPLOY.md / README already say "never set
 * LOOMIO_B3_API_KEY on an open-DCR deployment"; this makes the public-URL
 * case impossible rather than merely documented. Localhost stays allowed
 * (single-user development; `b3ExposureWarning` makes it loud), and so
 * does read-only mode, where the b3 tools never register. There is no
 * override: an operator who needs b3 over HTTP uses static-client mode.
 * Returns the fatal message, or `undefined` when the combination is safe.
 */
export function b3ExposureError(
  env: NodeJS.ProcessEnv,
  mode: Mode,
  publicBaseUrl: string,
): string | undefined {
  if (mode.kind !== "insecure-auto-approve" || !b3ToolsEnabled(env)) return undefined;
  if (isLocalhostUrl(publicBaseUrl)) return undefined;
  return (
    "LOOMIO_B3_API_KEY is set on an open-DCR deployment (MCP_OAUTH_INSECURE_AUTO_APPROVE with a " +
    "non-localhost PUBLIC_BASE_URL) and read-only mode is off, so every self-registered OAuth " +
    `client would get the instance-admin tools ${B3_TOOL_NAMES.join(", ")} — every group roster ` +
    "with emails, invitations to arbitrary addresses, account and membership changes anywhere. " +
    "Unset LOOMIO_B3_API_KEY, set LOOMIO_MCP_READONLY=1, or use static-client mode " +
    "(MCP_OAUTH_CLIENT_ID / MCP_OAUTH_CLIENT_SECRET)."
  );
}

/**
 * The startup warning for the one auto-approve + b3 combination
 * `b3ExposureError` lets through (a localhost URL): anyone who can reach
 * that port gets the b3 tools. `undefined` when there is nothing to warn
 * about.
 */
export function b3ExposureWarning(env: NodeJS.ProcessEnv, mode: Mode): string | undefined {
  if (mode.kind !== "insecure-auto-approve" || !b3ToolsEnabled(env)) return undefined;
  return (
    "LOOMIO_B3_API_KEY is set in INSECURE_AUTO_APPROVE mode: any client that can reach this " +
    `port registers itself and gets the instance-admin tools ${B3_TOOL_NAMES.join(", ")}. ` +
    "Keep it to single-user local development."
  );
}

export interface BaseConfig {
  publicBaseUrl: string;
  signingKey: string;
  port: number;
  jsonLimit: string;
  allowedOrigins: string[];
  trustProxy: number;
}

export type BaseConfigResult = { ok: BaseConfig } | { error: string };

export function resolveBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfigResult {
  const publicBaseUrl = env["PUBLIC_BASE_URL"];
  if (!publicBaseUrl) {
    return {
      error:
        "PUBLIC_BASE_URL is not set. It must be the public origin of this server (e.g. https://example.run.app), used to build OAuth metadata and authorization redirect URLs.",
    };
  }
  if (!URL.canParse(publicBaseUrl)) {
    return {
      error: `PUBLIC_BASE_URL is not a valid URL: ${publicBaseUrl}`,
    };
  }
  const parsedBaseUrl = new URL(publicBaseUrl);
  const isLocal = isLocalHostname(parsedBaseUrl.hostname);
  const isHttps = parsedBaseUrl.protocol === "https:";
  const isHttpLocal = parsedBaseUrl.protocol === "http:" && isLocal;
  if (!isHttps && !isHttpLocal) {
    return {
      error: `PUBLIC_BASE_URL must be https://… (or http://localhost for development); got ${parsedBaseUrl.protocol}//${parsedBaseUrl.hostname}.`,
    };
  }

  const signingKey = env["MCP_OAUTH_SIGNING_KEY"];
  if (!signingKey || signingKey.length < 16) {
    return {
      error:
        "MCP_OAUTH_SIGNING_KEY must be set and at least 16 chars long. It is the HMAC key used to sign OAuth access tokens; rotating it invalidates all outstanding tokens.",
    };
  }

  const portRaw = env["PORT"] ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      error: `PORT must be an integer in 1..65535 (got ${JSON.stringify(portRaw)}).`,
    };
  }

  const jsonLimit = env["MCP_HTTP_JSON_LIMIT"] ?? "1mb";
  const allowedOriginsRaw = env["MCP_ALLOWED_ORIGINS"];
  const extraOrigins = allowedOriginsRaw
    ? allowedOriginsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const parsedExtraOrigins: URL[] = [];
  for (const origin of extraOrigins) {
    if (!URL.canParse(origin)) {
      return {
        error: `MCP_ALLOWED_ORIGINS contains a malformed URL: ${origin}`,
      };
    }
    const parsedOrigin = new URL(origin);
    const isAllowedHttps = parsedOrigin.protocol === "https:";
    const isAllowedHttpLocal =
      parsedOrigin.protocol === "http:" && isLocalHostname(parsedOrigin.hostname);
    if (!isAllowedHttps && !isAllowedHttpLocal) {
      return {
        error:
          `MCP_ALLOWED_ORIGINS entries must be https:// origins ` +
          `(or http://localhost for development); got ${parsedOrigin.protocol}//${parsedOrigin.hostname}.`,
      };
    }
    parsedExtraOrigins.push(parsedOrigin);
  }
  const allowedOrigins = Array.from(
    new Set([
      parsedBaseUrl.origin,
      ...DEFAULT_MCP_CLIENT_ORIGINS,
      ...parsedExtraOrigins.map((origin) => origin.origin),
    ]),
  );

  const trustProxyRaw = env["MCP_HTTP_TRUST_PROXY"] ?? "1";
  const trustProxy = Number(trustProxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
    return {
      error: `MCP_HTTP_TRUST_PROXY must be an integer in 0..10 (got ${JSON.stringify(trustProxyRaw)}). Use 1 for Cloud Run / single-proxy fronts, 2+ for multi-hop ingress, 0 for bare-IP deployments.`,
    };
  }

  return {
    ok: { publicBaseUrl, signingKey, port, jsonLimit, allowedOrigins, trustProxy },
  };
}
