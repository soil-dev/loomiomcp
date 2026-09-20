# Security

## Threat model

loomiomcp is a thin shim. It holds one secret (`LOOMIO_API_KEY`) and
exposes a small tool surface that calls Loomio's b2 API on behalf of
authenticated MCP clients, plus optional b3 admin endpoints (gated by
a separate, server-instance secret) when explicitly enabled.

Everything below is stated against Loomio 3.8.1 (`TESTED_LOOMIO_VERSION`
in `src/version.ts`). Loomio publishes no API compatibility policy and
changed its User API permission model between 3.0 and 3.8; re-check this
file when the health probe reports version drift.

## HTTP / multi-user posture (public deployments)

A public, open-DCR deployment runs in a specific shape that defines its
blast radius. Understand this before exposing the connector publicly:

- **Open DCR.** Anyone who can reach the URL can register an OAuth
  client and connect (`MCP_OAUTH_INSECURE_AUTO_APPROVE=1`). The OAuth
  layer is therefore **not** an authentication boundary here — it gates
  protocol conformance, not identity.
- **One shared upstream identity.** Every caller acts as the same
  Loomio user — the account behind `LOOMIO_API_KEY`. There is no
  per-user upstream auth (Loomio's per-user v1 API is Turnstile-walled).
- **The access boundary is the connector user's memberships PLUS the
  instance's publicly visible content.** A caller reads exactly what
  that user can read. Since Loomio 3.8 that is more than its groups:
  any authenticated API-key user can read **public groups' public
  threads** without being a member (the b2 discussion/poll list gate is
  `can?(:show, group)` plus per-topic visibility; a group whose
  `is_visible_to_public` is true passes for everyone). Confidentiality
  is not widened beyond what Loomio's anonymous web UI already shows —
  but through an open-DCR connector an anonymous caller can enumerate
  every public group's public content on the instance. Private groups
  and private topics still follow membership. Scope the deployment by
  scoping the user: add it only to groups whose data may be public.
  Adding it to a new group widens what every anonymous caller sees.
  Instance `is_admin` on the connector's user does **not** widen the
  User API on Loomio ≥ 3.8 (Loomio removed it from every b2
  authorization check) — do not grant it regardless.
- **Writes are off.** `LOOMIO_MCP_READONLY=1` removes all write tools,
  so the shared identity is read-only. Dropping readonly would turn open
  DCR into anonymous public *write* — don't.
- **Member rosters are visible; emails stay admin-only.** On Loomio
  ≥ 3.8 `list_memberships` returns the roster of every group the
  connector's user is a member of — user ids, names, usernames,
  `admin` / `delegate` flags, `title`, join state, inviter — **without
  email addresses**. `user_email` is serialized only for groups where
  that user is an admin (coordinator), and for members it invited
  itself. So: keep the connector's user a non-admin member that has
  invited nobody if member emails must never leave Loomio through this
  path, and accept that names and roles of its groups' members are
  readable by every caller. For a group the user is not a member of,
  Loomio answers `200` with an **empty list**, not 403; the connector
  annotates that with `scope.note`. (The pre-0.0.11 "probe fence" that
  re-classified membership 403s is gone; Loomio ≥ 3.1.1 returns
  distinguishable 403 bodies and `src/loomio/client.ts` reads them.)
- **Abuse is bounded per source IP.** The `/mcp` and `/health` rate
  limiters key on the client IP — **not** the OAuth client_id, because
  under open DCR a caller can mint unlimited client_ids and a
  client-keyed limit would be trivially bypassable. `get_user_activity`
  additionally has a global per-call fan-out budget and reports
  completeness via `scope.complete`.
- **`/health` exposes only health fields.** See below.

For a deployment whose upstream identity sees confidential data, use
static-client mode instead (see DEPLOY.md) — the client_secret then
gates who can connect.

## API key handling

Two distinct secrets:

- **`LOOMIO_API_KEY`** — per-user, sent as `Authorization: Bearer …` on
  every b2 request. Copy it from the user's API access page in Loomio
  (`/profile/api_access`).
- **`LOOMIO_B3_API_KEY`** (optional) — server-instance admin secret,
  sent as `Authorization: Bearer …` on b3 requests. Equal to
  `ENV['B3_API_KEY']` on the Loomio server. Only set this if you run the
  Loomio instance.

Both travel in the `Authorization` header, never in the URL. Loomio
rejects keys passed in the query string (removed July 2026) precisely
because URLs land in proxy access logs. Consequences:

- Keys MUST NOT be embedded in client-facing URLs. The connector
  injects them server-side, in `src/loomio/client.ts`. They are never
  forwarded to the MCP client and never appear in the
  `tool.call` / `loomio.request` / `loomio.auth` events emitted by
  `src/log.ts` (no headers are ever logged, and paths are run through
  `redactPath()`, which also drops the query string and collapses record
  ids and string keys to `:id`).
- `LOOMIO_API_BASE_URL` overrides are validated at request time in
  `baseUrl()` (`src/loomio/client.ts`): the override MUST be either
  `https://`, or `http://` pointed at loopback (`localhost`,
  `127.0.0.1`, `[::1]`), and MUST NOT carry userinfo. A typo'd
  `http://` override to a public host would hand the API key to anyone
  on the network path; the validation refuses to start the request in
  that case. Userinfo is refused before undici sees the URL because
  undici's own rejection quotes the entire URL, password included, and
  that text would otherwise reach the startup warning. None of the
  validation messages echo the configured value (the scheme error names
  `protocol//host` only).
- Every request also carries `User-Agent: loomiomcp/<version>`. That is
  not a secret; it exists so a WAF in front of Loomio can allow the
  connector explicitly and so instance operators can find it in logs.

**Key lifecycle.** The b2 key is not permanent: Loomio regenerates a
user's key whenever that user's password changes (Loomio ≥ 3.1.0), did
so for every user once in Loomio 3.3.1, and on account redaction; a
deactivated user's key stops authenticating. A rotated key makes every
call answer the generic 403 while the process looks healthy. The
connector therefore probes the key at startup and on `GET /health`,
classifies the 403 as "key rejected — rotated?", and emits a **forced**
`loomio.auth` event on every status change. None of those paths log or
return the key: the probe result carries `key_status`, `loomio_version`,
a closed-vocabulary `reason` and an operator-facing `detail`; the log
event carries `reason` and never `detail` (which may quote an upstream
body fragment or error message — the "no bodies in logs" invariant
holds for the forced events too); `/health` and tool results omit
`detail` as well, so it reaches only the startup stderr warning. The
runbook is in DEPLOY.md.

**Scope of the b3 secret.** Since Loomio 3.1 the b3 Server API covers
far more than the two operations this connector wraps: user listing
with emails, show / update (including `is_admin`) / destroy / redact,
and lookup by external identity. The secret authenticates the *server*,
not a user, and Loomio applies no per-user authorization to it. The
connector only ever calls the deactivate / reactivate member routes, but
the *credential* unlocks all of it on the Loomio side — one more reason
it must never sit on a shared deployment.

## Read-only mode

`LOOMIO_MCP_READONLY=1` skips registration of every write tool at MCP
server-init time. Belt-and-braces: even if a misbehaving MCP client
asked for `create_discussion` / `create_poll` / `manage_memberships` /
`create_comment` / `deactivate_user` / `reactivate_user`, the tool
isn't in the catalog. The client-layer guard in
`src/loomio/client.ts` (`isReadOnly()` → throw on POST) is the second
line of defence.

## `manage_memberships` and `remove_absent`

`POST /b2/memberships` requires the connector's user to be an **admin
(coordinator) of that group** — Loomio answers
`403 {"error":"User is not an admin"}` otherwise; parent-group admin and
instance admin do not count.

With `remove_absent` set, Loomio REMOVES every existing group member
whose email is NOT in the supplied list. Per Loomio's controller that
includes **pending invitees** (not-yet-accepted memberships are still
"active"), the **connector's own user** if its email is absent (locking
the connector out of the group), and the same users' memberships in
every **subgroup** (`MembershipService.revoke` cascades). Loomio has no
server-side dry-run; the call is destructive on submit. The empty-list
(zero remaining emails after dedupe) case removes the entire group.

