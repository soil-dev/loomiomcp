# Deploying loomiomcp

Two supported deployment shapes: local stdio (read-write, for one user)
and Cloud Run HTTP (typically read-only, multi-user via OAuth).

## Local stdio

```
LOOMIO_API_KEY=… loomiomcp
```

Wire it into your MCP host (Claude Desktop, Claude Code, etc.) as a
stdio server. The host launches the process; the API key stays on your
machine.

To run in read-only mode: also set `LOOMIO_MCP_READONLY=1`. Only the
14 read tools are registered; the 10 write tools and the 4 b3 tools are
not even visible to the MCP host. See [README.md](README.md) for the
full tool catalog and which tools are reads vs writes.

## Cloud Run (HTTP)

The HTTP entry exposes the same MCP server over OAuth 2.1 (RFC 7591)
so Claude.ai's Custom Connector can reach it.

Open-DCR client registrations and access/refresh tokens are stateless:
they are signed with `MCP_OAUTH_SIGNING_KEY`, so clients survive
restarts, scale-to-zero, redeploys, and multi-instance routing. The only
remaining process-local OAuth state is the short-lived pending
authorization code (5-minute TTL), so the initial authorize→token
exchange should complete on one instance; signing those codes too is the
remaining step for a fully instance-independent handshake.

Required env in any HTTP deployment:

| Variable | What it is |
|---|---|
| `LOOMIO_API_KEY` | Loomio API key. Shared by every authenticated MCP caller hitting this deployment. |
| `LOOMIO_API_BASE_URL` | Loomio API root. Defaults to `https://www.loomio.com/api`. Set to e.g. `https://loomio.example.org/api` for a self-hosted instance. Override is gated to `https://` or loopback `http://` so the API key (sent as a bearer header) can't leak to a plaintext host. The same value minus `/api` is the base of every `url` the tools return. |
| `PUBLIC_BASE_URL` | Public origin of the service, e.g. a custom domain `https://mcp.example.org` or the raw `https://loomiomcp-xyz.run.app`. Must match the URL clients fetch — it's the OAuth metadata issuer (RFC 8414). |
| `MCP_OAUTH_SIGNING_KEY` | HMAC key for OAuth tokens (≥16 chars, stable across instances). |

OAuth mode (pick one):

