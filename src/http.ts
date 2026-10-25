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
 *     Optional: MCP_OAUTH_REDIRECT_HOSTS (extra https redirect hosts for
 *     self-registered clients; src/auth/redirect-policy.ts).
 *
 * Required env in all modes:
 *   LOOMIO_API_KEY        Loomio API key (sent as an Authorization: Bearer header)
 *   PUBLIC_BASE_URL       Public origin where this server is reachable
 *   MCP_OAUTH_SIGNING_KEY HMAC key for OAuth tokens (>=32 chars; stable
 *                         across instances)
 *
 * Endpoints besides the OAuth set and POST /mcp:
 *   GET /health          Unauthenticated key-health check — 200 when the
 *                         Loomio API key is accepted, 503 otherwise. Point
 *                         an uptime checker at it (see DEPLOY.md).
 *
 * Optional env:
 *   PORT                  Listen port (default 8080; Cloud Run injects)
 *   MCP_HTTP_BIND         Listen address. Default: the loopback host of a
 *                         loopback PUBLIC_BASE_URL, else all interfaces.
 *                         A non-loopback bind forfeits the localhost
 *                         waivers (src/http/config.ts resolveBind, F-10).
 *   LOOMIO_MCP_READONLY   Same semantics as the stdio server
 *   MCP_HTTP_JSON_LIMIT   Body size cap for POST /mcp (default '256kb')
 *   MCP_HTTP_TRUST_PROXY  Number of proxy hops to trust (default 0; set 1
 *                         behind exactly one appending proxy, e.g. Cloud Run).
 *   MCP_HTTP_UPSTREAM_BUDGET       Loomio calls one POST /mcp may start (default 120; 0 = off).
 *   MCP_HTTP_UPSTREAM_CONCURRENCY  Concurrent Loomio calls per process (default 16).
 *   MCP_DAILY_TOOL_CALLS / MCP_DAILY_RESULT_BYTES  Open-DCR per-source daily
 *                         quotas (default 5000 / 500000000; 0 = off).
 *   MCP_SHARED_EGRESS_CIDRS  Ranges many users share (hosted Claude's
 *                         egress): keyed per client as well for the daily
 *                         quotas and the upstream share (src/http/shared-egress.ts).
 *   LOOMIO_MCP_LOG_VERBOSE  Set to 1 / true / yes / on to emit structured events.
 *   LOOMIO_B3_API_KEY     Server-instance admin secret. When set (and not
 *                         read-only), registers the nine b3 tools: user
 *                         deactivate / reactivate / get / list and, on
 *                         Loomio 3.13+, instance-wide group and roster
 *                         reads and membership writes (B3_TOOL_NAMES in
 *                         src/http/config.ts). Single-tenant only — read
 *                         SECURITY.md. Refused at startup in
 *                         insecure-auto-approve mode on a non-localhost
 *                         PUBLIC_BASE_URL (b3ExposureError).
 */

import type { AddressInfo } from "node:net";
import { buildHttpRuntime } from "./http/runtime.js";
import { checkLoomioHealth, keyRejectedWarning } from "./loomio/health.js";

function fatal(message: string): never {
  console.error(`[loomiomcp] FATAL: ${message}`);
  process.exit(1);
}

// Every startup decision — the refusals of F-02 / F-09 / F-17, the
// open-DCR mode switch, the startup lines — lives in buildHttpRuntime
// (src/http/runtime.ts) so tests can pin it; this file only listens,
// prints and probes.
const runtime = buildHttpRuntime(process.env);
if ("fatal" in runtime) fatal(runtime.fatal);
const { server, port, bind } = runtime;

const onListening = (): void => {
  console.log(runtime.listeningLine(server.address() as AddressInfo | null));
  for (const line of runtime.startupLines) {
    if (line.level === "warn") console.warn(line.text);
    else console.log(line.text);
  }

  // Probe the Loomio key once we are listening — non-blocking, and the
  // server keeps serving whatever the verdict. A rejected key must be
  // LOUD at startup (it is the most common silent-failure mode: the key
  // was rotated under us) but not fatal: /health and per-call 403s
  // stay diagnosable, whereas a crash-looping container tells the
  // operator nothing. A transient network error at boot likewise must
  // not take the server down. The probe also emits the forced
  // `loomio.auth` event and caches its result for /health.
  checkLoomioHealth()
    .then((health) => {
      console.log(
        `[loomiomcp] Loomio key_status=${health.key_status} loomio_version=${health.loomio_version ?? "unknown"}`,
      );
      if (health.key_status === "rejected") {
        console.warn(`[loomiomcp] WARNING: ${keyRejectedWarning()}`);
      } else if (health.key_status === "unreachable") {
        console.warn(
          `[loomiomcp] WARNING: could not verify the Loomio API key at startup: ${health.detail ?? "unknown error"}. ` +
            "Serving anyway; GET /health re-probes (cached 60 s).",
        );
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[loomiomcp] WARNING: key-health probe failed at startup: ${message}`);
    });
};

// `bind.host` undefined = every interface (a non-loopback PUBLIC_BASE_URL
// with no MCP_HTTP_BIND, e.g. Cloud Run) — see resolveBind (F-10).
server.on("error", (err: NodeJS.ErrnoException) => {
  fatal(`cannot listen on ${bind.host ?? "*"}:${port} (${err.code ?? err.name}).`);
});
if (bind.host === undefined) server.listen(port, onListening);
else server.listen(port, bind.host, onListening);