On the wire the connector sends `remove_absent: 1` (integer) when the
flag is true and omits the key otherwise: Loomio reads
`params[:remove_absent].to_i == 1`, and a JSON boolean would raise
`NoMethodError` → HTTP 500 *after* the invitations had already been
sent. The tool's own input stays a boolean.

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
`LOOMIO_B3_API_KEY` is set). They call the member routes
`POST /api/b3/users/{id}/deactivate` and `…/{id}/reactivate` (the
`?id=` collection routes are deprecated in Loomio's OpenAPI document)
and affect users instance-wide:

- `deactivate_user` carries the `destructiveHint: true` annotation.
  Loomio enqueues a `DeactivateUserWorker` and answers
  `{ success: true, user }` **immediately** — the echoed user may still
  show `active: true`. The worker then stamps `deactivated_at`, revokes
  the user's memberships, mobile devices and pending membership
  requests. There is no soft confirmation step.
- `reactivate_user` is synchronous: it clears `deactivated_at` and
  **restores the memberships the deactivation revoked**. It is the
  inverse of the above and isn't marked destructive.

Never set `LOOMIO_B3_API_KEY` on a Cloud Run deployment that's
accessible to multiple users. The b3 secret authenticates the
*server* as a Loomio instance operator, not the calling user — any
client that can reach the MCP server can deactivate any user (and, see
"Scope of the b3 secret" above, the same credential does much more on
the Loomio side).

## `list_groups` and `get_user_activity` outbound fan-out

`list_groups` issues one outbound HTTP call per probed id (up to 500
per invocation, capped at the schema layer). `get_user_activity` fans
out across discussions similarly, bounded by a global per-call budget
(`MAX_SCAN_DISCUSSIONS` in `src/tools/events.ts`). A caller could still
invoke these repeatedly — the connector caps single-call cost, and the
`/mcp` rate limiter (keyed on source IP) bounds invocation rate. The
probes target the upstream Loomio API, so the residual blast radius is
on Loomio's side; size `MCP_HTTP_RATE_LIMIT_MAX` accordingly (the
reference deployment uses 300/min/IP). Loomio itself throttles 900
requests per 5 minutes per client IP (Rack::Attack, `text/plain` 429);
the connector maps that to a clear error rather than retrying. Both
fan-outs are retired in 0.0.12 in favour of Loomio's native endpoints.

