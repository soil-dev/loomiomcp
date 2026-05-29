# Security

## Threat model

loomiomcp is a thin shim. It holds one secret (`LOOMIO_API_KEY`) and
exposes a small tool surface that calls Loomio's b2 API on behalf of
authenticated MCP clients, plus optional b3 admin endpoints (gated by
a separate, server-instance secret) when explicitly enabled.

## HTTP / multi-user posture (the public deployment)

The reference deployment (`mcp.openssl-communities.org`) runs in a
specific shape that defines its blast radius. Understand this before
exposing the connector publicly:

- **Open DCR.** Anyone who can reach the URL can register an OAuth
  client and connect (`MCP_OAUTH_INSECURE_AUTO_APPROVE=1`). The OAuth
  layer is therefore **not** an authentication boundary here — it gates
  protocol conformance, not identity.
- **One shared upstream identity.** Every caller acts as the same
  Loomio user — the "Communities Bot" behind `LOOMIO_API_KEY`. There is
  no per-user upstream auth (Loomio's per-user v1 API is Turnstile-walled).
- **The bot's group memberships ARE the access boundary.** A caller
  reads exactly what the bot can read — no more. Scope the deployment by
  scoping the bot: add it only to groups whose data may be public.
  Adding the bot to a new group widens what every anonymous caller sees.
- **Writes are off.** `LOOMIO_MCP_READONLY=1` removes all write tools,
  so the shared identity is read-only. Dropping readonly would turn open
  DCR into anonymous public *write* — don't.
- **Member emails stay admin-only.** The bot is deliberately a non-admin
  member, so `list_memberships` (the only email-bearing tool) returns
  403. On that 403 the connector probes a member-gated endpoint to
  classify and explain the denial — bot-not-admin vs invalid-key vs
  not-a-member — instead of a bare error (`src/loomio/access.ts`).
  Names / usernames / ids stay reachable via `get_user_activity` /
  `list_events`; email does not.
- **Abuse is bounded per source IP.** The `/mcp` rate limiter keys on
  the client IP — **not** the OAuth client_id, because under open DCR a
  caller can mint unlimited client_ids and a client-keyed limit would be
  trivially bypassable. `get_user_activity` additionally has a global
  per-call fan-out budget and reports completeness via `scope.complete`.

For a deployment whose upstream identity sees confidential data, use
static-client mode instead (see DEPLOY.md) — the client_secret then
gates who can connect.

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
- `LOOMIO_API_BASE_URL` overrides are validated at request time in
  `baseUrl()` (`src/loomio/client.ts`): the override MUST be either
  `https://`, or `http://` pointed at loopback (`localhost`,
  `127.0.0.1`, `[::1]`). A typo'd `http://` override to a public host
  would put the api_key in plaintext in every intermediate access
  log; the validation refuses to start the request in that case.

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

## `list_groups` outbound fan-out

`list_groups` issues one outbound HTTP call per probed id (up to 500
per invocation, capped at the schema layer). `get_user_activity` fans
out across discussions similarly, bounded by a global per-call budget
(`MAX_SCAN_DISCUSSIONS` in `src/tools/events.ts`). A caller could still
invoke these repeatedly — the connector caps single-call cost, and the
`/mcp` rate limiter (keyed on source IP) bounds invocation rate. The
probes target the upstream Loomio API, so the residual blast radius is
on Loomio's side; size `MCP_HTTP_RATE_LIMIT_MAX` accordingly (the
reference deployment uses 300/min/IP).

## OAuth

The HTTP transport's access and refresh tokens (under `src/auth/`) are
HMAC-signed and stateless. Rotate `MCP_OAUTH_SIGNING_KEY` to invalidate
every outstanding token at once. Pending authorization codes and open-DCR
client registrations are held in process memory: they are single-use /
client- / redirect-bound with a 5-minute auth-code TTL, but the OAuth
handshake must complete on the same running instance that issued the
code and registered the client. Run Cloud Run with one instance for the
current implementation, or add a shared OAuth store before horizontal
scaling. In open-DCR mode the OAuth dance proves protocol conformance,
not identity (see the multi-user posture section above); the `/mcp` rate
limiter is keyed on source IP precisely because client ids are
caller-mintable in that mode. See DEPLOY.md.

## Reporting

Open an issue or contact the maintainer directly.
