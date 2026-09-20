# Design

Short notes on the load-bearing choices. Loomio facts are stated
against Loomio 3.8.1 (`TESTED_LOOMIO_VERSION` in `src/version.ts`);
NOTES-ON-LOOMIO-API.md has the line-by-line evidence.

## Surface area

All non-admin tools target the **b2** API (`/api/b2/...`), with auth
via `Authorization: Bearer <api_key>`. This is the namespace where
Loomio's controllers live in the open-source repo (the `b1` namespace
was removed in Loomio 3.1.0) and the one Loomio's OpenAPI document
describes. The canonical b2 docs are at https://www.loomio.com/help/api2.

The **b3** namespace uses a separate auth secret — a bearer token
validated against `ENV['B3_API_KEY']` on the Loomio server, >16 chars.
This is a server-instance admin secret, not a per-user key. The
connector wraps two of its routes, the member routes
`POST /b3/users/{id}/deactivate` and `POST /b3/users/{id}/reactivate`
(Loomio's OpenAPI marks the older `?id=` collection routes
`deprecated: true`). Since Loomio 3.1 the namespace also offers user
listing, show/update/destroy/redact and lookup by external identity;
the connector deliberately does not wrap those, but the secret unlocks
them (SECURITY.md). Tools are registered only when `LOOMIO_B3_API_KEY`
is set (and skipped in readonly mode).

The internal `v1` API (~37 controllers — groups, stances/votes,
reactions, search, …) is out of scope for this connector. That isn't
an oversight; v1 is fundamentally hostile to programmatic third-party
access on the loomio.com SaaS:

- **Auth wall.** Both session creation (`POST /api/v1/sessions`) and
  the magic-link flow (`POST /api/v1/login_tokens`) require a
  Cloudflare Turnstile token in the request. Turnstile tokens are
  obtained from a browser challenge — they can't be generated
  server-side. So there is no headless login path against the SaaS.
- **CSRF on writes.** v1 controllers inherit `ProtectedFromForgery`
  (b2 explicitly skips it). Even with a hand-pasted session cookie,
  POST/PATCH/DELETE need a CSRF token scraped from a prior GET.
- **Cookie lifecycle.** Sessions expire (Loomio's config: ~2 weeks). A
  connector that needs the user to re-paste cookies on a fortnightly
  cadence is a poor experience.

Two v1 endpoints are exceptions the connector has relied on. The
unauthenticated `GET /api/v1/boot/version` (`{ "version": "3.8.1", … }`)
is what the key-health probe reads for the instance's Loomio version —
public, no credential sent. And `GET /api/v1/events?discussion_id=` is
what `list_events` / `get_user_activity` read until Loomio 3.4.0
(August 2026) replaced the Event model with TopicItem and removed the
endpoint. v1 never honoured the API key — it resolves `current_user`
from the session cookie only, so the bearer header the client sent was
ignored — which means those reads ran anonymously and covered only
**public** discussions, whatever the connector user's memberships.
(The same is true of the `GET /api/v1/groups/{id}` privacy resolver in
`create_discussion`: an anonymous read that 200s for public groups and
403s for hidden ones.) Both tools now fail with a clear error against a
≥ 3.4.0 instance rather than returning empty data; the port to the b2
successor `GET /api/b2/threads/{topic_id}/items` is 0.0.12 — and since
that endpoint runs as the key's user, the port also widens what is
visible to the private threads the user belongs to, one more reason it
is a release of its own.

A self-hosted Loomio with `TURNSTILE_SECRET_KEY` unset removes the
auth wall, so v1 could be wrapped there — but that's a niche enough
deployment that it's left as a future opt-in (e.g. behind a
`LOOMIO_SESSION_COOKIE` env var) rather than part of the default tool
catalog.

## Flat bodies (no resource-name wrapping) — re-verification pending

The connector was built against a b2 base controller whose
`permitted_params` *stripped* the incoming `:discussion` / `:poll` keys
before re-wrapping under the resource name. So a body like
`{discussion: {title, …}}` lost its wrapper, leaving empty params that
were re-wrapped to `{discussion: {}}` — an empty record with zero
validation errors, silent data loss. Flat top-level fields were the only
shape that worked, and that is what the connector sends. For the
comments endpoint the connector posts form-encoded with `discussion_id`
in the URL query (NOTES-ON-LOOMIO-API.md, Gotcha 2).

