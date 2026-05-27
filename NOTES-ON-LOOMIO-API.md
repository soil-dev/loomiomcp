# Notes on the Loomio public APIs

Empirical / source-verified behaviour that informs the tool schemas.
Update as we learn more.

## Why b2 is the canonical surface (not b1)

Loomio has three public-ish `/api/...` namespaces. We target **b2**.

- **`b1`** — documented at https://www.loomio.com/help/api but
  **has no controllers in the open-source repo** (grep `Api::B1` →
  zero matches). Either dead routes, or Rails routing maps b1 →
  b2 controllers via a shim that isn't in the repo. Either way, the
  b1 docs are stale and incomplete (e.g. they show `POST /memberships`
  without the `group_id` parameter that b2 controllers require).
- **`b2`** — documented at https://www.loomio.com/help/api2.
  Controllers in `app/controllers/api/b2/` are the actual
  implementation. Same `?api_key=` auth as b1. **All non-admin tools
  in this connector hit `/b2/...`.**
- **`b3`** — different auth (`?b3_api_key=` validated against
  `ENV['B3_API_KEY']` on the Loomio server). Currently only
  `users#deactivate` / `users#reactivate`. Wrapped behind opt-in
  `LOOMIO_B3_API_KEY`.

The internal `v1` API (~37 controllers — groups, stances/votes, etc.)
uses Devise session cookies plus Cloudflare Turnstile on login. There
is no headless login path against loomio.com. Out of scope; see
DESIGN.md.

## Auth

API key passed as `?api_key=…`. NOT a Bearer header. Consequences:

- The key lands in any URL log unless we redact (we do — `src/log.ts`).
- Override base URLs are gated to https / loopback http in
  `src/loomio/client.ts`.

## Base URL

`https://www.loomio.com/api` — version (`b2` / `b3`) is part of each
path so a single client serves both namespaces.

## Endpoints wrapped

### b2 (per-user api_key)

| Method | Path | Tool |
|---|---|---|
| GET | `/b2/discussions/{id_or_key}` | `get_discussion` |
| GET | `/b2/discussions?group_id=…&status=…&limit=…&offset=…` | `list_discussions` |
| POST | `/b2/discussions` | `create_discussion` |
| GET | `/b2/polls/{id_or_key}` | `get_poll` |
| GET | `/b2/polls?group_id=…&status=…&limit=…&offset=…` | `list_polls` |
| POST | `/b2/polls` | `create_poll` |
| GET | `/b2/memberships?group_id=…&limit=…&offset=…` | `list_memberships` |
| POST | `/b2/memberships` | `manage_memberships` |
| POST | `/b2/comments?discussion_id=…` | `create_comment` |

### b3 (server-instance b3_api_key; opt-in via LOOMIO_B3_API_KEY)

| Method | Path | Tool |
|---|---|---|
| POST | `/b3/users/deactivate?id=…` | `deactivate_user` |
| POST | `/b3/users/reactivate?id=…` | `reactivate_user` |

## Request body shape: FLAT, no wrapping

**Important.** The b2 base controller's `permitted_params` strips the
incoming `:discussion` / `:poll` keys (and `:api_key`, `:format`) from
the params and *re-wraps* the remainder under the resource name. So:

- Sending `{discussion: {title, group_id}}` → server deletes
  `:discussion` → empty params → re-wraps to `{discussion: {}}` →
  empty record created. Silent failure.
- Sending `{title, group_id}` (flat) → server keeps the params →
  wraps to `{discussion: {title, group_id}}` server-side → correct.

**Always send flat top-level fields.** The comments controller has its
own permitted_params override that strips `:discussion_id` (not
`:comment`), so for comments we put `discussion_id` in the URL query
and send the rest flat in the body.

The `manage_memberships` controller reads params directly (no
permitted_params wrapping) — flat body is also correct there.

## Pagination

b2 list endpoints (`discussions`, `polls`, `memberships`) accept
`limit` (default 50) and `offset` (default 0). The base SnorlaxBase
class also accepts `per` as an alias for `limit` and `from` as an
alias for `offset`. We expose `limit` / `offset` only.

## Status filters

| Endpoint | Values |
|---|---|
| `list_discussions` | `open`, `closed`, `all`. Default `open`. |
| `list_polls` | `active`, `closed`, `all`. Default `active`. |

## Poll types

`proposal`, `poll`, `count`, `score`, `ranked_choice`, `meeting`,
`dot_vote`. `proposal` has built-in agree/disagree/abstain options;
every other type requires the caller to pass `options`.

## Membership management

`POST /b2/memberships`:

- Requires `group_id`. Caller must be a group admin (response
  includes member emails because of `default_scope`'s
  `include_email: true`).
- Always additive for emails in the input list.
- If `remove_absent: true`, every existing member whose email is NOT
  in the list is removed. Empty input → empty group. No server-side
  dry-run.
- Response: `{added_emails: [...], removed_emails: [...]}`.

