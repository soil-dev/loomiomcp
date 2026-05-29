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
read tools are registered; write tools are not even visible to the MCP
host. See [README.md](README.md) for the full tool catalog and which
tools are reads vs writes.

## Cloud Run (HTTP)

The HTTP entry exposes the same MCP server over OAuth 2.1 (RFC 7591)
so Claude.ai's Custom Connector can reach it.

Current OAuth handshake state (open-DCR client registrations and pending
authorization codes) is in process memory. Access and refresh tokens are
stateless after issuance, but registration/authorization/token exchange
must complete on the same running instance. On Cloud Run, keep
`--max-instances=1` unless you add a shared OAuth store.

Required env in any HTTP deployment:

| Variable | What it is |
|---|---|
| `LOOMIO_API_KEY` | Loomio API key. Shared by every authenticated MCP caller hitting this deployment. |
| `LOOMIO_API_BASE_URL` | Loomio API root. Defaults to `https://www.loomio.com/api`. Set to e.g. `https://loomio.example.org/api` for a self-hosted instance. Override is gated to `https://` or loopback `http://` so the api_key (which travels as a query parameter) can't leak to a plaintext host. |
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
  it set.
- **Static client (lock-down alternative).** Set both
  `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`. DCR is disabled;
  the client_secret is the real auth boundary, so only people you hand
  the secret to can connect. Optionally set `MCP_OAUTH_REDIRECT_URIS`
  (comma-separated); defaults to Anthropic's known callback URIs. Use
  this when the upstream identity (`LOOMIO_API_KEY`) sees data you
  wouldn't want an anonymous caller to see.

For either mode, set `LOOMIO_MCP_READONLY=1` on any public deployment.
Writes (especially `manage_memberships`) using a shared API key across
many unrelated callers are hard to audit. The reference deployment
combines open-DCR + readonly to make "available to anyone, can't write
anything" explicit.

Other env:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Cloud Run injects). |
| `MCP_HTTP_JSON_LIMIT` | `1mb` | Request body cap. |
| `MCP_HTTP_TRUST_PROXY` | `1` | `app.set("trust proxy", …)`. `1` is correct for Cloud Run. |
| `MCP_HTTP_RATE_LIMIT_MAX` | `600` | Request cap per window, keyed on the **source IP** (not the OAuth client_id — under open DCR a caller can mint unlimited client_ids, so IP is the only sound key). Tighten on open-DCR deployments; the reference deployment uses 300. `get_user_activity` fan-out is separately bounded by a global per-call budget. |
| `MCP_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `MCP_HTTP_RATE_LIMIT_DISABLED` | unset | Set to `1` to disable rate limiting entirely (only useful for local dev). |
| `LOOMIO_MCP_LOG_VERBOSE` | unset | When `1`, emits structured JSON events to stderr (Cloud Run auto-parses). See OPTIMIZATIONS.md. |
| `LOOMIO_B3_API_KEY` | unset | Server-instance admin secret. When set, registers `deactivate_user` / `reactivate_user`. **Do not set on a multi-user deployment** — see SECURITY.md. |

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

## Rotating the API key

Set the new `LOOMIO_API_KEY` and redeploy / restart. Outstanding OAuth
tokens stay valid (they prove caller identity to the connector, not to
Loomio). To invalidate every outstanding OAuth token at once, rotate
`MCP_OAUTH_SIGNING_KEY` — every issued token becomes unverifiable.

## Reference deployment

The connector is designed for Cloud Run (or any container host) behind
its own OAuth-at-the-edge layer, with `LOOMIO_API_KEY` and
`MCP_OAUTH_SIGNING_KEY` held in a secret manager and injected as env
vars. A production-grade setup wires that up with an IaC tool (e.g.
Pulumi): KMS-backed secrets, bootstrap scripts for the API key /
signing key / OAuth client, and a smoke test that walks the full OAuth
dance against the deployed endpoint. None of that is connector-specific
beyond the env vars documented above.

## Image build

A `Dockerfile` ships in this repo for a direct `docker build`. For
local stdio use no container is needed at all — `npx loomiomcp` runs
the published package.
