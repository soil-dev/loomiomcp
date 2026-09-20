# Notes on the Loomio public APIs

Empirical / source-verified behaviour that informs the tool schemas.
Update as we learn more.

Unless a section says otherwise, "current" means **Loomio 3.8.1** (tag
`v3.8.1`, 2026-09-18) — the release this connector is verified against
(`TESTED_LOOMIO_VERSION` in `src/version.ts`). Facts are taken from
Loomio's source at that tag: `config/routes.rb`,
`app/controllers/api/b2/*.rb`, `app/controllers/api/b3/users_controller.rb`,
`app/controllers/api/v1/snorlax_base.rb`, `app/serializers/*.rb`,
`test/controllers/api/b2/*_test.rb`, and the OpenAPI document at
`docs/user_manual/integrations/api/openapi.yaml`. Sections marked
**historical** describe older Loomio behaviour and are kept so the
connector's own history stays legible; they are not current guidance.

## Why b2 is the canonical surface

Loomio's `/api/...` namespaces, as of 3.8.1:

- **`b2`** — the *User API*: documented at
  https://www.loomio.com/help/api2 and in Loomio's own OpenAPI document.
  Controllers in `app/controllers/api/b2/` are the implementation;
  authentication is the per-user API key as a bearer token, and every
  request runs with that user's permissions. **All non-admin tools in
  this connector hit `/b2/...`.** (The older `b1` namespace was removed
  in Loomio 3.1.0.)
- **`b3`** — the *Server API*: a different secret (bearer token
  validated with `secure_compare` against `ENV['B3_API_KEY']` on the
  Loomio server, >16 chars). Since 3.1 it covers user index / show /
  update / destroy / redact, deactivate / reactivate, and lookup by
  external identity. The connector wraps only `deactivate` and
  `reactivate`, behind opt-in `LOOMIO_B3_API_KEY`.
- **`v1`** — Loomio's internal browser API (~37 controllers). It
  authenticates by session cookie (plus Cloudflare Turnstile on login)
  and does **not** read the API key; see DESIGN.md. Two v1 endpoints
  matter to the connector regardless: `GET /api/v1/boot/version` is
  public and answers `{ "version": "3.8.1", … }` (the health probe reads
  it with no credential), and `GET /api/v1/events` was what
  `list_events` / `get_user_activity` read until Loomio 3.4.0 removed
  it (see "Loomio 3.1 → 3.8 changes" below).

## Auth

API key passed in an HTTP bearer header:

```text
Authorization: Bearer API_KEY
```

`Api::B2::AuthenticatesApiKey#current_user` is
`User.active.find_by(api_key: bearer_token.presence || request.request_parameters[:api_key])`
— so the key is read from the `Authorization` header, or (undocumented,
POST bodies only) from a body parameter; **never** from the query
string. The connector uses the header for reads and writes alike.

**Changed 2026-07-25 (Loomio 3.1.3).** Previously the key travelled as
`?api_key=…` in the query string. A request carrying it that way is now
treated as unauthenticated and answers
`403 {"error":"You are not authorized to access this page."}` — the same
body as a wrong or rotated key. (Older notes here said this body was
"byte-identical to the response for a missing role"; that was true of
Loomio ≤ 3.1.0, whose 403 was a bare `{"error":403}` for everything.
Since 3.1.1 role failures carry their own message — see "Error shapes".)
`tests/loomio-auth.test.ts` pins the bearer scheme.

**The key rotates.** Loomio regenerates a user's `api_key`:

- whenever that user's password changes
  (`UserService.rotate_credentials_after_password_change`, Loomio ≥ 3.1.0
  — it also rotates `email_api_key`, `secret_token`, `unsubscribe_token`,
  destroys unused login tokens and signs out other sessions);
- once for every user, by migration `RotateExposedUserApiKeys` in Loomio
  3.3.1 (2026-08-24), because group exports had contained keys;
- on account redaction (`RedactUserWorker`).

A deactivated user's key stops authenticating (`User.active`). The
current key is shown on the user's API access page,
`/profile/api_access`; no API returns another user's key (the b3 user
payload does not include it). The connector's key-health probe
(`src/loomio/health.ts`) exists because of this — see DEPLOY.md.

Consequences:

- No credential ever appears in a URL, so nothing to leak via access
  logs. `src/log.ts` still drops query strings as defence in depth, and
  no headers are logged.
- Override base URLs are gated to https / loopback http in
  `src/loomio/client.ts`.
