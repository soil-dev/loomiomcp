# Changelog

## 0.1.0 — unreleased

Initial scaffolding. Targets Loomio's b2 API (the canonical surface;
see DESIGN.md / NOTES-ON-LOOMIO-API.md for why b1 was abandoned).

Tools:

- Read (registered always): `get_discussion`, `list_discussions`,
  `get_poll`, `list_polls`, `list_memberships`.
- Write (skipped when `LOOMIO_MCP_READONLY=1`): `create_discussion`,
  `create_poll`, `manage_memberships`, `create_comment`.
- Admin (opt-in via `LOOMIO_B3_API_KEY`, also skipped in readonly):
  `deactivate_user`, `reactivate_user`. These use a separate
  server-instance secret on the b3 namespace.

Transports: stdio (local) + HTTP/OAuth (Cloud Run).

Body shape: all writes send flat top-level fields. Wrapping under
`{discussion: …}` / `{poll: …}` / `{comment: …}` causes Loomio's
Snorlax base controller to strip the wrapper and re-wrap empty params,
silently producing empty records. The flat shape matches Loomio's own
`/help/api2` documentation.
