# Changelog

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