- Every request carries `User-Agent: loomiomcp/<version>`. Not for
  Loomio's sake — for the CDN/WAF that may sit in front of it (Cloudflare
  blocks default library user-agents with a 403 that never reaches
  Loomio; the connector recognises that body).

## Base URL

`https://www.loomio.com/api` — version (`b2` / `b3` / `v1`) is part of
each path so a single client serves all namespaces.

## Endpoints wrapped

### b2 (per-user api_key)

| Method | Path | Tool |
|---|---|---|
| GET | `/b2/discussions/{id_or_key}` | `get_discussion` |
| GET | `/b2/discussions?group_id=…&status=…&limit=…&offset=…` | `list_discussions` (always sends `status`, default `open`) |
| POST | `/b2/discussions` | `create_discussion` |
| GET | `/b2/polls/{id_or_key}` | `get_poll` |
| GET | `/b2/polls?group_id=…&status=…&limit=…&offset=…` | `list_polls` |
| POST | `/b2/polls` | `create_poll` |
| GET | `/b2/memberships?group_id=…&limit=…&offset=…` | `list_memberships` |
| POST | `/b2/memberships` | `manage_memberships` |
| POST | `/b2/comments?discussion_id=…` | `create_comment` |
| GET (probe) | `/b2/polls?group_id=N&limit=1&status=all` | `list_groups` (one call per probed id; see "Gotcha 4") |
| GET (probe) | `/b2/groups` | key-health probe (`/health`, startup, `list_groups` empty-scan check) — not a tool |

### v1 (no credential, or none honoured)

| Method | Path | Used by |
|---|---|---|
| GET | `/v1/boot/version` | key-health probe — public, sent **without** the key; `{version}` |
| GET | `/v1/events?discussion_id=…&per=…&from=…` | `list_events`, `get_user_activity` — **removed in Loomio 3.4.0**; 404 → clear error |
| GET | `/v1/groups/{id}` | `create_discussion`'s privacy resolver (see Gotcha 1) — an anonymous read; v1 ignores the API key |

### b3 (server-instance secret; opt-in via LOOMIO_B3_API_KEY)

| Method | Path | Tool |
|---|---|---|
| POST | `/b3/users/{id}/deactivate` | `deactivate_user` |
| POST | `/b3/users/{id}/reactivate` | `reactivate_user` |

The collection routes `POST /b3/users/deactivate?id=` /
`…/reactivate?id=` still exist but are `deprecated: true` in Loomio's
OpenAPI document ("legacy query-ID route"); the connector switched to
the member routes in 0.0.11.

### Available in Loomio 3.8.1, not yet wrapped

| Method | Path | Since | Planned use |
|---|---|---|---|
| GET | `/b2/groups`, `/b2/groups/{id_or_key_or_handle}` | 3.1.0 | native `list_groups` (0.0.12) |
| GET | `/b2/threads`, `/b2/threads/{topic_id}`, `/b2/threads/{topic_id}/items`, `/b2/threads/{topic_id}/markdown` | 3.1.0 | successor to `v1/events` (0.0.12) |
| PATCH / DELETE | `/b2/discussions/{id}`, `/b2/polls/{id}`, `/b2/comments/{id}` | 3.1.0 | update_/delete_ tools |
| GET | `/b2/reports` | 3.7.0 | participation report (candidate `get_user_activity` replacement) |
| GET | `/b2/search` | 3.8.0 | full-text search over visible content |
| * | `/b2/chatbots` | 3.8.0 | outgoing webhooks (group admins only) |

## Request body shape: flat — re-verification pending

**Current (Loomio ≥ 3.1.3).** `Api::B2::BaseController#permitted_params`
looks at `params[resource_name]` first. If that is a params hash (a
wrapped body such as `{discussion: {title, group_id}}` was sent) it is
used as the resource params. Otherwise it strips `api_key`, `format`,
`controller`, `action`, `discussion`, `poll` and `id` from the top-level
params and wraps the remainder under the resource name — the flat
shape. So, read from the source, **both** shapes are accepted and the
wrapped one takes precedence. The b2 comments controller has no
`permitted_params` override any more; it reads a top-level
`discussion_id` and sets the comment's parent from it.

**What the connector sends** (unchanged in 0.0.11): flat top-level
fields for discussions and polls; for comments a form-encoded body with
`discussion_id` in the URL query (Gotcha 2). Loomio's own controller
test for `manage_memberships` posts a flat body. The write path is
re-verified against a live Loomio ≥ 3.8 in 0.0.12; until then treat
this section as "should work per source", not "verified live".