Loomio 3.1.3 (July 2026) changed the rule: `permitted_params` now
**prefers** a wrapped resource hash when one is present
(`params[resource_name].respond_to?(:permit)`) and only otherwise strips
`api_key` / `format` / `controller` / `action` / `discussion` / `poll` /
`id` and wraps the flat remainder. Read from the source, the flat shape
should therefore still be accepted; the b2 comments controller lost its
own override in the same release and reads top-level `discussion_id`
directly. This release (a hotfix) leaves the write path untouched; the
flat and form-encoded shapes are re-verified against a live Loomio ≥ 3.8
in 0.0.12, and that verification — not source reading — is what will
settle the shape.

## Probe-based group enumeration (until 0.0.12)

`list_groups` exists because, when it was written, Loomio had no
api-key-authed endpoint that returned the caller's group list: v1's
`profile/groups` needs a session, the v1 `explore` endpoint returns only
publicly-listed groups, and b2 had no `groups` resource. So the tool
probes: one `b2/polls?group_id=N&limit=1&status=all` per candidate id
over a range, collecting the group objects side-loaded in the 200
responses.

Loomio 3.1.0 added `GET /api/b2/groups` (`current_user.groups`) and
`GET /api/b2/groups/{id}`. This hotfix release does not adopt it —
that port is 0.0.12 — but it does use the index as the key-health probe
(see below), because it answers 200 for any valid key, even one with no
groups.

What each probe status means today (Loomio 3.8.1):

- 200 → the group exists and `can?(:show, group)`: the connector's user
  is a member, **or the group is publicly visible** (Loomio ≥ 3.8 lets
  any authenticated user read public groups), or it is a subgroup
  visible to parent-group members. Instance `is_admin` is **not**
  consulted — the earlier claim that an admin "sees every group" was
  true before 3.8 and is false now.
- 404 → no group with that id.
- 403 → the group exists but is not visible to the connector's user —
  **or** the API key is rejected, in which case every probe looks
  exactly like this (authentication runs before the group lookup).

Two consequences shape the tool. First, the **blind spot**: the group
object reaches the response only as a side-load of the polls that
reference it, so a group with no polls is never discovered even when
the user can read it. A missing group is not proof of invisibility;
the description says so, and the empty result carries a note. Second,
the **rejected-key trap**: an all-403 scan and a no-visible-groups scan
are indistinguishable per probe, so when the scan finds nothing the tool
asks the cached key-health verdict and, on `rejected`, throws instead of
returning `groups: []`.

Why `b2/polls` rather than the other list endpoints, then and now:
`b2/memberships` answers a non-member with `200 []` (Loomio ≥ 3.8; it
was 403 before), so it cannot tell "member" from "not a member" — the
one thing an enumeration needs; `b2/discussions` and `b2/polls` both go
through the same visibility gate, and polls was the cheaper of the two.

The 500-id per-call cap is the load-protection lever (one HTTP call
per probed id; default scans of 1..200 cost ~50–200 outbound calls).
Loomio's own Rack::Attack throttle is 900 requests per 5 minutes per
client IP, which is the other reason the native listing cannot come
soon enough.

## Honest failures over plausible zeros

The 0.0.11 hotfix exists because several tools produced results that
were *technically labelled* but read as facts: `get_user_activity`
returned `counts.total: 0` with `scope.complete: false` when every
event fetch had 404'd, and an agent relayed it as "this person never
participated"; `list_groups` returned `groups: []` when the key was
dead; `list_memberships` returned `[]` for a group the user was not in,
indistinguishable from an empty group. The rule now applied
throughout:

- A result that counted **nothing** for a reason unrelated to the data
  is an **error**, not a result. `get_user_activity` probes the first
  discussion alone and throws on the removed-endpoint 404; it also
  throws when every group listing failed, or when every event fetch
  failed. `list_events` throws on that 404. `list_groups` throws on a
  zero-group scan with a rejected key.
