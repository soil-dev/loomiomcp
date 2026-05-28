# Changelog

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
  adding a tool. Cross-repo links bridge soil-dev/loomiomcp ↔
  openssl/infra ↔ openssl/images.
- `encodePathSegment` rejects `""` / `"."` / `".."` defence-in-depth
  before URL-encoding.
- `list_groups` schema caps per-call probe span at 500 ids and
  rejects inverted ranges.
- `LoomioAuthError` now carries the HTTP status code; non-403
  auth failures propagate as errors instead of silently returning
  empty results.

## 0.0.1 — 2026-05-27

First tagged release. The connector has been live-tested against a
self-hosted Loomio 3.0.24 instance (openssl-communities.org) and the
production Cloud Run deployment is serving real traffic. Expect rough
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