**Historical (Loomio ≤ 3.1.2).** The base controller *deleted* the
incoming `:discussion` / `:poll` keys before re-wrapping, so a wrapped
body became `{discussion: {}}` — an empty record with no validation
error, silent data loss — and flat was the only working shape. That is
why the connector is flat-bodied.

## Pagination and response options

b2 list endpoints (`discussions`, `polls`, `memberships`, `groups`,
`threads`, `threads/{id}/items`) accept `limit` (default 50) and
`offset` (default 0); SnorlaxBase also accepts `per` / `from` as aliases.
We expose `limit` / `offset` only.

Since Loomio 3.8.0 collection reads that set `collection_count` carry an
exact pre-pagination `meta.total` (discussions, polls, memberships,
groups, threads, items); the field is **omitted**, not null, where no
total is defined. All b2 reads also accept `compact=1` — adds
`topic group parent membership reaction tag translation` to
`exclude_types` — and an explicit space-separated `exclude_types`. The
connector does not send either yet (0.0.12 payload plan); note that
`compact=1` removes the `topics[]` side-load that carries a thread's
counters (see "Topic side-load" below), so it is not a free win.

## Status filters

| Endpoint | Values | Loomio's fall-through when absent |
|---|---|---|
| `list_discussions` | `open` (`unlocked`) → `is_unlocked`; `closed` (`locked`) → `is_locked`; `all` → `kept` | **`kept` — every kept thread, locked ones included** (changed from `is_open` in 3.1.0). The connector therefore always sends `status`, default `open`. |
| `list_polls` | `active` (default) → `active`; `closed` → `closed`; `all` → `kept` | `active` |

## Poll types

`proposal`, `poll`, `count`, `score`, `ranked_choice`, `meeting`,
`dot_vote`. `proposal` has built-in agree/disagree/abstain options;
every other type requires the caller to pass `options`.

## Memberships

Loomio 3.8.1, `Api::B2::MembershipsController`, `MembershipQuery`,
`MembershipSerializer`, and `test/controllers/api/b2/memberships_controller_test.rb`.

**Reading (`GET /b2/memberships?group_id=`).**