## b3 admin (opt-in)

`?b3_api_key=…` validated server-side against `ENV['B3_API_KEY']`
(must be >16 chars). `deactivate` schedules `DeactivateUserWorker`
async; `reactivate` is synchronous via `UserService.reactivate`.
Both take `id` (Loomio user id) in the URL query.

## Error shapes observed

Loomio returns various shapes; `src/loomio/client.ts`'s
`parseErrorBody` handles:

- `{ "errors": { "field": ["message", ...] } }` — validation
- `{ "message": "..." }`
- `{ "error": "..." }`

## Verified live (2026-05-27 against a self-hosted Loomio 3.0.24)

| Tool | Status | Notes |
|---|---|---|
| `get_discussion` (id or key) | ✓ | |
| `list_discussions` | ✓ | |
| `get_poll` (id or key) | ✓ | |
| `list_polls` | ✓ | |
| `list_memberships` | ✓ | |
| `create_discussion` | ✓ | Connector auto-resolves `private` from group's `discussion_privacy_options` (see below) |
| `create_comment` | ✓ | Connector uses form-encoded body (see below) |
| `manage_memberships` | ✓ | Additive path verified; `remove_absent: true` not exercised |
| `create_poll` | ✗ | Upstream Loomio bug, see below |

## Gotcha 1: discussion privacy is group-policy-dependent — the connector auto-resolves

Every Loomio group has `discussion_privacy_options ∈ {public_only,
private_only, public_or_private}`. The Topic validator (in
`app/models/topic.rb`) rejects any mismatch:

- `public_only` group + `private: true` → 422 "must be public"
- `private_only` group + `private: false` → 422 "must be private"
- `public_or_private` allows either

Topic's column defaults to `private: true` in `db/schema.rb`, so an
omitted `private` field fails on every public-only group. The b2 docs
at `/help/api2` don't mention any of this.

`create_discussion` in this connector auto-resolves when `private` is
omitted: it fetches `GET /api/v1/groups/{group_id}?api_key=…`, reads
`discussion_privacy_options`, and picks the value Loomio's web UI
would (the `Group#discussion_private_default` method — `false` only
for `public_only`, `true` otherwise). On 403 (the group is hidden
from us), we default to `true` — Loomio's GroupPrivacy validator
forces every hidden group to `private_only`, so that's the only
valid choice anyway.

Callers can override by passing `private` explicitly. Doing so skips
the resolver fetch.

## Gotcha 2: `create_comment` requires form-encoded body

Rails' `wrap_parameters format: [:json]` is on globally, and
`action_on_unpermitted_parameters = :raise` in Loomio's
`config/application.rb`. The b2 base controller's `permitted_params`
override strips `:discussion` / `:poll` / `:discussion_id` /
`:api_key` / `:format` before re-wrapping under the resource name,
but does NOT strip the auto-wrapped `:comment` key when posting to
`/b2/comments`. Result: a JSON body `{body, body_format}` becomes
`{comment: {comment: {…}, body, body_format}}`, the inner `:comment`
isn't in `comment_attributes`, strict mode raises
`UnpermittedParameters` → HTTP 400 `{"error":400}`.

Form-encoded bodies are not affected by `wrap_parameters` (which
only applies to JSON), so the connector posts to `/b2/comments`
with `Content-Type: application/x-www-form-urlencoded`. The
`PostOptions.encoding: "form"` flag in `src/loomio/client.ts` exists
for this. All other writes still use JSON.

## Gotcha 3: `create_poll` is broken upstream on most groups

`PermittedParams#poll_attributes` does not include `:private`, but
`PollService.build` does `topic_params = params.extract!(*DiscussionService::TOPIC_ATTRS)`
where `TOPIC_ATTRS` includes `:private`. The result: by the time
`PollService.build` extracts topic_params, `:private` has been
filtered away by `permit`, so the new Topic always carries
`private: true` (the DB default). Any group with
`public_discussions_only?` then 422s the create — and because
`Poll#errors` is empty (the errors are on the cascaded `Topic`), the
response body is the unhelpful `{"errors":{}}`.

Workaround: none from the client. The b2 serializer doesn't expose
`topic_id` either, so a poll can't be attached to a pre-validated
topic.

Reported as a Loomio bug TODO. Until fixed, `create_poll` will fail
422 on most groups configured `public_discussions_only`. The tool
is kept registered (and the schema is correct per /help/api2) so it
starts working as soon as upstream is patched.

## Things we don't know yet

- Rate-limit headers (Loomio's docs don't specify; we don't currently
  retry on 429).
- Whether `list_discussions`'s default status changed between b1 docs
  ("kept") and b2 docs ("open"). The controller's `accessible_records`
  switch shows `open` → `is_unlocked`, `closed` → `is_locked`, default
  → `kept`. So defaults differ subtly; we always pass `status` when
  the caller supplies it and omit otherwise.
