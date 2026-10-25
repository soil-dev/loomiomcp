/**
 * Pure config / mode-selection helpers for the HTTP entry. Kept in a
 * separate module so tests can import them without triggering the
 * top-level server-startup code in `src/http.ts`.
 */

import { parseSharedEgressCidrs, type SharedEgress } from "./shared-egress.js";
import {
  DEFAULT_ANTHROPIC_REDIRECT_URIS,
  parseRedirectHosts,
  type RedirectPolicy,
} from "../auth/redirect-policy.js";
import { isIP } from "node:net";
import { signingKeyProblem } from "../auth/token.js";
import { isTruthyEnvValue } from "../env.js";

// Defined beside the open-DCR redirect policy that also allows them; re-exported
// here because static-client mode defaults MCP_OAUTH_REDIRECT_URIS to them.
export { DEFAULT_ANTHROPIC_REDIRECT_URIS };

/** FixedClientStore's floor; checked here so a short secret is a FATAL line, not a stack trace. */
const MIN_STATIC_CLIENT_SECRET_CHARS = 16;

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

/** True for an address only this machine can reach: 127.0.0.0/8, ::1 (also v4-mapped), `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/**
 * Where the HTTP server listens (security review F-10).
 *
 * WHY. v0.0.16 called `app.listen(port)` — every interface — while the
 * INSECURE_AUTO_APPROVE acknowledgement and the b3 refusal were waived
 * whenever PUBLIC_BASE_URL was loopback. A "local" open-DCR deployment
 * (with the b3 admin tools, if configured) was therefore served to the
 * whole LAN, sidestepping a refusal SECURITY.md says has no override.
 * Now the bind follows the URL: a loopback PUBLIC_BASE_URL listens on
 * that loopback host only; `MCP_HTTP_BIND` overrides (a container must
 * listen on 0.0.0.0 for `-p` to reach it), and a non-loopback bind
 * forfeits the loopback waivers (`localOnly`). A non-loopback URL keeps
 * v0.0.16's every-interface bind (Cloud Run requires it).
 *
 * `host` undefined = Node's default (all interfaces, dual-stack).
 */
export interface BindTarget {
  host: string | undefined;
  loopback: boolean;
}

export function resolveBind(
  env: NodeJS.ProcessEnv,
  publicBaseUrl: string | undefined,
): { ok: BindTarget } | { error: string } {
  const raw = env["MCP_HTTP_BIND"]?.trim();
  if (raw) {
    const host = raw.replace(/^\[(.*)\]$/, "$1");
    if (host !== "localhost" && isIP(host) === 0) {
      return {
        error:
          `MCP_HTTP_BIND must be an IP address (e.g. 127.0.0.1, 0.0.0.0, ::) or localhost ` +
          `(got ${JSON.stringify(raw.slice(0, 64))}).`,
      };
    }
    return { ok: { host, loopback: isLoopbackHost(host) } };
  }
  if (publicBaseUrl && URL.canParse(publicBaseUrl)) {
    const hostname = new URL(publicBaseUrl).hostname;
    if (isLocalHostname(hostname)) {
      return { ok: { host: hostname.replace(/^\[|\]$/g, ""), loopback: true } };
    }
  }
  return { ok: { host: undefined, loopback: false } };
}

/**
 * True when nobody but this machine can reach the server: a loopback
 * PUBLIC_BASE_URL AND a loopback bind. The two waivers that used to key
 * on the URL alone (open-DCR acknowledgement, b3 refusal) key on this.
 */