- `accessible_records` is `MembershipQuery.visible_to(user:
  current_user).where(group_id:)`: **any member** of the group sees its
  roster — user id, name, username, `admin` / `delegate`, `title`,
  `accepted_at` (null = invited, not yet accepted), inviter — and so do
  admins of the parent group for subgroups visible to parent members.
  No admin role is needed (test: "group member can list names and roles
  without other members' email addresses").
- `user_email` is serialized only when the group is in the caller's
  `adminable_group_ids` (the controller passes them as
  `membership_email_group_ids`) or the caller invited that member
  (`MembershipSerializer#include_user_email?`). A plain member gets the
  roster **without** emails — silently, no error (test: "group admin can
  list member email addresses").
- A **non-member is not refused**: the query scopes to the caller's own
  groups, finds nothing, and the controller answers `200` with
  `memberships: []` (tests: "non-member cannot list a private group's
  memberships" and "instance admin not in group cannot list memberships
  or email addresses" both assert `:success` + empty). Instance
  `is_admin` does not widen this. That is why the connector adds
  `scope.note` to an empty roster.
- Unknown **or missing** `group_id` → 404 (`Group.find`, which raises
  `RecordNotFound` for a nil id as well; Loomio's own test "missing group
  id" asserts 404). There is no 400 path: the route is flat, nothing
  `require`s `group_id`.

**Writing (`POST /b2/memberships`).**

- `authorize_manage_group!`: the caller must be in the group's
  `adminable_group_ids`, else `raise CanCan::AccessDenied, "User is not
  an admin"` → `403 {"error":"User is not an admin"}`. Parent-group
  admin and instance admin do **not** count (tests: "instance admin not
  in group cannot add members" / "… remove members").
- Always additive for `emails` not already present
  (`GroupService.invite`).
- `remove_absent` is read as **`params[:remove_absent].to_i == 1`**
  (since Loomio 2.24.0; the OpenAPI document says "Pass `1`"). A JSON
  `true` has no `#to_i` in Ruby → `NoMethodError` → HTTP 500, **after**
  the invitations were sent. The connector sends the integer `1` or
  omits the key.
- When set, every current member (`User.active` with a membership in
  `group.memberships` — the *active* scope, which still contains
  pending invitees) whose email is not in the list is revoked via
  `MembershipService.revoke`, which cascades to the same user's
  memberships in subgroups. The caller's own membership is revoked if
  its email is absent. Empty `emails` → empty group. No server-side
  dry-run.
- Response: `{added_emails: [...], removed_emails: [...]}`.

## b3 admin (opt-in)

`Api::B3::UsersController` — bearer token `secure_compare`d against
`ENV['B3_API_KEY']` (must be >16 chars); a wrong or missing secret, *or
a server with no `B3_API_KEY` set*, answers the generic 403 body. No
per-user authorization is applied — the secret authenticates the server.
The connector's 403 classifier therefore names `LOOMIO_B3_API_KEY` on
`/b3/` paths — never the per-user key, `/profile/api_access` or the
`/health` verdict, which probes the b2 key.

- `POST /b3/users/{id}/deactivate`: finds the user in `User.active`
  (else 404), enqueues `DeactivateUserWorker` and answers
  `{ success: true, user: {…} }` **at once**; the echoed user can still
  show `active: true` / `deactivated_at: null`. The worker stamps
  `deactivated_at`, revokes active memberships (with that timestamp),
  revokes mobile devices and drops pending membership requests.
- `POST /b3/users/{id}/reactivate`: finds the user in `User.deactivated`
  (else 404), runs `UserService.reactivate` synchronously — clears
  `deactivated_at` and **restores the memberships whose `revoked_at`
  equals the deactivation timestamp** — and answers the same shape with
  `active: true`.
- `user` fields: `id, name, username, email, is_admin, active,
  deactivated_at, identities[]`. No `api_key`.

## Error shapes

All Loomio API errors are JSON (`render json:` in `Api::V1::SnorlaxBase`).
`src/loomio/client.ts` reads the body as text once and dispatches:

| Status | Body | Source | Connector |
|---|---|---|---|
| 400 | `{"error":400}` | `ActionController::UnpermittedParameters` / `ParameterMissing` | `LoomioApiError` |
| 403 | `{"error":"You are not authorized to access this page."}` | CanCan's default message for a bare `raise CanCan::AccessDenied` (Loomio's `server.en.yml` defines no `unauthorized.default`). Raised by `authenticate_api_key!` (no active user owns the key) on every b2 path; by `records_visible_in_group` — called **only** from `DiscussionsController#index` and `PollsController#index` (the GET index, not `#create` on the same paths) — when the group is not visible to the caller; by `PollService.invite` on `POST /b2/polls` for an anonymous poll that is not active (no future `closing_at`), **after** the poll was saved; and by `Api::B3::UsersController#authenticate_api_key!` on every b3 path when the bearer does not `secure_compare` to the server's `ENV['B3_API_KEY']` or that variable is unset / ≤ 16 chars — b3 never calls `authorize!`, so there it is the only 403 and it concerns `LOOMIO_B3_API_KEY`, not the per-user key. `MembershipsController#index` never raises it (a non-member gets `200 []`), `show` actions use `load_and_authorize` (the message-bearing body below), and `CommentsController#create` raises it only for a comment with no parent. | `LoomioAuthError` kind `unauthenticated`; the message hedges towards visibility only on the two gated lists **and only on GET**, names the poll exception on `POST /b2/polls`, is definitive ("key rejected") when a **fresh** (< 60 s) health verdict says so, and on `/b3/` paths names the b3 secret and ignores the health verdict (which probes the b2 key) |
| 403 | `{"error":"Not authorized to <action> <Model>."}` | CanCan `authorize!` with a message (`unauthorized.manage.all`) — per-record permission | kind `not_authorized`, message verbatim |
| 403 | `{"error":"User is not an admin"}` | `memberships#create` `authorize_manage_group!` | kind `not_admin` |
| 403 | `{"error":403}` | `respond_with_standard_error` for `Subscription::MaxMembersExceeded` | kind `plan_limit` |
| 403 | `{"error":"…thread limit…","action":"upgrade"}` | `respond_with_thread_limit_reached` (`Subscription::MaxThreadsExceeded`) | kind `plan_limit` |
| 403 | non-JSON, or JSON whose `type` URL names cloudflare (e.g. title "Error 1010: Access denied") | **not Loomio** — a CDN/WAF in front | kind `waf` |
| 404 | `{"error":404}` | `ActiveRecord::RecordNotFound`; also a plain Rails routing miss for a removed route (`/api/v1/events`) | `LoomioApiError` |
| 422 | `{"errors":{"field":["message", …]}}` | `ActiveRecord::RecordInvalid` | `LoomioApiError` with fields joined |
| 429 | `text/plain` "Retry later" (+ `Retry-After` only if the instance enables it) | Rack::Attack `throttle('req/ip', limit: 900 * RATE_MULTIPLIER, period: 5.minutes)`, keyed on client IP (`CF-Connecting-IP` when behind Cloudflare) | `LoomioApiError` with a retry message |
| 429 | `{"flash":{"error":"Daily invitation limit reached…"}}` | `ThrottleService::LimitReached` (invitations) | `LoomioApiError` with Loomio's message |
| 401 | anything, on a `/b2/` or `/b3/` path | **not Loomio's b2/b3** — both raise `CanCan::AccessDenied` for every authentication failure, rendered 403 by `SnorlaxBase`; a 401 here is a proxy / CDN / basic-auth gate in front | `LoomioAuthError` (status 401, no `kind`), explained as such |
| 401 | `{"error":"you gotta be signed in"}`, on a `/v1/` path | **Loomio itself**: `Api::V1::RestfulController#require_current_user` (a `before_action` on ~11 v1 controllers) and `SessionsController` render 401; v1 resolves its user from the session cookie only, so the API key is not a v1 credential. The connector's v1 calls (`groups#show`, `boot#version`) carry no such guard today | `LoomioAuthError` (status 401), message names both Loomio's session 401 and a possible proxy |

Loomio's error bodies since 3.1.1 also increment a Sentry
`http.forbidden` metric with the CanCan action, which is why they carry
the message.

## Loomio 3.1 → 3.8 changes that matter (written 2026-09-20)

Dates are commit dates from Loomio's repository; "release" is the
first tag containing the commit. Loomio publishes **no** API
deprecation or compatibility policy — its product changelog
(`docs/user_manual/changelog/`) mentioned the b3 bearer change and the
3.3.1 key rotation, and the only machine-readable markers are
`deprecated: true` flags in its OpenAPI document.

| Landed | Release | Change | Effect on the connector | Status |
|---|---|---|---|---|
| 2026-02-19 → 05-27 | 3.1.0 | **Topic model.** Threading state moved from Discussion/Poll to a `Topic` record. `DiscussionSerializer` gained `topic_id` + `has_one :topic` (root `topics`) and lost `items_count`, `last_activity_at`, `ranges`, `closed_at`/`locked_at`, `pinned_at`, `private`, `seen_by_count`, `members_count`, `max_depth`; `group_id` is now derived via the topic. `TopicSerializer` carries those counters (`items_count`, `last_activity_at`, `locked_at`, `active_polls_count`, …) plus reader state. `compact=1` (3.8.0) drops the `topics[]` side-load. | `list_discussions` / `get_discussion` still return the raw response; a thread's activity counters are in `topics[]`, joined by `topic_id`, not on the discussion. | Passthrough unchanged; join pending **0.0.12** |
| 2026-05-21 | 3.1.0 | b2 discussions default `status` fall-through `is_open` → `kept` (locked included); `open`/`closed` aliases kept. | Omitting `status` silently widened the list. | **Done 0.0.11**: always sent, default `open` |
| 2026-05-28 / 07-19 | 3.1.0 | `DiscussionService.build` / `PollService.build` derive topic `private` from the group when omitted (`TopicService.private_default`). | Gotcha 3 (`create_poll` 422 on public-only groups) is fixed upstream; `create_discussion`'s privacy resolver is redundant (harmless). | Re-verify live in **0.0.12** |
| 2026-06-12 | 3.1.0 | Rails sessions replace Devise; **password change rotates `api_key`** (`UserService.rotate_credentials_after_password_change`). | The connector's key dies whenever its user changes password. | **Done 0.0.11**: health probe, classified 403, runbook |
| 2026-06-23 | 3.1.0 | b2 `update` + `destroy` on discussions, polls, comments. | update_/delete_ tools become possible. | Future |
| 2026-06-23 / 07-06 | 3.1.0 | b3 reshaped: member routes `/b3/users/{id}/deactivate\|reactivate\|redact`, identity routes, index/show/update/destroy; response `{success: true, user}`; `b1` namespace removed. | Admin tools should use member routes; response is typed. | **Done 0.0.11** |
| 2026-06-30 | 3.1.0 | **`GET /api/b2/groups`** (`current_user.groups`, exact `meta.total`) and `GET /api/b2/groups/{id_or_key_or_handle}`. | Native replacement for the `list_groups` probe; 200 for any valid key → ideal key-health probe. | Probe **done 0.0.11**; native listing **0.0.12** |
| 2026-07-12 | 3.1.0 | Agent API: `GET /api/b2/threads`, `/threads/{id}`, `/threads/{id}/items` (ordered `TopicItem`s), `/threads/{id}/markdown`. | Successor to `v1/events` for `list_events` / `get_user_activity`. | **0.0.12** |
| 2026-07-24 | 3.1.1 | **403 bodies carry the CanCan message** (`respond_with_access_denied` renders `{"error": e.message}`; before: `{"error":403}` for everything). | A 403 can now be diagnosed from its body; the membership "fence" is obsolete. | **Done 0.0.11**: `classifyForbidden`; fence removed |
| 2026-07-24 | 3.1.2 | `MembershipSerializer#include_user_email?` gated on `membership_email_group_ids` (caller's adminable groups) or inviter. | Emails are admin/inviter-only, silently. | **Done 0.0.11** (docs, descriptions) |
| 2026-07-25 | 3.1.3 | **Bearer-only b2 auth**: query-string `api_key` rejected (body key still read, undocumented); `permitted_params` **prefers the wrapped resource hash** when present; comments controller override removed. | Query keys → generic 403 (fixed in 0.0.9). Flat write bodies should still be accepted per source. | Auth **done 0.0.9**; write bodies re-verify **0.0.12** |
| 2026-07-31 | 3.1.5 | b3 bearer-only (body/query `b3_api_key` rejected). | — | **Done 0.0.9** |
| 2026-08-24 | 3.3.1 | **Every user's `api_key` rotated** (migration `RotateExposedUserApiKeys`); exports exclude keys. | Every deployed connector's key died on the instance's upgrade day. | **Done 0.0.11**: detection + runbook |
| 2026-08-23 | 3.4.0 | **Event → TopicItem.** `/api/v1/events` (controller + route) removed; `/api/v1/topic_items` added for the browser; `eventable_*` → `itemable_*`, `discussion_id` → `topic_id`. | `GET /api/v1/events` is a routing 404. `list_events` / `get_user_activity` cannot work. | **0.0.11 fails loudly**; port to `/b2/threads/{id}/items` in **0.0.12** |
| 2026-09-16 | 3.7.0 | `GET /api/b2/reports` — participation report per group (delegates, votes issued/missed). | One call could replace the `get_user_activity` fan-out. | Future |
| 2026-09-17 | 3.8.0 | **Public visibility honoured in User API lists**: `records_visible_in_group` = `can?(:show, group)` + `TopicQuery.visible_to`; non-members read public groups' public topics (test: "index lets a non-member read public discussions without exposing private discussions"). | Access boundary = memberships **plus** public content (SECURITY.md); `list_groups` also discovers public groups. | **Done 0.0.11** (docs, descriptions) |
| 2026-09-17 | 3.8.0 | **Memberships**: any member lists the roster; emails admin/inviter only; **non-member → 200 empty**; `create` gated by `authorize_manage_group!` → `"User is not an admin"`. | `list_memberships` no longer 403s for role reasons; empty means "not a member". | **Done 0.0.11**: `scope.note`, descriptions |
| 2026-09-17 | 3.8.0 | **Instance `is_admin` removed from every b2 authorization check** (Loomio changelog: "Instance-administrator status no longer expands a User API key's access…"). | The "an `is_admin` user sees every group" claim is false. | **Done 0.0.11**: claim removed |
| 2026-09-17 | 3.8.0 | `compact=1`, documented `exclude_types`, exact `meta.total` (omitted when undefined); `GET /api/b2/search`; `/api/b2/chatbots`; OpenAPI 3.1 document in the repo. | Payload trimming; search tool; the OpenAPI file is the reference for shapes. | **0.0.12+** |

## Historical: Gotcha 5 — a 403 body of `{"error":403}` and "the fence" (Loomio ≤ 3.1.0)

Kept for the record; **not current**. On Loomio ≤ 3.1.0 every refusal
answered the byte-identical `{"error":403}`: a bogus key, a valid key
whose user was not a member, and (when `b2/memberships` was admin-only)
a member without the admin role. Verified live 2026-05-29 against a
3.0.x instance. Because the body carried no information, 0.0.4
introduced an "access fence" (`src/loomio/access.ts`): on a 403 from an
admin-gated call it probed the member-gated `b2/polls?group_id=N` with
the same key — probe 200 → "key valid, not admin"; 403 → "key invalid
or not a member"; other → indeterminate — and `list_memberships` /
`manage_memberships` threw a tailored message. Loomio 3.1.1 made the
403 body say why, Loomio 3.8.0 made `list_memberships` readable by any
member (a non-member gets an empty 200, not a 403), and the fence's
extra probe was one more request against Loomio's per-IP throttle. It
was removed in 0.0.11; `classifyForbidden` in `src/loomio/client.ts`
replaces it.

## Historical: verified live (2026-05-27 against a self-hosted Loomio 3.0.24)

Kept for the record. Several rows describe behaviour that has since
changed (see the table above); 0.0.12 re-verifies against a live
Loomio ≥ 3.8.

| Tool | Status then | Notes |
|---|---|---|
| `get_discussion` (id or key) | ✓ | |
| `list_discussions` | ✓ | |
| `get_poll` (id or key) | ✓ | |
| `list_polls` | ✓ | |
| `list_memberships` | ✓ | as an admin; today any member can list (without emails) |
| `list_groups` | ✓ | Probe-based; see "Gotcha 4" |
| `create_discussion` | ✓ | Connector auto-resolves `private` from the group's `discussion_privacy_options` (Gotcha 1) |
| `create_comment` | ✓ | Connector uses form-encoded body (Gotcha 2) |
| `manage_memberships` | ✓ | Additive path verified; `remove_absent` was sent as a boolean, which Loomio 500s on — fixed 0.0.11 |
| `create_poll` | ✗ | Upstream bug then (Gotcha 3); fixed in Loomio 3.1.0, not yet re-verified |

## Gotcha 1: discussion privacy is group-policy-dependent — the connector auto-resolves

Every Loomio group has `discussion_privacy_options ∈ {public_only,
private_only, public_or_private}`. The Topic validator (in
`app/models/topic.rb`) rejects any mismatch:

- `public_only` group + `private: true` → 422 "must be public"
- `private_only` group + `private: false` → 422 "must be private"
- `public_or_private` allows either

Topic's column defaults to `private: true`, so an omitted `private`
used to fail on every public-only group.

`create_discussion` in this connector auto-resolves when `private` is
omitted: it fetches `GET /api/v1/groups/{group_id}`, reads
`discussion_privacy_options`, and picks `false` only for `public_only`,
`true` otherwise. On 403 (the group is hidden) it defaults to `true` —
Loomio's GroupPrivacy validator forces every hidden group to
`private_only`, so that's the only valid choice anyway. Two current
caveats: v1 does **not** read the API key, so that fetch is an
*anonymous* read — it succeeds for publicly visible groups and 403s for
hidden ones, which is exactly the split the resolver needs, but it does
not depend on the key at all; and since Loomio 3.1.0
`DiscussionService.build` derives `private` from the group itself when
omitted (`TopicService.private_default`), so the resolver is redundant
on current Loomio. It is harmless and stays until 0.0.12 re-verifies
the write path. Callers can override by passing `private` explicitly,
which skips the fetch.

## Gotcha 2: `create_comment` is sent form-encoded

**Historical cause (Loomio ≤ 3.1.2).** Rails' `wrap_parameters format:
[:json]` is on globally, and `action_on_unpermitted_parameters = :raise`
in Loomio's `config/application.rb`. The old b2 base controller stripped
`:discussion` / `:poll` / `:discussion_id` / `:api_key` / `:format`
before re-wrapping under the resource name, but did **not** strip the
auto-wrapped `:comment` key when posting to `/b2/comments`. A JSON body
`{body, body_format}` became `{comment: {comment: {…}, body,
body_format}}`, the inner `:comment` was not permitted, strict mode
raised → HTTP 400 `{"error":400}`. Form-encoded bodies are not subject
to `wrap_parameters`, so the connector posts `/b2/comments` with
`Content-Type: application/x-www-form-urlencoded` (`PostOptions.encoding:
"form"` in `src/loomio/client.ts`) and `discussion_id` in the URL query.

**Current (≥ 3.1.3).** `permitted_params` now *prefers* a wrapped
`comment` hash, and the comments controller reads a top-level
`discussion_id` to set the parent — so a JSON body should also work.
The form-encoded path still works per source and is left as is until
0.0.12 verifies writes live.

## Gotcha 3: `create_poll` was broken upstream on public-only groups (Loomio ≤ 3.0.x)

**Historical.** `PermittedParams#poll_attributes` did not include
`:private` while `PollService.build` extracted it from the same params,
so a new poll's Topic always carried `private: true` (the DB default);
any group with `public_discussions_only?` then 422'd with an empty
`{"errors":{}}` (the errors sat on the cascaded Topic). No client-side
workaround existed.

**Current.** Loomio 3.1.0 added `TopicService.private_default(group_id:)`
(`!group.public_discussions_only?`), used by `PollService.build` and
`DiscussionService.build` when `private` is omitted, so the poll's
topic takes the group's policy. `create_poll` should therefore work on
public-only groups against Loomio ≥ 3.1.0; the tool was kept registered
throughout (schema per `/help/api2`) so it starts working as soon as
the instance is upgraded. Not yet re-verified live — 0.0.12.

## Gotcha 4: enumerating groups is by probe, not by query (until 0.0.12)

**Why the probe exists.** When `list_groups` was written b2 had no
`groups` resource; v1's `profile/groups` needs a session and v1's
`explore` returns only publicly-listed groups. So the tool probes a
`group_id` range against a list endpoint and collects the group objects
side-loaded in 200 responses. Loomio 3.1.0 added
`GET /api/b2/groups` (`current_user.groups`); the connector adopts it
in 0.0.12 and already uses it as the key-health probe.

**Why `b2/polls`** (still the probe endpoint):

- `b2/memberships?group_id=N` answers a **non-member with `200 []`**
  (Loomio ≥ 3.8; historically it was 403 because the endpoint was
  admin-only), so it cannot distinguish member from non-member — the
  one thing an enumeration needs. Rejected then and now, for different
  reasons.
- `b2/discussions?group_id=N` and `b2/polls?group_id=N` both go through
  `records_visible_in_group` (403 if `!can?(:show, group)`, else the
  visible topics with their group side-loaded via
  `TopicSerializer has_one :group`). Polls is the cheaper of the two.

**What each status means (Loomio 3.8.1, `Ability::Group`):**

- 200 → the group is kept and `can?(:show, group)`: the caller is a
  member, **or `is_visible_to_public`** (any authenticated user, since
  3.8.0), or a subgroup visible to parent-group members. Instance
  `is_admin` is **not** consulted (the older note "an `is_admin` user
  sees every group on the instance in one sweep" was true before 3.8.0
  and is false now).
- 404 → no group with that id.
- 403 → the group exists but is not visible — **or the key is
  rejected**, in which case every id answers 403 (authentication runs
  before the group lookup). A single probe cannot tell the two apart;
  a zero-group scan therefore consults the cached key-health verdict
  and throws on `rejected`.

**CAVEAT — poll-less groups are invisible to the probe.** The group
object reaches the response only as a side-load of the polls that
reference it (`PollSerializer has_one :topic` → `TopicSerializer has_one
:group, root: :groups`). With zero kept polls there is nothing to
side-load, the `groups` array is absent, and the probe records a miss
even though the caller can read the group. (The earlier belief that
polls "ALWAYS embeds the queried group's metadata" relied on
poll-created events, which no longer exist as such.) A missing group is
therefore not proof of invisibility; the tool says so in `scanned.note`.

`b2/polls` side-loads a subgroup's **parent** under a separate
`parent_groups` root (`GroupSerializer has_one :parent, root:
:parent_groups`), **not** in `groups`, and that side-load carries no
visibility check on the parent — so the probe ignores it, and a parent
group is discovered only when its own id is probed (and it has polls).
Results are deduped by id defensively. Schema-capped at 500 ids per invocation; the
default 1..200 scan costs 50–200 outbound calls in 2–5 seconds — against
Loomio's Rack::Attack budget of 900 per 5 minutes per client IP.

## Things we don't know yet

- Whether the flat / form-encoded write bodies still behave as
  described on a live Loomio ≥ 3.8 (source says yes; 0.0.12 verifies).
- Whether the CanCan `authorize!` message casing is exactly
  `Not authorized to <action> <Model>.` on every path — the connector
  matches `/^not authorized to /i`, case-insensitively, for that reason.
- Whether any instance enables Rack::Attack's `Retry-After` header; the
  connector includes it when present and says so when not.
