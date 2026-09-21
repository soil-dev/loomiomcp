# Security

## Threat model

loomiomcp is a thin shim. It holds one secret (`LOOMIO_API_KEY`) and
exposes a small tool surface — 14 reads, 10 writes, 4 opt-in
instance-admin tools — that calls Loomio's b2 API on behalf of
authenticated MCP clients, plus the optional b3 admin endpoints (gated
by a separate, server-instance secret) when explicitly enabled.

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
  `check_connection` tells every caller who that account is (id, name,
  username) and which groups it is in.
- **The access boundary is the connector user's memberships PLUS the
  instance's publicly visible content.** A caller reads exactly what
  that user can read. Since Loomio 3.8 that is more than its groups:
  any authenticated API-key user can read **public groups' public
  threads** without being a member (`can?(:show, group)` plus per-topic
  visibility; a group whose `is_visible_to_public` is true passes for
  everyone). Four tools reach that content directly — `get_group`,
  `list_discussions` / `list_polls` by id, `list_threads` (every visible
  thread on the instance, newest first, one call) and `search_content`
  (full-text over every visible thread, comment, poll, vote reason and
  outcome). Confidentiality is not widened beyond what Loomio's anonymous
  web UI already shows — but through an open-DCR connector an anonymous
  caller can **enumerate and search every public group's public content
  on the instance** with two cheap calls. Private groups and private
  topics still follow membership. Scope the deployment by scoping the
  user: add it only to groups whose data may be public. Adding it to a
  new group widens what every anonymous caller sees. Instance `is_admin`
  on the connector's user does **not** widen the User API on Loomio ≥ 3.8
  (Loomio removed it from every b2 authorization check) — do not grant
  it regardless.
- **Per-member participation counts are exposed for member groups.**
  `get_participation_report` and `get_user_activity` read Loomio's
  participation report (`GET /b2/reports?section=users`): for every
  group the connector's user is a member of, a row per person who ever
  held a membership there — name, delegate flag, threads / comments /
  polls / votes cast vs issued vs missed / outcomes / reactions in a
  month window. This is the same data Loomio shows every member on the
  group's participation page (no admin role is involved, and Loomio
  drops groups the user is not in), but through a public connector it is
  available to anyone. Anonymous polls are excluded from the vote
  columns and nothing in the report names how anyone voted. If
  per-member activity of a group must not be public, the connector's
  user must not be a member of that group.
- **Writes are off.** `LOOMIO_MCP_READONLY=1` removes all write tools,
  so the shared identity is read-only. Dropping readonly would turn open
  DCR into anonymous public *write* — don't.
- **Member rosters are visible; emails stay admin-only.** On Loomio
  ≥ 3.8 `list_memberships` returns the roster of every group the
  connector's user is a member of — user ids, names, usernames,
  `admin` / `delegate` flags, `title`, join state, inviter — **without
  email addresses**. `user_email` on a membership row is serialized
  only for groups where that user is an admin (coordinator), and for
  members it invited itself; the connector passes that field through
  only where Loomio sent it. Loomio ALSO puts the connector account's
  **own** email on its `users[]` row for every group it belongs to
  (`AuthorSerializer#include_email?` is true for `current_user_id`, and
  every b2 index sets it) — that is the operator's service-account
  mailbox, not roster data, and on an open-DCR deployment every caller
  would learn it from any member group; the connector therefore drops
  `users[].email` entirely (on this endpoint it can be nothing else —
  Loomio's own test asserts member rows carry no `email` key). So: keep
  the connector's user a non-admin member that has invited nobody if
  member emails must never leave Loomio through this path, and accept
  that names and roles of its groups' members are readable by every
  caller.
- **One poll-visibility rule everywhere, search included.** Loomio
  indexes every cast vote's reason (with the voter's name) for search
  EXCEPT those of open `until_closed` polls; open `until_vote` polls are
  indexed, and Loomio's own web search shows a logged-in member those
  hits. Its thread view does not (a member who has not voted sees the
  voter but not the choice), and neither does this connector's
  `list_thread_items`. `search_content` — and `get_user_activity`'s
  `sample_events`, which reuse its shaping — apply the same
  `results_visible?(voted:)` rule from the response's own `polls` root.
  A withheld snippet alone would not close the gap in a `query` search:
  the hit's EXISTENCE says the query term occurs in that voter's hidden
  reason, and with `types: ['Stance']`, `author_id` and prefix matching
  that is a word-by-word oracle over exactly the text `list_thread_items`
  strips (Loomio's own web search has the same property — it shows the
  member the full reason). So in `query` mode `search_content` **drops**
  such hits and counts them in `scope.hidden_stance_hits_dropped`; in
  author-only mode (no term to probe with) the hit stays with its author
  and `snippet: null` + `snippet_hidden_reason`, as `get_user_activity`'s
  `sample_events` do. Nothing is widened beyond Loomio's web UI either
  way; the point is that a caller cannot use one tool to read — or to
  confirm word by word — what another withholds. For a group the user is
  not a member of, Loomio answers `200` with an **empty list**, not 403;
  the connector annotates that with `scope.note`.
