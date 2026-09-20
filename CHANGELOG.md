# Changelog

## 0.0.11 — 2026-09-20

Hotfix: **detect, explain, stop lying.** Between Loomio 3.0.24 (the
release this connector was built against) and 3.8.1, Loomio changed
its API in ways that made the connector fail *quietly*: a rotated API
key turned every call into one generic 403, `get_user_activity`
reported zero activity for everyone once its upstream endpoint was
removed, and `list_groups` answered an empty list when the key was
dead. This release makes each of those failures loud and specific.
It adds no new Loomio endpoints — the ports to Loomio's newer b2
surface (native groups listing, thread items, topic side-load) are
0.0.12. Tool count unchanged (8 reads + 4 writes + 2 b3 admin).

Tested against Loomio 3.8.1: every behaviour described below was
checked against the controllers, serializers, routes and controller
tests at Loomio tag `v3.8.1`. `TESTED_LOOMIO_VERSION` in
`src/version.ts` records that, and the health probe warns once when
the instance's `major.minor` differs from it — Loomio publishes no API
compatibility policy, so a new minor is a prompt to re-verify.

Added:

- **Key-health probe** (`src/loomio/health.ts`). An authenticated
  `GET /b2/groups` (200 → `valid`; 403 with Loomio's unauthenticated
  body → `rejected`; anything else, including a CDN/WAF 403 that never
  reached Loomio → `unreachable` with a `detail`) plus the public
  `GET /v1/boot/version` for the instance's Loomio version. Cached 60 s
  with a shared in-flight promise, so a hammered `/health` costs Loomio
  one request pair per minute. Every `key_status` change (including the
  first result) emits a **forced** `loomio.auth` event that bypasses the
  `LOOMIO_MCP_LOG_VERBOSE` gate, carrying `key_status`, `loomio_version`
  and a closed-vocabulary `reason` (`unauthenticated_body`, `waf`,
  `unrecognised_403`, `http_<status>`, `timeout`, `network_error`,
  `config_error`) — never the free-text `detail`, which may quote an
  upstream body fragment or error message and is reserved for the
  startup stderr warning. A one-time forced `loomio.version_drift` fires
  on a `major.minor` mismatch. Never logs or returns the key.
- **`GET /health`** on the HTTP transport (`src/http/health.ts`).
  Unauthenticated, per-IP rate-limited (same config as `/mcp`, separate
  bucket), `Cache-Control: no-store`. Body:
  `{status, connector_version, key_status, loomio_version, checked_at}`
  — HTTP 200 iff `key_status === "valid"`, else 503. Exposes exactly
  those fields: no key material, no `detail`, no Loomio hostname. Point
  an uptime check at it with content match `"key_status":"valid"`
  (DEPLOY.md). `LOOMIO_MCP_HEALTH_PATH` moves the page (e.g. to
  `/-/health`) for hosting front-ends that reserve `/healthz` and answer
  it with their own 404 before the container is reached; verify with
  `curl` that the connector's JSON comes back before trusting an alert.
- **Startup key check.** The HTTP entry probes after `listen` and logs
  the verdict; the stdio entry probes once and, on `rejected`, writes a
  one-paragraph warning to stderr (key rotated? where the current one
  is). Neither exits — a transient error must not kill the server, and a
  live process with classified 403s is more diagnosable than a
  crash-loop.
- **`User-Agent: loomiomcp/<version>`** on every outbound request. A
  CDN/WAF in front of an instance (Cloudflare is common) blocks default
  library user-agents outright; an explicit UA also lets instance
  operators pick the connector out of Loomio's logs.
- **`src/version.ts`** — single source of truth for `VERSION` and
  `TESTED_LOOMIO_VERSION`. `McpServer`, the User-Agent and `/health`
  import it; `tests/version.test.ts` pins `package.json` to it (0.0.9
  shipped with the two out of step).

Changed:

