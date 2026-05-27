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

Required env in any HTTP deployment:

| Variable | What it is |
|---|---|
| `LOOMIO_API_KEY` | Loomio API key. Shared by every authenticated MCP caller hitting this deployment. |
| `LOOMIO_API_BASE_URL` | Loomio API root. Defaults to `https://www.loomio.com/api`. Set to e.g. `https://openssl-communities.org/api` for a self-hosted instance. Override is gated to `https://` or loopback `http://` so the api_key (which travels as a query parameter) can't leak to a plaintext host. |
| `PUBLIC_BASE_URL` | Public origin of the service, e.g. `https://loomiomcp-xyz.run.app`. Used to build OAuth metadata. |
| `MCP_OAUTH_SIGNING_KEY` | HMAC key for OAuth tokens (≥16 chars, stable across instances). |

OAuth mode (pick one):

- **Static client (recommended for public deployments).** Set both
  `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`. DCR is disabled;
  the client_secret is the real auth boundary. Optionally set
  `MCP_OAUTH_REDIRECT_URIS` (comma-separated); defaults to Anthropic's
  known callback URIs.
- **Insecure auto-approve (local / private networks only).** Set
  `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`. Anyone who can reach the URL
  gets in. The server refuses to start in this mode unless
  `PUBLIC_BASE_URL` points at loopback, OR you set
  `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes`.

Recommended for any public deployment: `LOOMIO_MCP_READONLY=1`. Writes
(especially `manage_memberships`) using a shared API key across many
unrelated callers are hard to audit.

Other env:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Cloud Run injects). |
| `MCP_HTTP_JSON_LIMIT` | `1mb` | Request body cap. |
| `MCP_HTTP_TRUST_PROXY` | `1` | `app.set("trust proxy", …)`. `1` is correct for Cloud Run. |
| `LOOMIO_MCP_LOG_VERBOSE` | unset | When `1`, emits structured JSON events to stderr (Cloud Run auto-parses). See OPTIMIZATIONS.md. |
| `LOOMIO_B3_API_KEY` | unset | Server-instance admin secret. When set, registers `deactivate_user` / `reactivate_user`. **Do not set on a multi-user deployment** — see SECURITY.md. |

Build and deploy:

```
docker build -t loomiomcp .
gcloud run deploy loomiomcp --image … --set-env-vars LOOMIO_API_KEY=…,PUBLIC_BASE_URL=…,MCP_OAUTH_SIGNING_KEY=…,MCP_OAUTH_CLIENT_ID=…,MCP_OAUTH_CLIENT_SECRET=…,LOOMIO_MCP_READONLY=1
```

## Rotating the API key

Set the new `LOOMIO_API_KEY` and redeploy / restart. Outstanding OAuth
tokens stay valid (they prove caller identity to the connector, not to
Loomio). To invalidate every outstanding OAuth token at once, rotate
`MCP_OAUTH_SIGNING_KEY` — every issued token becomes unverifiable.

## Reference deployment

A working production Cloud Run deployment with secrets handling via
GCP KMS + Secret Manager lives at
[openssl/infra GCP/loomiomcp](https://github.com/openssl/infra/tree/main/GCP/loomiomcp/).
Pulumi project, three bootstrap scripts (API key, signing key, OAuth
client), and a smoke test that walks the OAuth dance.

## Image build

The container image used by that reference deployment is built by
[openssl/images loomiomcp/build.sh](https://github.com/openssl/images/tree/main/loomiomcp/build.sh).
A `Dockerfile` ships in this repo for direct `docker build`; the
`build.sh` wrapper standardises tagging + push for the openssl
container registry.
