# Security

## Threat model

loomiomcp is a thin shim. It holds one secret (`LOOMIO_API_KEY`) and
exposes a small tool surface that calls Loomio's b2 API on behalf of
authenticated MCP clients, plus optional b3 admin endpoints (gated by
a separate, server-instance secret) when explicitly enabled.

## API key handling

Two distinct secrets:

- **`LOOMIO_API_KEY`** — per-user, passed as `?api_key=…` on every b2
  request. Get one from your Loomio profile → API keys.
- **`LOOMIO_B3_API_KEY`** (optional) — server-instance admin secret,
  passed as `?b3_api_key=…` on b3 requests. Equal to `ENV['B3_API_KEY']`
  on the Loomio server. Only set this if you run the Loomio instance.

Both are appended as query parameters on every outbound Loomio call.
URLs land in proxy access logs. Consequences:

- Keys MUST NOT be embedded in client-facing URLs. The connector
  injects them server-side, in `src/loomio/client.ts`. They are never
  forwarded to the MCP client and never appear in the
  `tool.call` / `loomio.request` events emitted by `src/log.ts`
  (paths are run through `redactPath()` which drops the query string).
- `LOOMIO_API_BASE_URL` overrides are gated: only `https://` is
  accepted, plus `http://` on loopback. A typo'd `http://` override to
  a public host would put the key in plaintext in every intermediate
  log.

## Read-only mode

`LOOMIO_MCP_READONLY=1` skips registration of every write tool at MCP
server-init time. Belt-and-braces: even if a misbehaving MCP client
asked for `create_discussion` / `create_poll` / `manage_memberships` /
`create_comment` / `deactivate_user` / `reactivate_user`, the tool
isn't in the catalog. The client-layer guard in
`src/loomio/client.ts` (`isReadOnly()` → throw on POST) is the second
line of defence.

## `manage_memberships` and `remove_absent`

`POST /memberships` with `remove_absent: true` REMOVES every existing
group member whose email is NOT in the supplied list. Loomio has no
server-side dry-run; the call is destructive on submit. The empty-list
(zero remaining emails after dedupe) case removes the entire group.

The `manage_memberships` tool:

- Defaults `remove_absent` to `false` (additive only).
- Carries the warning text in its tool description so MCP clients can
  surface it before invocation.
- Carries a `destructiveHint: true` annotation (set in
  `src/server/register-tool.ts`) so MCP clients that honour it (e.g.
  Claude Desktop) prompt before invoking.
- Should be called ONLY after reading `list_memberships` and confirming
  the diff with a human.

In multi-user / shared-key HTTP deployments, set `LOOMIO_MCP_READONLY=1`
to remove this tool from the catalog entirely.

## b3 admin tools

`deactivate_user` / `reactivate_user` are opt-in (only registered when
`LOOMIO_B3_API_KEY` is set). They affect users instance-wide:

- `deactivate_user` carries the `destructiveHint: true` annotation;
  Loomio schedules a `DeactivateUserWorker` that revokes sessions,
  memberships, and email subscriptions for the target user. There is
  no soft confirmation step.
- `reactivate_user` is the inverse and is reversible by the user's
  next login, so it isn't marked destructive.

Never set `LOOMIO_B3_API_KEY` on a Cloud Run deployment that's
accessible to multiple users. The b3 secret authenticates the
*server* as a Loomio instance operator, not the calling user — any
client that can reach the MCP server can deactivate any user.

## OAuth

The HTTP transport's OAuth surface (under `src/auth/`) is HMAC-signed,
stateless. Rotate `MCP_OAUTH_SIGNING_KEY` to invalidate every
outstanding token at once. See DEPLOY.md.

## Reporting

Open an issue or contact the maintainer directly.
