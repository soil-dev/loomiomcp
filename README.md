# loomiomcp

Model Context Protocol server for [Loomio](https://www.loomio.com). Lets
Claude (Desktop, Code, or web Projects via Custom Connector) read and
write Loomio discussions, polls, comments, and group memberships in
plain English. Targets Loomio's **b2** API — the canonical surface
documented at [/help/api2](https://www.loomio.com/help/api2) and the
namespace where the controllers actually live in the open-source repo.

Tools (b2, per-user `?api_key=`):

- `get_discussion(id_or_key)` — fetch one discussion
- `list_discussions(group_id, status?, limit?, offset?)` — list a group's discussions
- `create_discussion(title, group_id, …)` — start a new one
- `get_poll(id_or_key)` — fetch one poll
- `list_polls(group_id, status?, limit?, offset?)` — list a group's polls
- `create_poll(title, poll_type, …)` — start a new poll
- `list_memberships(group_id, limit?, offset?)` — list a group's members with email
  addresses (caller must be a group admin)
- `list_groups({start_id?, end_id?, stop_after_consecutive_misses?})` — enumerate
  visible groups by probing `b2/memberships` across an id range. Loomio has no
  api-key-authed list-groups endpoint; this is the workaround. ~50–200 outbound
  calls per invocation
- `manage_memberships({group_id, emails, remove_absent})` — add and (with
  `remove_absent: true`) **remove** members. See SECURITY.md before using
  `remove_absent`.
- `create_comment(discussion_id, body, body_format?)` — reply on a discussion

Opt-in admin tools (b3, server-instance secret `?b3_api_key=`):

Set `LOOMIO_B3_API_KEY` to enable. Only useful for Loomio instance operators.

- `deactivate_user(id)` — disable a user account instance-wide
- `reactivate_user(id)` — re-enable a previously deactivated user

## Quick start (stdio, local)

```
LOOMIO_API_KEY=… npx loomiomcp
```

Add it to your Claude Desktop / Claude Code config the same way you would
any stdio MCP server.

## Remote (HTTP)

See DEPLOY.md for Cloud Run.

## Auth

Loomio's b2 API authenticates by API key passed as a `?api_key=…` query
parameter. The connector injects it server-side; it never reaches the
MCP client. Generate one in Loomio under your profile → API keys.

The optional b3 admin namespace uses a different secret (`?b3_api_key=…`,
validated against `ENV['B3_API_KEY']` on the Loomio server, >16 chars).
Only relevant if you operate a Loomio instance.

## Read-only mode

Set `LOOMIO_MCP_READONLY=1` to register only the read tools
(`get_*` / `list_*`). All write tools (`create_*`, `manage_*`) are
skipped at server-init time. This is the mode the Cloud Run deployment
runs in.

## License

Apache-2.0