export function isLocalOnly(env: NodeJS.ProcessEnv, publicBaseUrl: string | undefined): boolean {
  if (publicBaseUrl === undefined || !isLocalhostUrl(publicBaseUrl)) return false;
  const bind = resolveBind(env, publicBaseUrl);
  return "ok" in bind && bind.ok.loopback;
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
    if (CLIENT_SECRET.length < MIN_STATIC_CLIENT_SECRET_CHARS) {
      return {
        error: `MCP_OAUTH_CLIENT_SECRET must be at least ${MIN_STATIC_CLIENT_SECRET_CHARS} characters (got ${CLIENT_SECRET.length}).`,
      };
    }
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
    const acknowledged = env["MCP_OAUTH_I_KNOW_WHAT_IM_DOING"]?.toLowerCase() === "yes";
    if (!isLocalOnly(env, publicBaseUrl) && !acknowledged) {
      // F-10: a loopback URL with a non-loopback MCP_HTTP_BIND is as reachable as a public one.
      const why =
        publicBaseUrl !== undefined && isLocalhostUrl(publicBaseUrl)
          ? "MCP_OAUTH_INSECURE_AUTO_APPROVE is set and MCP_HTTP_BIND listens beyond loopback. "
          : "MCP_OAUTH_INSECURE_AUTO_APPROVE is set but PUBLIC_BASE_URL is not a localhost address. ";
      return {
        error:
          why +
          "This mode lets anyone who can reach the URL register an OAuth client and use the shared " +
          "Loomio API key; it must not be exposed publicly. Either:\n" +
          "  - Point PUBLIC_BASE_URL at http://localhost or http://127.0.0.1 and leave MCP_HTTP_BIND unset (recommended), or\n" +
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
 * The open-DCR redirect policy (src/auth/redirect-policy.ts, review F-09):
 * MCP_OAUTH_REDIRECT_HOSTS lists extra https hosts a self-registered
 * client may redirect to (exact hostnames, comma-separated; `*` = any https
 * host, which re-opens the open redirect). Static-client mode ignores it —
 * its URIs come from MCP_OAUTH_REDIRECT_URIS.
 */
export function resolveRedirectPolicy(
  env: NodeJS.ProcessEnv = process.env,
): { ok: RedirectPolicy } | { error: string } {
  return parseRedirectHosts(env["MCP_OAUTH_REDIRECT_HOSTS"]);
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
  // F-10: the localhost waiver needs a loopback bind too, not just a loopback URL.
  if (isLocalOnly(env, publicBaseUrl)) return undefined;
  return (
    "LOOMIO_B3_API_KEY is set on an open-DCR deployment (MCP_OAUTH_INSECURE_AUTO_APPROVE with a " +
    "non-localhost PUBLIC_BASE_URL or a non-loopback MCP_HTTP_BIND) and read-only mode is off, so every self-registered OAuth " +
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

/**
 * The startup warning for the one topology the F-12 default (trust no
 * proxy) gets wrong on its own: Cloud Run — which sets `K_SERVICE` in
 * every container — terminates TLS in its front end, so with
 * MCP_HTTP_TRUST_PROXY=0 every caller arrives from the front end's
 * address and ALL callers share one rate-limit and daily-quota bucket.
 * Not an automatic switch: the variable is only a hint, and trusting a
 * header is a decision the operator states (DEPLOY.md).
 */
export function trustProxyWarning(env: NodeJS.ProcessEnv, trustProxy: number): string | undefined {
  if (trustProxy !== 0 || !env["K_SERVICE"]) return undefined;
  return (
    "K_SERVICE is set (Cloud Run) but MCP_HTTP_TRUST_PROXY is 0: every caller reaches this " +
    "process through Google's front end, so all of them share ONE rate-limit and quota bucket. " +
    "Set MCP_HTTP_TRUST_PROXY=1 (the default before v0.0.17)."
  );
}

export interface BaseConfig {
  publicBaseUrl: string;
  signingKey: string;
  /** Startup WARNING for a 16–31-character key inside its grace period (nit 3). */
  signingKeyWarning?: string;
  port: number;
  /** Body cap in bytes for POST /mcp (express.json AND the SDK transport) — MCP_HTTP_JSON_LIMIT. */
  jsonLimit: number;
  allowedOrigins: string[];
  trustProxy: number;
  bind: BindTarget;
  /** MCP_SHARED_EGRESS_CIDRS, when set (src/http/shared-egress.ts). */
  sharedEgress?: SharedEgress;
}

/**
 * Default body cap (security review F-14; maintainer decision 5). v0.0.16's
 * 1 MB let one slow, partial body pin four times the memory per request.
 * The trade-off, stated exactly: the largest LEGAL tool input is a
 * 100 000-character body (`TEXT_MAX.body` in src/tools/_common.ts,
 * Loomio's own max_message_length) — ~100 KB of ASCII, up to ~300 KB of
 * UTF-8 for CJK text, ~600 KB when a client \u-escapes non-ASCII. Every
 * read tool's input fits in a few KB, so read-only deployments never meet
 * the cap; a write-enabled deployment whose users post long non-Latin text
 * sets MCP_HTTP_JSON_LIMIT=1mb (DEPLOY.md). An over-cap POST /mcp is a
 * JSON-RPC 413 (src/http/transport.ts), not a bare transport failure.
 */
export const DEFAULT_JSON_LIMIT = "256kb";

/**
 * Parse a body-size knob the way body-parser's `bytes` does for the forms
 * worth supporting: an integer or decimal with an optional b / kb / mb
 * unit (1024-based, case-insensitive). Anything else is undefined, so a
 * typo is a FATAL line instead of body-parser's own silent fallback.
 */
export function parseByteSize(raw: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const unit = (m[2] ?? "b").toLowerCase();
  const factor = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const bytes = Math.floor(Number(m[1]) * factor);
  return bytes >= 1 ? bytes : undefined;
}

/** Non-negative integer knobs validated at startup (src/env.ts reads them leniently on hot paths). */
const NON_NEGATIVE_INT_KNOBS = [
  "MCP_HTTP_UPSTREAM_BUDGET",
  "MCP_HTTP_UPSTREAM_PER_5MIN",
  "MCP_DAILY_TOOL_CALLS",
  "MCP_DAILY_RESULT_BYTES",
] as const;

export type BaseConfigResult = { ok: BaseConfig } | { error: string };

export function resolveBaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): BaseConfigResult {
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
  const isHttps = parsedBaseUrl.protocol === "https:";
  // Exactly the hosts the SDK's issuer check exempts from https
  // (router.js checkIssuerUrl): http://[::1] passed here before and then
  // crashed the SDK with a stack trace ("Issuer URL must be HTTPS").
  const isHttpLocal =
    parsedBaseUrl.protocol === "http:" &&
    (parsedBaseUrl.hostname === "localhost" || parsedBaseUrl.hostname === "127.0.0.1");
  if (!isHttps && !isHttpLocal) {
    return {
      error: `PUBLIC_BASE_URL must be https://… (or http://localhost / http://127.0.0.1 for development); got ${parsedBaseUrl.protocol}//${parsedBaseUrl.hostname}.`,
    };
  }
  // RFC 8414 issuers carry no query or fragment; the SDK throws on either.
  if (parsedBaseUrl.search || parsedBaseUrl.hash || /[?#]/.test(publicBaseUrl)) {
    return { error: "PUBLIC_BASE_URL must not contain a query string or fragment." };
  }

  const signingKey = env["MCP_OAUTH_SIGNING_KEY"];
  // ≥ 32 chars; 16–31 (v0.0.16's floor) start with a warning until the
  // legacy sunset so the upgrade logs nobody out (nit 3, review round 1).
  const keyProblem = signingKeyProblem(signingKey, now);
  if (!signingKey || (keyProblem && "error" in keyProblem)) {
    return {
      error:
        keyProblem && "error" in keyProblem
          ? keyProblem.error
          : "MCP_OAUTH_SIGNING_KEY must be set.",
    };
  }
  const signingKeyWarning = keyProblem && "warning" in keyProblem ? keyProblem.warning : undefined;

  const portRaw = env["PORT"] ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      error: `PORT must be an integer in 1..65535 (got ${JSON.stringify(portRaw)}).`,
    };
  }

  const jsonLimitRaw = env["MCP_HTTP_JSON_LIMIT"]?.trim() || DEFAULT_JSON_LIMIT;
  const jsonLimit = parseByteSize(jsonLimitRaw);
  if (jsonLimit === undefined) {
    return {
      error: `MCP_HTTP_JSON_LIMIT must be a size such as 256kb, 1mb or 65536 (got ${JSON.stringify(jsonLimitRaw.slice(0, 32))}).`,
    };
  }
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

  // Default 0 (security review F-12): v0.0.16 defaulted to 1, which made
  // req.ip the last X-Forwarded-For entry whenever the header was present —
  // right behind exactly one appending proxy (Cloud Run), but on a bare
  // host or `docker run` every caller picked its own rate-limit bucket
  // with one header. Trusting a proxy is now an explicit deployment fact.
  const trustProxyRaw = env["MCP_HTTP_TRUST_PROXY"]?.trim() || "0";
  const trustProxy = Number(trustProxyRaw);
  if (!/^\d+$/.test(trustProxyRaw) || trustProxy > 10) {
    return {
      error: `MCP_HTTP_TRUST_PROXY must be an integer in 0..10 (got ${JSON.stringify(trustProxyRaw.slice(0, 32))}). Use 1 for Cloud Run / single-proxy fronts, 2+ for multi-hop ingress, 0 (the default) when clients connect directly.`,
    };
  }

  const bind = resolveBind(env, publicBaseUrl);
  if ("error" in bind) return bind;

  // The upstream-cost and quota knobs: read leniently on hot paths
  // (src/env.ts), so a malformed value must be refused HERE or it would
  // silently fall back to the default.
  for (const name of NON_NEGATIVE_INT_KNOBS) {
    const raw = env[name]?.trim();
    if (raw && !/^\d{1,15}$/.test(raw)) {
      return {
        error: `${name} must be a non-negative integer, 0 = off (got ${JSON.stringify(raw.slice(0, 32))}).`,
      };
    }
  }
  const concurrencyRaw = env["MCP_HTTP_UPSTREAM_CONCURRENCY"]?.trim();
  if (concurrencyRaw && (!/^\d{1,4}$/.test(concurrencyRaw) || Number(concurrencyRaw) < 1)) {
    return {
      error: `MCP_HTTP_UPSTREAM_CONCURRENCY must be an integer in 1..9999 (got ${JSON.stringify(concurrencyRaw.slice(0, 32))}).`,
    };
  }

  // Round-2 finding: hosted-Claude users share one egress address; see
  // src/http/shared-egress.ts. A malformed range must not start (it would
  // silently fold every client of the address into one bucket again).
  const egress = parseSharedEgressCidrs(env["MCP_SHARED_EGRESS_CIDRS"]);
  if ("error" in egress) return egress;

  return {
    ok: {
      publicBaseUrl,
      signingKey,
      ...(signingKeyWarning ? { signingKeyWarning } : {}),
      port,
      jsonLimit,
      allowedOrigins,
      trustProxy,
      bind: bind.ok,
      ...(egress.ok ? { sharedEgress: egress.ok } : {}),
    },
  };
}