- A result that is **partial** stays a result, with the existing
  `scope.*` completeness flags — partial data is useful; fabricated
  completeness is not.
- A result whose emptiness is **ambiguous** carries a note saying what
  it can and cannot mean (`list_memberships` → `scope.note`,
  `list_groups` → `scanned.note`).

Tool descriptions state each limitation plainly, because the model
reading them is the last line of defence against a confident wrong
answer.

## 403 classification

Loomio ≥ 3.1.1 answers 403 with a body that says why (before that, a
bare `{"error":403}` for everything — which is what the connector's
former "probe fence" in `src/loomio/access.ts` worked around, and why it
is gone). `classifyForbidden` in `src/loomio/client.ts` is a pure
function over the body text, unit-tested per shape:

| Body | Meaning | Kind |
|---|---|---|
| non-JSON, or JSON whose `type` URL names cloudflare | a CDN/WAF answered; Loomio never saw the request | `waf` |
| `"You are not authorized to access this page."` | unauthenticated — no active user owns the key (rotated?); on the `b2/discussions` and `b2/polls` `?group_id=` lists also "group not visible" (never on `b2/memberships` or a `/:id` read) | `unauthenticated` |
| `"Not authorized to <action> <Model>."` | valid key, user lacks permission for that record/action | `not_authorized` |
| `"User is not an admin"` | `manage_memberships` without the coordinator role on that group | `not_admin` |
| numeric body, or `action: "upgrade"` | subscription / plan cap | `plan_limit` |
| anything else | surfaced verbatim | `unknown` |

The classifier is path-aware (only the two visibility-gated lists may
hedge towards "group not visible") and receives the key-health cache's
verdict **only while it is fresh** (younger than the 60 s cache): a
fresh `rejected` makes the unauthenticated case definitive, a fresh
`valid` on a gated list points at visibility first, and a stale
verdict is ignored — the startup probe under stdio may be days old, and
a stale `valid` must never make a post-rotation 403 read as "not a key
problem". A 401 is mapped separately and per namespace: Loomio's b2/b3
API answers its own authentication failures with 403, so a 401 on a
b2/b3 path came from something in front of Loomio; Loomio's v1 API can
itself answer 401 (`require_current_user`) because it is a
session-cookie API and the key is not a v1 credential. 429
(Rack::Attack, `text/plain`) becomes a clear retry message with
`Retry-After` when present. Every echo of upstream text is clipped to
200 characters — a CDN's HTML error page must not land whole in an
agent's context.

## Key-health probe

A connector that sees a request every few days can be broken for weeks
before an error-rate alert has enough samples to fire — and a rotated
Loomio key breaks it *silently* (every call is the same 403; the
process is healthy). Loomio rotates a user's key on password change,
rotated every key once in 3.3.1, and publishes no compatibility policy.
So the connector probes actively (`src/loomio/health.ts`):

- `GET /api/b2/groups` with the key — 200 for any valid key (even with
  zero groups), 403 with Loomio's unauthenticated body for a rejected
  one; a WAF 403 or any other failure is `unreachable`, never a false
  "rejected". Plus the public `GET /api/v1/boot/version` for
  `loomio_version`, whose failure never affects `key_status`.
- Cached 60 s with a shared in-flight promise: `/health`, startup and
  the tools that consult it cost Loomio at most one request pair per
  minute in aggregate.
- Every `key_status` change emits a **forced** `loomio.auth` event
  (bypassing the verbose gate — the one event an operator must see
  without having anticipated it); a one-time forced
  `loomio.version_drift` fires on a `major.minor` mismatch with
  `TESTED_LOOMIO_VERSION`.
- Startup probes but never exits on the verdict: a transient network
  error must not kill the server, and a running process with classified
  403s and a red `/health` is more diagnosable than a crash loop.
- `GET /health` (HTTP) returns `{status, connector_version, key_status,
  loomio_version, checked_at}` — 200 iff valid, else 503, `no-store` —
  so an uptime checker's whole rule is "200 and body contains
  `"key_status":"valid"`". It is unauthenticated (checkers cannot do
  OAuth), per-IP rate-limited, and exposes nothing else.