- **Group billing metadata is dropped.** Loomio's GroupSerializer adds a
  `subscription` block (plan, state, active, seat caps, renewal and
  expiry dates) to every group record whenever the API user holds an
  active membership in the group's organisation — a serializer
  attribute, so no `exclude_types` profile removes it — and through an
  open-DCR connector every anonymous caller would learn the
  organisation's Loomio plan for every member group. `get_group` drops
  `subscription` (with `new_host` and `discarded_by`); `enabled` still
  says whether the subscription is active, which is all a caller needs.
  `list_groups` and the discussion / poll shows never carried it (they
  pick fields).
- **Abuse is bounded per source IP.** The `/mcp` and `/health` rate
  limiters key on the client IP — **not** the OAuth client_id, because
  under open DCR a caller can mint unlimited client_ids and a
  client-keyed limit would be trivially bypassable. Per-call upstream
  cost is bounded too (below).
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
  `redactPath()`, which also drops the query string — search text, group
  id lists — and collapses record ids, string keys, group handles and
  b3 identity uids to placeholders).
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
  `protocol//host` only). The same validated value, minus `/api`, is the
  base of every `url` the tools return — so a bad override cannot
  produce links to an unexpected host either.
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
holds for the forced events too); `/health`, `check_connection` and
every other tool result omit `detail` as well, so it reaches only the
startup stderr warning. The probe also keeps the parsed groups body it
received (the user's groups and own membership rows) in process memory
beside the verdict, for `check_connection` and for recognising the
user's own votes; it is never serialised by `/health` and never logged.
The runbook is in DEPLOY.md.

**Scope of the b3 secret.** The b3 Server API covers far more than the
four operations this connector wraps: user update (including
`is_admin`), hard destroy and redact, in addition to deactivate /
reactivate / show / index and lookup by external identity. The secret
authenticates the *server*, not a user, and Loomio applies no per-user
authorization to it and records no actor identity. The connector calls
only the deactivate / reactivate member routes and the show / index
reads, but the *credential* unlocks all of it on the Loomio side — one
more reason it must never sit on a shared deployment.

## Read-only mode

`LOOMIO_MCP_READONLY=1` skips registration of every write tool at MCP
server-init time — `create_discussion`, `update_discussion`,
`delete_discussion`, `create_poll`, `update_poll`, `delete_poll`,
`create_comment`, `update_comment`, `delete_comment`,
`manage_memberships` — and of every b3 tool, `get_user` / `list_users`
included (they return emails, so they share the writes' gate).
Belt-and-braces: even if a misbehaving MCP client asked for one, the
tool isn't in the catalog. The client-layer guard in
`src/loomio/client.ts` (`isReadOnly()` → throw before any request in
`loomioPost`, `loomioPatch`, `loomioDelete` and `loomioPostB3`) is the
second line of defence; `create_poll` checks it before its thread
resolution GET as well. `tests/readonly.test.ts` pins the advertised set
per mode by name.

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

## Soft deletes and replacing updates

`delete_discussion` / `delete_poll` / `delete_comment` call Loomio's b2
`destroy` actions, which are **soft discards**: `discarded_at` is
stamped, the title / body is nulled, the record leaves every list, and
an admin can restore it in Loomio's UI. Nothing is permanently erased
and the connector has no undo. They carry `destructiveHint: true`, their
descriptions say to confirm with the human first, and their results
carry `discarded: true` plus a note. `update_*` REPLACE the text passed
(no append) — the descriptions say to read first and send the whole new
body — and are idempotent; they carry `destructiveHint: true` as well,
because the MCP spec defines `false` as "performs only additive
updates" and an overwrite (or a shortened `closing_at`, a tightened
`hide_results`, a flipped `private`) is not additive. `update_poll`'s
`options` needs one more word: on the wire Loomio's `Poll#options=`
REPLACES the option set and hard-deletes every unlisted option together
with the votes cast on it, so the connector reads the poll's stored
`poll_option_names` first and PATCHes the union — the tool never removes
an option it SAW, at the cost of one extra call, and removal is not
offered. What the pre-read cannot close is the window between it and
the PATCH: an option another editor adds in that instant is absent from
the union and Loomio destroys it (with any votes already cast on it) on
200 with no signal — b2 has no atomic add-option primitive, no version
check (`versions_count` does not move on an option-only change) and the
echo reflects the post-destruction state. The window is one sequential
round-trip (Loomio's own web client submits the complete set the same
way over a minutes-long form); the tool and field descriptions name it
and tell the caller to avoid concurrent edits of one poll's options.
Authorization is Loomio's per-record rule
(author, thread admin, or a member where the group allows it); a refusal
is `403 "Not authorized to <action> <Model>."`, surfaced verbatim.

## b3 admin tools

`deactivate_user`, `reactivate_user`, `get_user` and `list_users` are
opt-in (registered only when `LOOMIO_B3_API_KEY` is set and the server
is not read-only). They call the member routes
`POST /api/b3/users/{id}/deactivate` and `…/{id}/reactivate` (the
`?id=` collection routes are deprecated in Loomio's OpenAPI document),
`GET /api/b3/users/{id}`, `GET /api/b3/users/identity/{type}/{uid}` and
`GET /api/b3/users[?is_admin=]`, and affect or reveal users
instance-wide:

- `deactivate_user` carries the `destructiveHint: true` annotation.
  Loomio enqueues a `DeactivateUserWorker` and answers
  `{ success: true, user }` **immediately** — the echoed user may still
  show `active: true`. The worker then stamps `deactivated_at`, revokes
  the user's memberships, mobile devices and pending membership
  requests. There is no soft confirmation step.
- `reactivate_user` is synchronous: it clears `deactivated_at` and
  **restores the memberships the deactivation revoked**. It is the
  inverse of the above and isn't marked destructive.
- `get_user` and `list_users` return every account's **email address**
  (plus `is_admin`, `active`, `deactivated_at` and linked external
  identities) for any user on the instance, member of the connector's
  groups or not; `list_users` is the whole user table in one
  unpaginated response. That is why they are gated like the writes and
  documented as **single-tenant deployments only** — one organisation
  per Loomio instance. On a shared or hosted instance leave
  `LOOMIO_B3_API_KEY` unset.

Never set `LOOMIO_B3_API_KEY` on a Cloud Run deployment that's
accessible to multiple users. The b3 secret authenticates the
*server* as a Loomio instance operator, not the calling user — any
client that can reach the MCP server can deactivate any user and read
every email (and, see "Scope of the b3 secret" above, the same
credential does much more on the Loomio side).

## Upstream cost bounds

Every read is one upstream call unless stated (README.md has the table).
The exceptions and caps that matter for abuse sizing:

- `get_user_activity` makes one `GET /b2/reports` per requested group
  (schema cap 50, at most 4 in flight) plus one search — N + 1 calls
  per invocation. The 0.0.11 per-discussion fan-out (~200 calls) and the
  `list_groups` id probe (50–500 calls) are gone; nothing else fans out.
- `list_thread_items` (and `get_discussion` with `include_items`) fetch
  the WHOLE thread once per call — Loomio's items route is unpaginated
  — so the cost is one request but its size scales with the thread;
  `body_max_chars` and the `max_total_chars` reply budget (default
  120000 shaped characters) bound what is returned to the client, not
  what Loomio sends.
- `search_content` is capped by Loomio at 20 results; `list_threads` at
  100 per page; the list tools at 200 per page.
- A caller could still invoke any of these repeatedly; the `/mcp` rate
  limiter (keyed on source IP) bounds invocation rate. Size
  `MCP_HTTP_RATE_LIMIT_MAX` accordingly. Loomio itself throttles 900
  requests per 5 minutes per client IP (Rack::Attack, `text/plain` 429);
  the connector maps that to a clear error rather than retrying.

## Key-health probe and `/health`

`src/loomio/health.ts` issues an authenticated `GET /api/b2/groups` (200
→ `valid`; 403 with Loomio's unauthenticated body → `rejected`; anything
else → `unreachable`) and the public, credential-free
`GET /api/v1/boot/version`. The result is cached 60 s and shared between
concurrent callers, so neither `/health` nor the tools that consult the
cached verdict can be used to make the connector hammer Loomio.
`check_connection` is the deliberate exception: it FORCES a fresh probe
(its job is a verdict after a 403 or an empty list, where a minute-old
"valid" would mislead), so every call costs Loomio one request pair —
the same order as any other read tool; concurrent callers still share
one in-flight probe. That cost is bounded by the per-IP `/mcp` rate
limiter and by Loomio's own Rack::Attack throttle, both above.

`GET /health` (HTTP transport, `src/http/health.ts`) is unauthenticated
by design — uptime checkers cannot do OAuth — and returns exactly
`{status, connector_version, key_status, loomio_version, checked_at}`
with `Cache-Control: no-store`, HTTP 200 iff `key_status === "valid"`,
else 503. It never includes the key, the probe's `detail` text (which
may quote the configured base URL), the Loomio hostname, or the groups
body the probe keeps in memory. It sits behind the same per-IP rate
limiter as `/mcp` (separate bucket). The connector's own version is
disclosed; that is deliberate (it is public on npm) and lets an operator
confirm what is deployed.

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
