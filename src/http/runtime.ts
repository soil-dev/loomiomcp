/**
 * Everything the HTTP entry does BEFORE it listens, as one testable
 * function (round-2 finding: src/http.ts had no test, so deleting — or
 * inverting — `setOpenDcrMode(...)` left all 981 tests green while
 * production lost the F-16 daily quotas and the nit-19 collapse; the
 * startup refusals of F-02 / F-09 / F-17 and the F-12 trust-proxy line
 * were equally unpinned).
 *
 * `buildHttpRuntime(env)` validates the configuration, sets the
 * process-wide deployment mode, and returns either ONE fatal line (never
 * quoting a secret) or the app, an unlistened server, where to bind, and
 * the startup lines to print. It does not listen, exit or probe; the
 * entry (src/http.ts) does those, so tests can call this directly.
 */

import type { AddressInfo } from "node:net";
import type express from "express";
import type { Server } from "node:http";
import { FixedClientStore, OAuthProvider, StatelessClientsStore } from "../auth/provider.js";
import { describeRedirectPolicy } from "../auth/redirect-policy.js";
import { DEFAULT_DAILY_RESULT_BYTES, DEFAULT_DAILY_TOOL_CALLS } from "../daily-quota.js";
import { setOpenDcrMode } from "../deployment.js";
import { readNonNegativeInt } from "../env.js";
import { isReadOnly } from "../loomio/client.js";
import { groupAllowlistError } from "../loomio/group-scope.js";
import { secretConfigError } from "../loomio/secrets.js";
import {
  resolveUpstreamBudget,
  resolveUpstreamConcurrency,
  resolveUpstreamPer5Min,
} from "../loomio/upstream.js";
import { createApp, createHttpServer } from "./app.js";
import {
  type BindTarget,
  b3ExposureError,
  b3ExposureWarning,
  resolveBaseConfig,
  resolveRedirectPolicy,
  selectMode,
  trustProxyWarning,
} from "./config.js";

export interface StartupLine {
  level: "log" | "warn";
  text: string;
}

export interface HttpRuntime {
  app: express.Express;
  /** Created with the F-14 receive deadlines; NOT listening yet. */
  server: Server;
  port: number;
  bind: BindTarget;
  /** Lines to print once listening, in order (the address line comes from `listeningLine`). */
  startupLines: StartupLine[];
  /** The first line, naming the address actually bound (F-10). */
  listeningLine(addr: AddressInfo | string | null): string;
}

const PREFIX = "[loomiomcp]";

/**
 * Validate `env`, set the deployment mode, and build the app. Reads
 * `env` for every startup decision; the hot-path knobs (upstream bounds,
 * quotas, read-only) are read from `process.env` at call time as
 * everywhere else, so callers pass `process.env` outside tests.
 */