- **Open DCR (anyone who can reach the URL can register a client).**
  Set `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`. The server refuses to start
  in this mode on a non-loopback `PUBLIC_BASE_URL` unless you also set
  `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes`. Use this when the upstream
  identity is intentionally public — e.g. a read-only bot scoped to
  open community discussions. This is the recommended mode for a public,
  read-only community connector (see [Reference deployment](#reference-deployment)).
  The per-IP rate limit (below) is the abuse bound in this mode, so keep
  it set. Read SECURITY.md first: with Loomio ≥ 3.8 the shared user can
  list and search every public group's public content on the instance,
  and the participation report exposes per-member activity counts for
  every group it is in.
- **Static client (lock-down alternative).** Set both
  `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`. DCR is disabled;
  the client_secret is the real auth boundary, so only people you hand
  the secret to can connect. Optionally set `MCP_OAUTH_REDIRECT_URIS`
  (comma-separated); defaults to Anthropic's known callback URIs. Use
  this when the upstream identity (`LOOMIO_API_KEY`) sees data you
  wouldn't want an anonymous caller to see.

For either mode, set `LOOMIO_MCP_READONLY=1` on any public deployment.
Writes (especially `manage_memberships` and the `delete_*` tools) using
a shared API key across many unrelated callers are hard to audit — Loomio
attributes every write to the connector's user, whoever asked for it.
The reference deployment combines open-DCR + readonly to make "available
to anyone, can't write anything" explicit.

Other env:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Cloud Run injects). |
| `MCP_HTTP_JSON_LIMIT` | `1mb` | Request body cap. |
| `MCP_HTTP_TRUST_PROXY` | `1` | `app.set("trust proxy", …)`. `1` is correct for Cloud Run. |
| `MCP_ALLOWED_ORIGINS` | unset | Extra browser origins (comma-separated, `https://` or loopback `http://`) allowed alongside `PUBLIC_BASE_URL`'s origin and `https://claude.ai`. Only needed for a browser-based MCP client on another origin. |
| `MCP_HTTP_RATE_LIMIT_MAX` | `600` | Request cap per window, keyed on the **source IP** (not the OAuth client_id — under open DCR a caller can mint unlimited client_ids, so IP is the only sound key). Tighten on open-DCR deployments; the reference deployment uses 300. Per-call upstream cost is bounded separately: every read is one Loomio call except `get_user_activity` (one report call per requested group, ≤ 50, 4 in flight, plus one search). The same config applies to `GET /health`, in a separate bucket. |
| `MCP_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `MCP_HTTP_RATE_LIMIT_DISABLED` | unset | Set to `1` to disable rate limiting entirely (only useful for local dev). |
| `MCP_HTTP_DEBUG` | unset | Set to `1` to include the error message (not just its class and status) in the `[loomiomcp] /mcp error:` stderr line. Off by default because that message can quote clipped upstream text. |
| `LOOMIO_MCP_LOG_VERBOSE` | unset | When `1`, emits structured JSON events to stderr (Cloud Run auto-parses). See OPTIMIZATIONS.md. The key-health events `loomio.auth` and `loomio.version_drift` are **forced** — they are emitted regardless of this flag. |
| `LOOMIO_MCP_HEALTH_PATH` | `/health` | Where the health page is served. Change it only if the hosting front-end reserves `/health` too (Cloud Run's frontend is known to reserve `/healthz`, which is why the default is `/health`; see the health-check section below); point the uptime check at the same path. Must be an absolute path with no query string. |
| `LOOMIO_B3_API_KEY` | unset | Server-instance admin secret. When set (and the server is not read-only), registers `deactivate_user`, `reactivate_user`, `get_user` and `list_users` — the last two return **email addresses** for every account on the instance. **Do not set on a multi-user deployment** — see SECURITY.md. |

Tool count per mode: read-only 14, full 24, full + b3 28. The
`tools/list` a client receives is pinned per mode by
`tests/readonly.test.ts`.

Build and deploy (open-DCR + read-only, matching the reference deployment):

```
docker build -t loomiomcp .
gcloud run deploy loomiomcp --image … --set-env-vars \
  LOOMIO_API_KEY=…,PUBLIC_BASE_URL=https://mcp.example.org,MCP_OAUTH_SIGNING_KEY=…,\
  MCP_OAUTH_INSECURE_AUTO_APPROVE=1,MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes,\
  MCP_HTTP_RATE_LIMIT_MAX=300,LOOMIO_MCP_READONLY=1,LOOMIO_MCP_LOG_VERBOSE=1
```

For static-client mode instead, drop the three `MCP_OAUTH_INSECURE_*` /
`_I_KNOW_*` vars and set `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET`.
The production stack is managed by Pulumi, not this raw command — see
[Reference deployment](#reference-deployment).

## Health check: `GET /health`

Besides the OAuth endpoints and `POST /mcp`, the HTTP server serves an
**unauthenticated** `GET /health` that answers one question: does
Loomio still accept the connector's API key?

```json
{
  "status": "ok",
  "connector_version": "0.0.12",
  "key_status": "valid",
  "loomio_version": "3.8.1",
  "checked_at": "2026-09-20T10:00:00.000Z"
}
```

- **HTTP 200** iff `key_status` is `valid`; **503** with
  `status: "degraded"` for `rejected` (Loomio answered the probe 403
  with its unauthenticated body — the key is dead) and `unreachable`
  (network error, timeout, 5xx, or a CDN/WAF 403 that never reached
  Loomio — the key's state is unknown). 503 for both so a checker rule
  of "HTTP 200 and body contains `"key_status":"valid"`" is the whole
  alert.
- `Cache-Control: no-store` — a cached 200 would defeat the point.
- The probe behind it (`GET /api/b2/groups` with the key, plus the
  public `GET /api/v1/boot/version`) is **cached for 60 s** and shared
  between concurrent callers, so a flood of `/health` hits costs Loomio
  at most one request pair per minute. The endpoint is also under the
  per-IP rate limiter (same `MCP_HTTP_RATE_LIMIT_*` config as `/mcp`,
  separate bucket). The `check_connection` tool forces the same probe
  and reuses its groups body, so it costs the same request pair.
- It exposes exactly the five fields above: no key material, no error
  detail (which could quote the base URL), no Loomio hostname, none of
  the groups the probe learned.
- The same probe runs once at startup (after `listen`) and logs
  `[loomiomcp] Loomio key_status=… loomio_version=…`, with a WARNING
  paragraph when the key is rejected. The server keeps serving either
  way — a crash-looping container tells you nothing; a live one with a
  red `/health` and classified 403s tells you everything.
- **Verify the path reaches the container before trusting an alert.**
  Some hosting front-ends reserve `/healthz` (Cloud Run's does) and answer it with their
  own 404 before the request reaches the container (this has been
  observed on Cloud Run's `*.run.app` URL). An uptime check against such
  a path fails closed forever — 404 is not 200 and has no content match
  — and the one thing the check exists to detect stays undetected while
  the alert trains everyone to ignore it. After deploying, `curl -si
  https://<PUBLIC_BASE_URL>/health` and confirm the body is the
  connector's JSON (`connector_version`, `key_status`), not an HTML
  page. If it is the platform's 404, set `LOOMIO_MCP_HEALTH_PATH` (e.g.
  `/-/health`) on the deployment and point the checker at that path;
  the default page is then no longer served.

