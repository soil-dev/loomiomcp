/**
 * HTTP entry — for remote-connector deployments (Cloud Run, etc.).
 *
 * Runs the same MCP server the stdio entry does, but exposes it on
 * HTTP via StreamableHTTPServerTransport so Claude.ai's Custom
 * Connector feature can reach it.
 *
 * Two OAuth modes are supported, selected by env-var presence:
 *
 *   - static-client (default, recommended for any public deployment):
 *     Required env: MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET.
 *     Optional: MCP_OAUTH_REDIRECT_URIS.
 *
 *   - insecure-auto-approve (opt-in, for local / private-network use):
 *     Required env: MCP_OAUTH_INSECURE_AUTO_APPROVE=1.
 *
 * Required env in all modes:
 *   LOOMIO_API_KEY        Loomio API key (passed as ?api_key=... on outbound calls)
 *   PUBLIC_BASE_URL       Public origin where this server is reachable
 *   MCP_OAUTH_SIGNING_KEY HMAC key for OAuth tokens (>=16 chars; stable
 *                         across instances)
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects)
 *   LOOMIO_MCP_READONLY   Same semantics as the stdio server
 *   MCP_HTTP_JSON_LIMIT   Body size cap for inbound JSON (default '1mb')
 *   MCP_HTTP_TRUST_PROXY  Number of proxy hops to trust (default 1).
 *   LOOMIO_MCP_LOG_VERBOSE  Set to 1 / true / yes / on to emit structured events.
 *   LOOMIO_B3_API_KEY     Server-instance admin secret. When set, registers
 *                         deactivate_user / reactivate_user. Read SECURITY.md
 *                         before setting this on a multi-user deployment.
 */

import { isReadOnly } from "./loomio/client.js";
import { OAuthProvider, InMemoryClientsStore, FixedClientStore } from "./auth/provider.js";
import { resolveBaseConfig, selectMode } from "./http/config.js";
import { createApp } from "./http/app.js";

function fatal(message: string): never {
  console.error(`[loomiomcp] FATAL: ${message}`);
  process.exit(1);
}

if (!process.env["LOOMIO_API_KEY"]) {
  fatal(
    "LOOMIO_API_KEY environment variable is not set. " +
      "Generate one in Loomio under your profile → API keys.",
  );
}

const baseResult = resolveBaseConfig();
if ("error" in baseResult) fatal(baseResult.error);
const { publicBaseUrl, signingKey, port, jsonLimit, trustProxy } = baseResult.ok;

const modeResult = selectMode(process.env, publicBaseUrl);
if ("error" in modeResult) fatal(modeResult.error);
const mode = modeResult.ok;

const issuerUrl = new URL(publicBaseUrl);
const mcpResourceUrl = new URL("/mcp", issuerUrl);

const oauthProvider =
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
        clientsStore: new InMemoryClientsStore(),
        signingKey,
        resourceUrl: mcpResourceUrl,
      });

const app = createApp({
  oauthProvider,
  issuerUrl,
  jsonLimit,
  allowedOrigins: baseResult.ok.allowedOrigins,
  trustProxy,
});

app.listen(port, () => {
  const readMode = isReadOnly() ? "read-only" : "read-write";
  const authLabel = mode.kind === "static-client" ? "static-client" : "INSECURE_AUTO_APPROVE";
  console.log(
    `[loomiomcp] HTTP server listening on :${port} | mode=${readMode} | auth=${authLabel} | issuer=${issuerUrl}`,
  );
  if (mode.kind === "insecure-auto-approve") {
    console.warn(
      "[loomiomcp] WARNING: auth mode is INSECURE_AUTO_APPROVE. " +
        "Anyone who can reach this URL can register a client and use the configured Loomio API key. " +
        "Suitable only for local development or private-network deployments.",
    );
  }
});