The cache lives in `src/loomio/health-cache.ts` rather than in
`health.ts` so the HTTP client can *read* the verdict (to make its 403
message definitive) without importing the probe that *uses* the client
— no import cycle.

## API-key injection

Both Loomio public APIs (b2 and b3) take their auth secret in an
`Authorization: Bearer` header — the per-user key for b2, the
server-instance secret for b3. Loomio rejects keys in the query string
(changed July 2026). There is one injection point, `authHeaders()` in
`src/loomio/client.ts`; `buildUrl()` builds a URL that carries no
credential at all, and `loomioGetPublic` sends no credential for the
one public endpoint the probe reads. Every request carries
`User-Agent: loomiomcp/<version>` (`USER_AGENT`), because a CDN/WAF in
front of an instance may block default library user-agents and because
operators should be able to find the connector in Loomio's logs. This
means:

- Keys never leak into structured logs (no headers are logged, and
  `src/log.ts`'s `redactPath` drops query strings and collapses ids and
  string keys besides).
- A base-URL override is validated to be `https://` (or `http://` on
  loopback) — sending the bearer token to an arbitrary http host would
  expose it to anyone on the path.

## Read-only mode

`LOOMIO_MCP_READONLY=1` does two things:

1. Skips registration of all write tools in `src/server.ts`
   (`create_*`, `manage_*`, `deactivate_user`, `reactivate_user`).
2. Causes `loomioPost` / `loomioPostB3` in `src/loomio/client.ts` to
   throw before issuing the HTTP request.

The first removes them from the catalog (the MCP client can't see
them); the second is the defence in depth.

## `manage_memberships` safety

`POST /b2/memberships` with `remove_absent` is irreversible, and wider
than it looks: it revokes pending invitees too, cascades to subgroups,
and removes the connector's own user if its email is absent. The tool
description, schema field description, and `destructiveHint: true`
annotation in `src/server/register-tool.ts` all flag it; the default of
`remove_absent: false` keeps the additive case ergonomic. On the wire
the flag is the integer `1` or absent — Loomio reads
`params[:remove_absent].to_i == 1`, and a JSON boolean makes it 500
*after* the invitations went out. `deactivate_user` also carries the
destructive hint. See SECURITY.md.

## Tool annotations

`inferAnnotations` in `src/server/register-tool.ts` returns the full
four-flag MCP `ToolAnnotations` set for every tool —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
Per MCP spec, `destructiveHint` defaults to `true` when unset, and
`readOnlyHint` defaults to `false`. A tool that only advertises
`{readOnlyHint: true}` is read by spec-compliant clients as
"read-only, but may also be destructive" — contradictory — and
conservative clients (Claude.ai's auto-approval flow included) fall
back to per-call prompting. Emitting all four flags explicitly removes
the ambiguity and lets the connector's reads auto-approve in
Claude.ai.

## What we deliberately don't have

- **No data cache layer.** The capsulemcp sibling caches reference-data
  endpoints (`list_pipelines`, `list_boards`) because LLM chains
  re-query them. Loomio's surface has no equivalent — `list_memberships`
  IS the authoritative read for any membership write, so caching it
  would mask the very thing the caller is checking. The only cache in
  the codebase is the 60 s key-health verdict, which caches a yes/no
  about the credential, not data, and exists to keep `/health` from
  becoming a way to make the connector hammer Loomio.
- **No retry on 429.** Loomio's throttle is per client IP over five
  minutes; a retry loop inside a tool call would only deepen the hole.
  The connector maps 429 to a clear message naming the fan-out tools
  that usually cause it; retiring those fan-outs (0.0.12) is the real
  fix.
- **No async task store.** Loomio writes are single-request and fast;
  the sibling's task-polling surface adds complexity we don't need.
- **No batch fan-out helper.** A future `batch_manage_memberships`
  across groups would re-introduce this — at that point, the
  capsulemcp shape (concurrency-capped `Promise.allSettled` with
  per-item idempotency and a `batch.complete` event) is the
  reference. Until then, keeping the codebase smaller is the win.