- **403s are classified** (`classifyForbidden` in `src/loomio/client.ts`,
  pure and unit-tested). Loomio ≥ 3.1.1 answers 403 with a body that
  says *why*, and the connector now reads it: a CDN/WAF body (JSON
  problem `type` mentioning cloudflare, or non-JSON) → "blocked in front
  of Loomio, not a permissions error — check WAF rules / User-Agent";
  the generic `"You are not authorized to access this page."` →
  **unauthenticated** — most often a rotated key (Loomio regenerates a
  user's key when that user's password changes, and 3.3.1 rotated every
  key once) — with remediation (`/health`, `GET /api/b2/groups`, the
  user's API access page `/profile/api_access`). The classification is
  **path-aware**: only `GET /b2/discussions?group_id=` and
  `GET /b2/polls?group_id=` go through `records_visible_in_group`, so
  only there does the message add "or the group is not visible to the
  connector's user"; on `/b2/memberships` (a non-member gets `200 []`),
  on every `/…/:id` read (which answers `"Not authorized to …"`) and on
  writes the same body can only mean the key was rejected, and the
  message says so. Writes include `POST /b2/discussions` and
  `POST /b2/polls`, whose paths coincide with the two gated GET lists:
  the classifier is **method-aware**, so a rotated key on `create_*` is
  never hedged towards "group not visible" (the one bare refusal a
  valid key can hit on a write — `POST /b2/polls` for an anonymous poll
  with no future `closing_at`, raised after the poll was saved — is
  named in the message). On `/b3/` paths the generic body is about the
  **b3 server secret**: `LOOMIO_B3_API_KEY` must equal the Loomio
  server's `ENV['B3_API_KEY']` (itself longer than 16 characters), and
  the message says exactly that — never the per-user key, never
  `/profile/api_access` — and the health verdict, which probes the b2
  key only, does not colour it.
  The key-health verdict colours the message only when
  it is **fresh** (younger than the 60 s cache): a fresh `rejected` makes
  it definitive, a fresh `valid` on a gated list points at visibility
  first, and a stale verdict is ignored — so a startup `valid` from days
  ago can never make a post-rotation 403 read as "not a key problem".
  `"Not authorized to <action> <Model>."` → per-record permission,
  surfaced verbatim; `"User is not an admin"` → needs the group admin
  (coordinator) role on that group; a numeric body or
  `action: "upgrade"` → Loomio subscription/plan limit; anything else →
  the body text. The old "Loomio sends the same 403 whether the key is
  invalid or the user lacks the role" text is gone — it described
  Loomio ≤ 3.1.0. A **401** is explained per namespace: Loomio's b2/b3
  API answers its own authentication failures with 403, so a 401 on a
  b2/b3 path came from something in front of Loomio (proxy, CDN,
  basic-auth gate); on a v1 path Loomio itself can answer 401
  (`require_current_user`, "you gotta be signed in") because v1 is a
  session-cookie API and the connector's key is not a v1 credential.
- **Upstream text in error messages is clipped** to 200 characters
  (`clip` in `src/loomio/client.ts`) at every echo site: non-JSON error
  bodies (a CDN's multi-KB HTML 502 page), the uncatalogued-403 body,
  `"Not authorized to …"` remainders, plan-limit and Cloudflare titles,
  and Rack::Attack's 429 text. The suffix states the original length.
  These messages land in MCP tool results (agent context) and inside
  `get_user_activity`'s "Last error"; unbounded upstream text there is
  both noise and an injection surface.
- **429 handled.** Loomio's Rack::Attack throttle (per client IP, 900
  requests per 5 minutes by default, `text/plain`) becomes a clear
  `LoomioApiError` with the `Retry-After` header when present; the
  invitation-limit JSON 429 is surfaced with Loomio's own message.
- **`list_memberships`** passes Loomio's response through. When
  `memberships` is empty it adds `scope.note`: on Loomio ≥ 3.8 a
  non-member (or a hidden group) gets `200 []`, not 403, and a real
  group always has at least its creator — so an empty roster almost
  always means "the connector's user is not a member". Description
  rewritten: **any member** can list the roster (ids, names, usernames,
  roles, join state); `user_email` appears only for groups where the
  connector's user is an admin, or for members it invited. The "caller
  MUST be a group admin / 403" claims are removed.
- **`manage_memberships`** sends `remove_absent: 1` on the wire when the
  flag is true and **omits the key** otherwise. Loomio reads
  `params[:remove_absent].to_i == 1`; a JSON boolean has no `#to_i` in
  Ruby, so the previous body raised `NoMethodError` → HTTP 500 — *after*
  the invitations had been sent. The zod schema keeps the boolean.
  Description now states the role requirement (group admin/coordinator
  on that group; Loomio answers `403 "User is not an admin"`; parent-
  group admin and instance admin do not count) and the full blast radius
  of `remove_absent`: pending invitees are revoked too, the revocation
  cascades to subgroups, and the connector's own user is removed if its
  email is absent.
- **Membership 403 fence removed.** `src/loomio/access.ts`,
  `tests/access.test.ts` and `explainForbidden` are deleted. The fence
  existed because Loomio ≤ 3.1.0 returned a bare `{"error":403}` for
  every refusal; the classified bodies make it redundant, and its extra
  probe was one more way to spend Loomio's rate budget.
- **`list_discussions` always sends `status`** (default `open`).
  Loomio's own fall-through for a missing `status` is every kept thread
  *including locked ones*, so omitting it silently widened the list.
  The description states the default.
- **`deactivate_user` / `reactivate_user`** use the member routes
  `POST /b3/users/{id}/deactivate` and `…/{id}/reactivate`; the `?id=`
  collection routes are marked `deprecated: true` in Loomio's OpenAPI
  document. The response is typed as `{ success: true, user }` and
  returned. Descriptions: deactivation runs **asynchronously**
  server-side (the echoed user may still show `active: true`);
  reactivation is synchronous and **restores the memberships the
  deactivation revoked**.
- **`list_groups`** no longer claims that `is_admin` bypasses membership
  (Loomio ≥ 3.8 ignores it for the User API) and now states the probe's
  blind spot: a group with **no polls** is never discovered, because the
  group object only reaches the response as a side-load of the polls
  that reference it. Scope now includes publicly visible groups (Loomio
  ≥ 3.8 lets any authenticated user read them). The description no
  longer claims that `b2/polls` embeds a subgroup's parent in `groups`:
  Loomio side-loads it under a separate `parent_groups` root (with no
  visibility check on the parent), which the probe deliberately does
  not read, so a parent group is discovered only when its own id is
  probed. When the scan finds
  nothing it consults the health probe: `rejected` → throws the
  key-rejected error instead of returning `groups: []`; otherwise the
  result carries `scanned.note` saying what the emptiness does and does
  not prove. Each probe records *why* it missed (404 vs 403), and when
  any miss was a 403 the health probe is **forced** rather than served
  from its 60 s cache — with a valid key a non-existent id answers 404
  (`Group.find` runs after `authenticate_api_key!`), so an all-403 scan
  is exactly what a key rotated seconds after the last `valid` probe
  looks like. The `unreachable` note is fixed text; the probe's
  operator-facing `detail` stays out of tool results, as it stays out
  of `/health`.
- **`list_polls` description** no longer says "Caller must be a group
  member": polls and discussions share the `records_visible_in_group`
  gate, so a publicly visible group's public polls are readable by any
  authenticated user on Loomio ≥ 3.8 (same wording as
  `list_discussions`).
- **`create_poll` description** no longer presents the
  public-discussions-only 422 as a current limitation: Loomio ≥ 3.1.0
  derives the poll topic's privacy from the group
  (`TopicService.private_default`) when `private` is omitted, so the
  create should work in every group (not yet re-verified live; 0.0.12).
  HOWTO.md carried the same stale paragraph and is fixed alongside.
- **`LOOMIO_API_BASE_URL` validation** refuses a URL with userinfo
  (`user:password@host`) before undici can quote the whole URL —
  password included — back in an error message, and no validation
  message repeats the configured value verbatim any more (the scheme
  error names `protocol//host` only).
- **`redactPath`** also collapses `/users/<id>` (b3 member routes),
  `/groups/<id>` and `/threads/<id>` — the resources Loomio addresses by
  a string key in the path — so no id or handle reaches a log line.
- **Rate limiter** factored into `src/http/rate-limit.ts` so `/mcp` and
  `/health` share one config and one keying rule (source IP) with
  separate buckets. `resolveMcpRateLimitConfig` is re-exported from its
  old home.
- **Docs** brought in line with Loomio 3.8.1 throughout (README,
  INSTALL, DEPLOY, SECURITY, DESIGN, HOWTO, NOTES-ON-LOOMIO-API,
  OPTIMIZATIONS, CONTRIBUTING, glama.json). NOTES-ON-LOOMIO-API.md gains
  a dated "Loomio 3.1 → 3.8 changes that matter" section; obsolete
  gotchas are marked historical rather than deleted.

Fixed:

- **`get_user_activity` no longer reports zero activity when it counted
  nothing.** Loomio ≥ 3.4.0 removed `GET /api/v1/events`; the previous
  fan-out swallowed the resulting 404 on every discussion and returned
  `counts.total: 0` for every user with only `scope.complete: false` to
  hint otherwise. Now the FIRST discussion's stream is probed on its own
  — a 404 there throws `V1EventsRemovedError` at the cost of one request
  — and, as a backstop, a scan that ends with zero successful event
  fetches and at least one failure throws instead of returning counts,
  as does a scan where every group listing failed. Partial results are
  still returned with the existing `scope.*` completeness flags.
- **`list_events` on a 404** throws a clear error naming the removed
  endpoint and the planned port instead of returning an empty stream.
- **`manage_memberships` with `remove_absent: true` no longer 500s after
  inviting** (see Changed).
- **`list_groups` no longer returns an empty list for a rejected key**
  (see Changed).
- **Version skew** between `package.json` and the advertised MCP server
  version can no longer recur (see `src/version.ts`).

Known limitations:

- **`list_events` and `get_user_activity` do not work against Loomio
  ≥ 3.4.0** (August 2026), which removed the v1 `events` endpoint they
  read (the Event model became TopicItem). Both tools now fail with a
  clear error rather than lying; their descriptions say so. The port to
  `GET /api/b2/threads/{topic_id}/items` is planned for 0.0.12.
- **Write bodies pending verification.** Since Loomio 3.1.3 the b2
  `permitted_params` prefers a wrapped resource hash (`{discussion:
  {…}}`) when one is present and only falls back to the flat-body
  handling this connector was built on. The flat/form-encoded write
  behaviour is unchanged in this release and is re-verified against a
  live 3.8.x instance in 0.0.12.
- **`list_groups` is still probe-based** (misses poll-less groups; costs
  one request per id). Native `GET /api/b2/groups` arrives in 0.0.12.
- **Topic side-load not yet joined.** Since Loomio 3.1.0 a discussion's
  `items_count`, `last_activity_at` and similar counters live on the
  side-loaded `topics[]` record (and `compact=1` drops that record).
  `list_discussions` / `get_discussion` return Loomio's response as-is;
  the join is 0.0.12.

## 0.0.10 — 2026-07-25

Dependency security updates. No code, tool, or API changes.

Clears every high-severity advisory in the tree (9 vulnerabilities →
3; 5 high → 0):

- **`undici` 8.3.0 → 8.9.0** (runtime dependency — the HTTP client for
  every outbound Loomio call). Fixes HTTP response queue poisoning via
  keep-alive socket reuse, cross-user information disclosure via a
  shared-cache whitespace bypass, and a Set-Cookie SameSite downgrade.
  The first and third matter most here: this is a multi-user service
  that funnels all callers through one upstream identity over pooled
  keep-alive connections.
- Transitive bumps: `body-parser` 2.3.0, `fast-uri` 3.1.4,
  `postcss` 8.5.23, `hono` 4.12.32, `vite` 8.1.5 (supersedes the
  individual Dependabot PRs).

Three advisories are left unfixed **deliberately**, all unreachable
here:

- `@hono/node-server` path traversal in `serve-static` on **Windows**
  via encoded backslash. The connector never uses hono (it uses the
  express / stdio transports), never serves static files, and ships in
  a Linux container. npm's proposed fix is a **downgrade** of
  `@modelcontextprotocol/sdk` to 1.24.3 — breaking our core dependency
  to patch a bundled framework we don't invoke.
- `esbuild` dev-server file read on **Windows** — a devDependency
  (via tsup/vite), absent from the production image
  (`npm ci --omit=dev`), and we never run its dev server.

Verified against the live Loomio instance with the new undici: bearer
auth, paginated reads, probe-based `list_groups`, and
`get_user_activity` aggregation all return real data. (The unit suite
mocks `undici`, so a live check is what actually exercises the upgrade.)

## 0.0.9 — 2026-07-25

**Breaking upstream change — this release is required.** Loomio moved
API-key authentication to an HTTP bearer header and now rejects keys
passed in the query string. Every request from 0.0.8 and earlier fails
against an updated Loomio instance.

- **Bearer authentication.** b2 and b3 now send
  `Authorization: Bearer <key>`; URLs carry no credential. Auth
  injection moved from `buildUrl()` to a single new `authHeaders()` in
  `src/loomio/client.ts`. No configuration change: `LOOMIO_API_KEY` and
  `LOOMIO_B3_API_KEY` are unchanged.
- **Why it presented as a permissions bug.** Loomio answers a
  query-string key with `403 {"error":"You are not authorized to access
  this page."}` — the same response as an invalid key or a missing
  group role. `tests/loomio-auth.test.ts` now pins the scheme so a
  regression fails in CI instead of surfacing as a blanket 403.
- b3 bearer support follows Loomio's published note but is **untested
  here** — it needs a server-instance `B3_API_KEY`, which only Loomio
  instance operators hold.
- Docs updated throughout (README, INSTALL, DEPLOY, SECURITY, DESIGN,
  CONTRIBUTING, NOTES-ON-LOOMIO-API, glama.json).

## 0.0.8 — 2026-06-04

Follow-up hardening on the stateless OAuth client store (0.0.7). No
tool/API changes; tool counts unchanged.

- **Public clients honoured.** A client that registers with
  `token_endpoint_auth_method: "none"` (PKCE-only, no secret) is no
  longer issued a `client_secret`. 0.0.7 derived a secret for *every*
  client, leaving a public client in a contradictory state (auth method
  `none` yet carrying a secret). Confidential (`client_secret_post`)
  clients — including Claude.ai's — are unchanged, so there's no
  re-auth at this upgrade.
- **Oversized `client_id` guard.** `getClient` now rejects a
  `client_id` larger than 16 KB before doing any HMAC/JSON work —
  cheap defence against a crafted-input CPU drain. Legitimate signed
  ids are ~400 bytes.

## 0.0.7 — 2026-06-01

Fixes frequent connector **re-authentication** on the public (open-DCR)
deployment.

Cause: registered OAuth clients were held in an in-memory map
(`InMemoryClientsStore`), so any process recycle — a redeploy,
scale-to-zero, or a refresh routed to a different instance — lost the
registration and forced the client to re-authenticate. (Access/refresh
tokens are stateless and survive; but the SDK re-validates the client
against the store on every refresh, and the lookup missed.)

Fix: new **`StatelessClientsStore`**. The `client_id` is now a signed
blob (HMAC, same key as the tokens) encoding the registration metadata;
`getClient` verifies the signature and reconstructs the client instead
of a map lookup, and the `client_secret` is derived deterministically
from the `client_id`. So **any instance recognises any client with zero
shared state** — refresh and re-authorize survive restarts,
scale-to-zero, redeploys, and multi-instance routing. It mirrors the
existing stateless-token design. Open-DCR HTTP deployments use this
store; `InMemoryClientsStore` is retained for local/dev (single process).

Notes:

- At the upgrade, clients registered under the old in-memory UUIDs will
  re-authenticate **once**, then stay connected.
- Revocation remains global only (rotate `MCP_OAUTH_SIGNING_KEY`, which
  also invalidates outstanding tokens) — acceptable since all callers
  share one upstream Loomio identity.
- No tool/API changes; tool counts unchanged.

## 0.0.6 — 2026-05-29

Tooling and project-metadata only — **no API, tool, or behaviour
changes** (the compiled output is identical to 0.0.5 apart from the
advertised version string).

- **CI**: added `.github/workflows/ci.yml` — typecheck + tests + lint +
  build on every push/PR, across Node 22 and 24. (The repo had 121
  tests but nothing ran them automatically.)
- **`glama.json`**: corrected a stale inventory (it still said "9
  tools", pre-dating `list_events` / `get_user_activity`). Now
  accurately describes 12 tools (8 read, 4 write) plus the 2 opt-in b3
  admin tools, and notes the ToolAnnotations.
- **README**: npm / CI / license / Glama badges.

## 0.0.5 — 2026-05-29

Audit follow-ups + general-purpose hygiene. No new tools; counts
unchanged (8 reads + 4 writes + 2 b3 admin).

`list_events`:

- Without `limit`/`offset` it now **auto-paginates the full discussion
  stream** (merging the embedded `comments` / `users` / `polls` arrays
  across pages) up to a bounded cap, and reports `scope.complete` /
  `scope.pages_fetched` / `scope.events_truncated`. Pass `limit` and/or
  `offset` to get exactly one page as before. Previously a single
  default-page fetch could silently miss later events in a long thread.

`get_user_activity`:

- **Count fix:** `comment_edited` and `stance_updated` events were in
  the activity set but missing from the `counts` object, so they were
  silently bucketed as `other`. They're now counted under their own
  keys.
- **New completeness signal `scope.groups_truncated`** — groups whose
  discussion listing hit the per-group page cap (so some discussions
  weren't scanned). Joins the `complete` / `groups_failed` /
  `discussions_failed` / `discussions_truncated` / `discussions_capped`
  set from 0.0.4.
- **`until` must be later than `since`** when both are supplied
  (rejected at the schema layer).

General-purpose hygiene:

- Removed deployment-specific references so the connector reads as the
  general-purpose tool it is. Tool descriptions (which ship to every
  client over MCP) now use neutral examples instead of one instance's
  group names; docs use `example.org` placeholders and describe the
  Cloud Run / IaC deployment pattern generically rather than naming a
  specific operator's repos. No behaviour change.

## 0.0.4 — 2026-05-29

Hardening + clearer errors from a full pre-release audit. No new tools,
no API shape changes; counts unchanged (8 reads + 4 writes + 2 b3 admin).

Security:

- **Rate limiter now keys on the source IP, not the OAuth client_id**
  (`src/http/transport.ts`). Under open DCR a caller can `POST /register`
  for unlimited fresh client_ids, so a client-id-keyed limit was
  bypassable — each new client got its own bucket. Keying on IP restores
  the intended "N per minute per source" bound (trust-proxy=1 makes
  `req.ip` the real client address on Cloud Run).

Clearer 403s on the membership tools (the original motivation):

- Loomio answers a 403 with a bare `{"error":403}` and returns that SAME
  body whether the key is invalid, the bot isn't a member, or the bot is
  a member but lacks the group-admin (coordinator) role that
  `b2/memberships` requires. Indistinguishable from the response alone,
  so a raw 403 reads as a bug when it's usually a deliberate permission
  boundary (the bot is kept non-admin so it can't read everyone's email).
- New access classifier (`src/loomio/access.ts`): on a 403 from an
  admin-gated call it probes the member-gated `b2/polls?group_id=N` with
  the same key. Probe 200 → key valid, bot is a member, just not an admin;
  403 → invalid key or not a member; anything else → inconclusive. One
  extra GET, only on the rare 403 path; if the probe itself errors the
  original 403 is preserved rather than masked.
- `list_memberships` / `manage_memberships` now raise a tailored error
  explaining which case applies and what to do, and point at the
  non-admin fallback: names / usernames / ids (not email) via
  `get_user_activity` / `list_events`. NOTES-ON-LOOMIO-API.md "Gotcha 5"
  documents the behaviour (verified live).

`get_user_activity` robustness:

- **Global fan-out budget.** The per-group and per-discussion page caps
  multiplied with no overall ceiling; `MAX_SCAN_DISCUSSIONS` now bounds
  the expensive event-fetch stage so one public, auto-approvable call
  can't run away on a large instance.
- **Completeness signals.** The result's `scope` now carries `complete`,
  `groups_failed`, `discussions_failed`, `discussions_truncated`, and
  `discussions_capped`. Previously a group that 403'd mid-scan was
  silently dropped and the partial total looked authoritative — bad for
  the tool's headline participation-analysis use. Partial scans are now
  flagged so they're reported as partial.
- **`since` / `until` are validated.** An unparseable timestamp used to
  slip through and silently disable the time filter (NaN comparisons are
  always false), turning a bounded query into a full-history scan that
  still looked bounded. Now rejected at the schema layer.

Other:

- `redactPath` (`src/log.ts`) also redacts alphanumeric short-keys after
  `discussions` / `polls`, not just numeric ids — matches the documented
  "ids are de-identified" invariant now that verbose logging is on in
  production. (The api_key was never at risk; the query string is
  dropped regardless.)
- MCP server `version` synced to the package version.
- Docs: README tool catalog now lists `list_events` / `get_user_activity`
  (added in 0.0.2 but missed from the README list); DEPLOY.md leads with
  the open-DCR + readonly recipe and the custom-domain `PUBLIC_BASE_URL`;
  SECURITY.md gains an "HTTP / multi-user posture" section (open DCR,
  shared bot key, bot-memberships-as-boundary, the IP-keyed limiter, the
  403 fence). Readonly deployments advertise 8 tools, local stdio 12,
  with b3 14.

Deployment (tracked in the separate infrastructure repo, not here): the
reference Cloud Run service gained a 60s request timeout, instance/
concurrency caps matched to the fan-out workload, and a config toggle
for verbose logging.

## 0.0.3 — 2026-05-28

Tool-selection tuning. No new tools, no API changes — just rewrites
of the descriptions Claude reads when deciding which tool to call.

Motivation: in two real consumer chats analysed by the maintainer,
Claude reached for `list_polls` + `list_memberships` and reconstructed
participation client-side instead of calling `get_user_activity`,
even though the latter answers the question directly. The
reconstruction is more expensive AND ambiguous (you can't tell
"didn't vote" from "abstained" by reading a poll record alone). This
release rewires the descriptions so the right tool wins.

Description changes (counts unchanged: 8 reads + 4 writes + 2 b3 admin):

- `get_user_activity` — major rewrite. Explicit framing as the
  primary entry point for any user-centric question — single OR
  multi-user. Adds the pattern "for an N-user comparison, **call
  this tool N times**" with example phrasings: "compare participation
  across two groups", "rank members of group N by participation",
  "build a participation card for each member".
  Reframes the cost as amortised (the same `list_discussions` fetch
  serves every per-user call in the same conversation) and explains
  the canonical-stream advantage over a `list_polls`-based
  reconstruction.

- `list_polls` — adds a cross-ref at the end: for per-user
  participation questions, prefer `get_user_activity`. Calls out the
  abstain-vs-didn't-vote ambiguity that `list_polls` cannot resolve.

- `list_memberships` — adds an explicit "do NOT use this to construct
  a participation analysis" warning, redirecting to `get_user_activity`
  per member.

- `list_events` — adds a "do NOT loop this over every discussion
  yourself" warning, redirecting to `get_user_activity` for any
  cross-discussion user-centric question.

The data-driven follow-up — whether to add a `get_group_summary`
composite — is deferred until verbose logs from production show
whether description tuning alone closes the gap.

## 0.0.2 — 2026-05-28

Two new read tools surfacing Loomio's event stream — the connector
now answers user-centric and per-thread activity questions, not just
"what groups / discussions / polls exist".

New tools (counts: 8 reads + 4 writes + 2 b3 admin):

- `list_events(discussion_id, limit?, offset?, kinds?)` — thin
  pass-through to `GET /api/v1/events?discussion_id=X`. Returns every
  event in the thread (new_comment, reaction, stance_created,
  outcome_created, discussion_moved, etc.) with `actor_id`, `kind`,
  `parent_id`, `created_at`, plus embedded `comments` / `users` /
  `polls` arrays for in-place resolution. Optional `kinds`
  filter is client-side; Loomio's server doesn't filter on kind.
  Membership-gated (no admin required); discussion must be visible
  to the api-key user.

- `get_user_activity(user_id, group_ids, since?, until?)` —
  server-side aggregation. Fans out across the supplied groups:
  list_discussions per group, list_events per discussion, filter by
  actor_id, aggregate. Returns `counts` (total + per kind),
  `by_group`, `by_month`, `first_activity` / `last_activity`,
  10-event sample. `group_ids` is required (1-50) so the cost is
  explicit; pass `list_groups` output for instance-wide scans.
  Concurrency-capped at 6.

Why two tools: Loomio has no per-user event index. `/v1/events`
returns 0 events without an explicit `discussion_id`; `actor_id`
and `group_id` are silently ignored as standalone filters. So the
primitive is per-discussion only, and the composite has to fan out.
Verified empirically — see NOTES-ON-LOOMIO-API.md.

Other changes:

- Documentation rewrite for accuracy + navigability: README has a
  docs-map table; tool catalog is single-sourced there;
  CONTRIBUTING.md now documents the doc-update steps that go with
  adding a tool. Cross-repo links bridge the connector, the
  infrastructure repo, and the image-build repo.
- `encodePathSegment` rejects `""` / `"."` / `".."` defence-in-depth
  before URL-encoding.
- `list_groups` schema caps per-call probe span at 500 ids and
  rejects inverted ranges.
- `LoomioAuthError` now carries the HTTP status code; non-403
  auth failures propagate as errors instead of silently returning
  empty results.

## 0.0.1 — 2026-05-27

First tagged release. The connector has been live-tested against a
self-hosted Loomio 3.0.24 instance and the production Cloud Run
deployment is serving real traffic. Expect rough
edges — only one upstream Loomio instance exercised so far; some b2
endpoints have known upstream bugs (see NOTES-ON-LOOMIO-API.md).

Initial scaffolding. Targets Loomio's b2 API (the canonical surface).
See DESIGN.md / NOTES-ON-LOOMIO-API.md for the b1-vs-b2 rationale.

Tools registered:

- Reads (always): `get_discussion`, `list_discussions`, `get_poll`,
  `list_polls`, `list_memberships`, `list_groups`.
- Writes (skipped when `LOOMIO_MCP_READONLY=1`): `create_discussion`,
  `create_poll`, `manage_memberships`, `create_comment`.
- b3 admin (registered only when `LOOMIO_B3_API_KEY` is set AND not
  readonly): `deactivate_user`, `reactivate_user`. Server-instance
  secret distinct from the per-user `LOOMIO_API_KEY`.

Cloud Run production runs readonly → 6 tools advertised. Local stdio
with no flags → 10 tools. With `LOOMIO_B3_API_KEY` → 12 tools.

Behaviour:

- `list_groups`: probes `b2/polls?group_id=N&limit=1&status=all` over
  an id range (Loomio has no api-key-authed list-groups endpoint).
  Defaults `start_id=1`, `end_id=200`, `stop_after_consecutive_misses=50`;
  schema-capped at 500 ids per call. Returns slimmed group records.
- `create_discussion`: auto-resolves `private` by GETting
  `v1/groups/{id}` first to match the group's `discussion_privacy_options`;
  falls back to `true` on 403.
- `create_comment`: posts form-encoded body (Rails wrap_parameters
  bug on JSON for that endpoint).
- All tools carry the full 4-flag MCP `ToolAnnotations` set
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  so Claude.ai can auto-approve reads.

Transports: stdio (local) + HTTP/OAuth (Cloud Run).

Body shape: all writes send flat top-level fields; wrapping under
`{discussion: ...}` etc. silently produces empty records.
