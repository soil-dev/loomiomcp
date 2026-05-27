# Design

Short notes on the load-bearing choices.

## Surface area

All non-admin tools target the **b2** API (`/api/b2/...`), with auth
via `?api_key=…`. This is the namespace where Loomio's controllers
actually live in the open-source repo — `grep "Api::B1" loomio/` is
empty, and the public b1 docs at `/help/api` are stale (e.g. they
omit `group_id` on `POST /memberships`, which b2 controllers require).
The canonical b2 docs are at https://www.loomio.com/help/api2.

The **b3** namespace (`POST /b3/users/deactivate`,
`POST /b3/users/reactivate`) uses a separate auth secret — `?b3_api_key=`
validated against `ENV['B3_API_KEY']` on the Loomio server, >16 chars.
This is a server-instance admin secret, not a per-user key. Tools are
registered only when `LOOMIO_B3_API_KEY` is set (and skipped in
readonly mode).

The internal `v1` API (~37 controllers — groups, stances/votes,
events, reactions, search, …) is out of scope for this connector.
That isn't an oversight; v1 is fundamentally hostile to programmatic
third-party access on the loomio.com SaaS:

- **Auth wall.** Both session creation (`POST /api/v1/sessions`) and
  the magic-link flow (`POST /api/v1/login_tokens`) require a
  Cloudflare Turnstile token in the request. Turnstile tokens are
  obtained from a browser challenge — they can't be generated
  server-side. So there is no headless login path against the SaaS.
- **CSRF on writes.** v1 controllers inherit `ProtectedFromForgery`
  (b1/b2 explicitly skip it). Even with a hand-pasted session cookie,
  POST/PATCH/DELETE need a CSRF token scraped from a prior GET.
- **Cookie lifecycle.** Devise sessions expire (Loomio's config:
  ~2 weeks). A connector that needs the user to re-paste cookies on
  a fortnightly cadence is a poor experience.

A self-hosted Loomio with `TURNSTILE_SECRET_KEY` unset removes the
auth wall, so v1 could be wrapped there — but that's a niche enough
deployment that it's left as a future opt-in (e.g. behind a
`LOOMIO_SESSION_COOKIE` env var) rather than part of the default tool
catalog.

## Flat bodies (no resource-name wrapping)

The b2 base controller's `permitted_params` strips the incoming
`:discussion` / `:poll` keys from the params *before* re-wrapping
under the resource name. So a body like `{discussion: {title, …}}`
gets the wrapper stripped, leaving empty params, which then get
re-wrapped to `{discussion: {}}` — producing an empty record with
zero validation errors. Silent data loss.

Always send flat top-level fields. For the comments endpoint, which
strips `:discussion_id` (not `:comment`), we put `discussion_id` in
the URL query and the body fields flat. The membership controller
reads params directly, so flat works there too. See
NOTES-ON-LOOMIO-API.md for line-by-line justification.

## API-key injection

Both Loomio public APIs (b2 and b3) take their auth secret as a query
parameter — `?api_key=…` for b2, `?b3_api_key=…` for b3. The two
injection points are `buildUrl()` (b2) and `loomioPostB3()` (b3) in
`src/loomio/client.ts`. This means:

- Keys never leak into structured logs (paths are redacted via
  `src/log.ts`'s `redactPath`, which drops the query string).
- A base-URL override is validated to be `https://` (or `http://` on
  loopback) — sending the key to an arbitrary http host would put it
  in plaintext in any logging proxy on the path.

## Read-only mode

`LOOMIO_MCP_READONLY=1` does two things:

1. Skips registration of all write tools in `src/server.ts`
   (`create_*`, `manage_*`, `deactivate_user`, `reactivate_user`).
2. Causes `loomioPost` / `loomioPostB3` in `src/loomio/client.ts` to
   throw before issuing the HTTP request.

The first removes them from the catalog (the MCP client can't see
them); the second is the defence in depth.

## `manage_memberships` safety

`POST /b2/memberships` with `remove_absent: true` is irreversible. The
tool description, schema field description, and `destructiveHint: true`
annotation in `src/server/register-tool.ts` all flag it; the default of
`remove_absent: false` keeps the additive case ergonomic.
`deactivate_user` also carries the destructive hint. See SECURITY.md.

## What we deliberately don't have

- **No cache layer.** The capsulemcp sibling caches reference-data
  endpoints (`list_pipelines`, `list_boards`) because LLM chains
  re-query them. Loomio's surface has no equivalent — `list_memberships`
  IS the authoritative read for any membership write, so caching it
  would mask the very thing the caller is checking.
- **No async task store.** Loomio writes are single-request and fast;
  the sibling's task-polling surface adds complexity we don't need.
- **No batch fan-out helper.** A future `batch_manage_memberships`
  across groups would re-introduce this — at that point, the
  capsulemcp shape (concurrency-capped `Promise.allSettled` with
  per-item idempotency and a `batch.complete` event) is the
  reference. Until then, keeping the codebase smaller is the win.