**Recommended monitoring.** Create an uptime check (Cloud Monitoring, or
any external checker) against `https://<PUBLIC_BASE_URL>/health` every
**5 minutes**, protocol HTTPS, expecting **HTTP 200** *and* a content
match on `"key_status":"valid"`, with an alert policy that notifies a
channel someone reads. Connector traffic is often too sparse for a
log-based error-rate alert to ever have enough samples; the active probe
is what turns a silent 403 outage into an alert within minutes. As a
second signal, alert on the forced log event `loomio.auth` with
`key_status != "valid"` (it fires on every status change), and note
`loomio.version_drift` — it means the instance moved to a Loomio
`major.minor` this connector has not been verified against.

## API key lifecycle (runbook)

The Loomio API key is not a permanent credential. Loomio regenerates a
user's key:

- **whenever that user's password changes** (Loomio ≥ 3.1.0;
  `UserService.rotate_credentials_after_password_change` also rotates the
  user's other tokens and signs out other sessions) — the API access page
  in Loomio says so;
- **once for every user, on the upgrade to Loomio 3.3.1** (August 2026;
  migration `RotateExposedUserApiKeys`, because group data exports had
  contained keys);
- when the account is redacted, and — for authentication purposes —
  when the user is deactivated (`User.active` no longer matches).

**Symptom.** Every call fails with
`403 {"error":"You are not authorized to access this page."}` — the
same body for every endpoint, because `authenticate_api_key!` runs before
anything else. Nothing else is wrong; the process is up. The connector
recognises this body and says "key rejected, probably rotated" with the
steps below; on the HTTP transport `/health` goes 503 with
`key_status: "rejected"`, the startup log / stderr carries the same
warning, and `check_connection` reports it to the AI caller with the
remediation in `notes`.

**Check.** `GET /health` on the connector, or directly
`GET https://<loomio>/api/b2/groups` with
`Authorization: Bearer <key>` — 200 means the key is valid (even for a
user with no groups), 403 means it is not.

**Fix.**

1. Sign in to Loomio **as the connector's user** and open the **API
   access** page (`/profile/api_access`). It shows the current key. No
   API can read another user's key — the b3 Server API's user payload
   does not include it, and the User API only ever authenticates with
   the caller's own — so this step needs that user's login (or an
   instance admin's "sign in as" if the instance offers it).
2. Put the new value in the deployment's secret (`LOOMIO_API_KEY`) and
   redeploy / restart. Outstanding OAuth tokens stay valid — they prove
   caller identity to the connector, not to Loomio.
3. Confirm `/health` returns 200 with `"key_status":"valid"`.

**Avoid the next one.** Do not change the connector user's password
casually — pair any password change with the secret rotation above in
one change. Read Loomio's release notes before the instance upgrades
(the 3.3.1 notes announced the rotation; Loomio has no other
compatibility policy). Keep the uptime check above in place so a
rotation you did not cause is noticed in minutes, not weeks.

To invalidate every outstanding OAuth token at once, rotate
`MCP_OAUTH_SIGNING_KEY` — every issued token becomes unverifiable.

## Loomio behind a CDN / WAF

Every outbound request carries `User-Agent: loomiomcp/<version>`. If the
Loomio instance sits behind Cloudflare or another WAF that blocks
non-browser user-agents, allow that one. The connector tells a WAF 403
apart from a Loomio 403 (Loomio's are always JSON; Cloudflare's problem
body names cloudflare) and reports it as "blocked in front of Loomio —
check WAF rules", with `/health` showing `unreachable` rather than
`rejected`.

## Reference deployment

The connector is designed for Cloud Run (or any container host) behind
its own OAuth-at-the-edge layer, with `LOOMIO_API_KEY` and
`MCP_OAUTH_SIGNING_KEY` held in a secret manager and injected as env
vars. A production-grade setup wires that up with an IaC tool (e.g.
Pulumi): KMS-backed secrets, bootstrap scripts for the API key /
signing key / OAuth client, an uptime check on `/health` with an alert
policy (see above), and a smoke test that walks the full OAuth dance
against the deployed endpoint **and** makes one round-trip to Loomio
through a tool call. `check_connection` is the natural smoke call —
it throws or reports `key_status` explicitly and costs one request pair
— or a shape-only assertion on `list_discussions` for a known group.
None of that is connector-specific beyond the env vars documented above.

## Image build

A `Dockerfile` ships in this repo for a direct `docker build`. For
local stdio use no container is needed at all — `npx loomiomcp` runs
the published package.