## Key-health probe and `/health`

`src/loomio/health.ts` issues an authenticated `GET /api/b2/groups` (200
→ `valid`; 403 with Loomio's unauthenticated body → `rejected`; anything
else → `unreachable`) and the public, credential-free
`GET /api/v1/boot/version`. The result is cached 60 s and shared between
concurrent callers, so neither `/health` nor the tools that consult it
can be used to make the connector hammer Loomio.

`GET /health` (HTTP transport, `src/http/health.ts`) is unauthenticated
by design — uptime checkers cannot do OAuth — and returns exactly
`{status, connector_version, key_status, loomio_version, checked_at}`
with `Cache-Control: no-store`, HTTP 200 iff `key_status === "valid"`,
else 503. It never includes the key, the probe's `detail` text (which
may quote the configured base URL), or the Loomio hostname. It sits
behind the same per-IP rate limiter as `/mcp` (separate bucket). The
connector's own version is disclosed; that is deliberate (it is public
on npm) and lets an operator confirm what is deployed.

## OAuth

The HTTP transport's access and refresh tokens (under `src/auth/`) are
HMAC-signed and stateless — and so are open-DCR **client registrations**:
the `client_id` is a signed blob (`StatelessClientsStore`), so a
registered client survives restarts, scale-to-zero, redeploys, and
multi-instance routing with no shared storage (callers aren't forced to
re-authenticate when the process recycles). Rotate `MCP_OAUTH_SIGNING_KEY`
to invalidate every outstanding token **and** every registered client at
once. The only remaining in-process state is **pending authorization
codes** — single-use, client-/redirect-bound, 5-minute TTL — so the brief
initial authorize→token handshake should complete on one instance; at
higher request volume across multiple instances, signing the auth codes
too (as we do for tokens and clients) is the remaining step to make the
handshake fully instance-independent. In open-DCR mode the OAuth dance
proves protocol conformance, not identity (see the multi-user posture
section above); the `/mcp` rate limiter is keyed on source IP precisely
because client ids are caller-mintable in that mode. See DEPLOY.md.

## Reporting

Open an issue or contact the maintainer directly.