export function buildHttpRuntime(
  env: NodeJS.ProcessEnv = process.env,
): HttpRuntime | { fatal: string } {
  if (!env["LOOMIO_API_KEY"]) {
    return {
      fatal:
        "LOOMIO_API_KEY environment variable is not set. " +
        "Generate one in Loomio under your profile → API keys.",
    };
  }
  // F-02: a credential a bearer header cannot carry is refused here with a
  // fixed message, instead of being echoed by undici into every tool error.
  const secretProblem = secretConfigError(env);
  if (secretProblem) return { fatal: secretProblem };
  // F-17: a malformed group allow-list must not start (and fail closed later).
  const groupProblem = groupAllowlistError(env);
  if (groupProblem) return { fatal: groupProblem };

  const baseResult = resolveBaseConfig(env);
  if ("error" in baseResult) return { fatal: baseResult.error };
  const { publicBaseUrl, signingKey, port, jsonLimit, trustProxy, bind, sharedEgress } =
    baseResult.ok;

  const modeResult = selectMode(env, publicBaseUrl);
  if ("error" in modeResult) return { fatal: modeResult.error };
  const mode = modeResult.ok;
  const openDcr = mode.kind === "insecure-auto-approve";

  // The b3 secret on an open-DCR public deployment would give every
  // self-registered client the instance-admin tools (see b3ExposureError).
  const b3Exposure = b3ExposureError(env, mode, publicBaseUrl);
  if (b3Exposure) return { fatal: b3Exposure };

  // Open-DCR redirect allow-list (F-09); a malformed MCP_OAUTH_REDIRECT_HOSTS is fatal.
  const redirectPolicyResult = resolveRedirectPolicy(env);
  if ("error" in redirectPolicyResult) return { fatal: redirectPolicyResult.error };
  const redirectPolicy = redirectPolicyResult.ok;

  const issuerUrl = new URL(publicBaseUrl);
  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  // Constructors re-check what config.ts validated; anything they still
  // refuse becomes the one fatal line, not a stack trace.
  let oauthProvider: OAuthProvider;
  try {
    oauthProvider =
      mode.kind === "static-client"
        ? new OAuthProvider({
            clientsStore: new FixedClientStore({
              clientId: mode.clientId,
              clientSecret: mode.clientSecret,
              redirectUris: mode.redirectUris,
              clientName: "loomiomcp pre-registered client",
            }),
            signingKey,
            resourceUrl: mcpResourceUrl,
          })
        : new OAuthProvider({
            // Stateless open-DCR store: registered clients survive restarts,
            // scale-to-zero, redeploys, and multi-instance routing, so callers
            // aren't forced to re-authenticate when the process recycles.
            clientsStore: new StatelessClientsStore(signingKey, redirectPolicy),
            signingKey,
            resourceUrl: mcpResourceUrl,
          });
  } catch (err) {
    return { fatal: err instanceof Error ? err.message : String(err) };
  }

  // Only now — every refusal above has returned — does the process take
  // on the mode. Tool code reads it for the open-DCR-only behaviours:
  // the daily quotas (F-16) and the collapsed hidden-vs-missing wording
  // (nit 19); see src/deployment.ts. Pinned by tests/http-runtime.test.ts.
  setOpenDcrMode(openDcr);

  const app = createApp({
    oauthProvider,
    issuerUrl,
    jsonLimit,
    allowedOrigins: baseResult.ok.allowedOrigins,
    trustProxy,
    ...(sharedEgress ? { sharedEgress } : {}),
  });

  const lines: StartupLine[] = [];
  const log = (text: string) => lines.push({ level: "log", text: `${PREFIX} ${text}` });
  const warn = (text: string) => lines.push({ level: "warn", text: `${PREFIX} WARNING: ${text}` });

  // A v0.0.16-era 16–31-character key: still served (no forced re-auth),
  // loudly, until the legacy sunset (nit 3, review round 1).
  if (baseResult.ok.signingKeyWarning) warn(baseResult.ok.signingKeyWarning);
  // F-12: the limiter keys depend on it; say what is trusted.
  log(
    trustProxy > 0
      ? `MCP_HTTP_TRUST_PROXY=${trustProxy}: client addresses are taken from X-Forwarded-For ` +
          `behind ${trustProxy} proxy hop(s). Correct only when exactly that many proxies append to it.`
      : "MCP_HTTP_TRUST_PROXY=0: client addresses are the TCP peers (X-Forwarded-For ignored).",
  );
  const proxyWarning = trustProxyWarning(env, trustProxy);
  if (proxyWarning) warn(proxyWarning);
  log(
    `upstream bounds: ${resolveUpstreamBudget() || "unlimited"} Loomio calls per HTTP request, ` +
      `${resolveUpstreamConcurrency()} concurrent per process, ` +
      `${resolveUpstreamPer5Min() || "unlimited"} per 5 minutes per process; body cap ${jsonLimit} bytes`,
  );
  if (sharedEgress) {
    log(`shared egress ranges (keyed per client as well): ${sharedEgress.cidrs.join(", ")}`);
  }
  if (openDcr) {
    const calls = readNonNegativeInt("MCP_DAILY_TOOL_CALLS", DEFAULT_DAILY_TOOL_CALLS);
    const bytes = readNonNegativeInt("MCP_DAILY_RESULT_BYTES", DEFAULT_DAILY_RESULT_BYTES);
    log(
      `daily quotas per source (per process): ${calls || "unlimited"} tool calls, ` +
        `${bytes || "unlimited"} result bytes`,
    );
    warn(
      "auth mode is INSECURE_AUTO_APPROVE. " +
        "Anyone who can reach this URL can register a client and use the configured Loomio API key. " +
        "Suitable only for local development or private-network deployments.",
    );
    log(`open-DCR redirect_uris allowed: ${describeRedirectPolicy(redirectPolicy)}`);
    if (redirectPolicy.httpsHosts === "*") {
      warn(
        "MCP_OAUTH_REDIRECT_HOSTS=* lets any self-registered client redirect " +
          "/authorize to any https site (an open redirect on this domain). List exact hosts instead.",
      );
    }
  }
  const b3Warning = b3ExposureWarning(env, mode);
  if (b3Warning) warn(b3Warning);

  const readMode = isReadOnly() ? "read-only" : "read-write";
  const authLabel = mode.kind === "static-client" ? "static-client" : "INSECURE_AUTO_APPROVE";

  return {
    app,
    // F-14: the server carries the receive deadlines (src/http/app.ts).
    server: createHttpServer(app),
    port,
    bind,
    startupLines: lines,
    listeningLine(addr) {
      // The address actually bound (F-10), so "local only" is checkable in the log.
      const where =
        addr && typeof addr === "object"
          ? `${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}:${addr.port}`
          : `:${port}`;
      return (
        `${PREFIX} HTTP server listening on ${where} | mode=${readMode} | auth=${authLabel} | ` +
        `issuer=${issuerUrl}`
      );
    },
  };
}
