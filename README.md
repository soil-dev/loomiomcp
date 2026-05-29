# loomiomcp

Model Context Protocol server for [Loomio](https://www.loomio.com). Lets
Claude (Desktop, Code, or web Projects via Custom Connector) read and
write Loomio discussions, polls, comments, and group memberships — and
analyse member activity — in plain English. Targets Loomio's **b2** API
— the canonical surface documented at
[/help/api2](https://www.loomio.com/help/api2) and the namespace where
the controllers actually live in the open-source repo.

Tools (b2, per-user `?api_key=`):

- `get_discussion(id_or_key)` — fetch one discussion
- `list_discussions(group_id, status?, limit?, offset?)` — list a group's discussions
- `create_discussion(title, group_id, …)` — start a new one
- `get_poll(id_or_key)` — fetch one poll
- `list_polls(group_id, status?, limit?, offset?)` — list a group's polls
- `create_poll(title, poll_type, …)` — start a new poll
- `list_memberships(group_id, limit?, offset?)` — list a group's members with email
  addresses. Requires the connector's user to be a group **admin** (coordinator);
  Loomio only returns the member list to admins. On a 403 the connector probes to
  explain *why* — bot lacks the admin role vs. invalid key vs. not-a-member — and
  points at `get_user_activity` / `list_events` for names/ids (email stays admin-only).
- `list_groups({start_id?, end_id?, stop_after_consecutive_misses?})` — enumerate
  visible groups by probing `b2/polls` across an id range. Loomio has no
  api-key-authed list-groups endpoint; this is the workaround. Default scans
  are ~50–200 outbound calls; a single invocation is capped at 500 ids
- `list_events(discussion_id, limit?, offset?, kinds?)` — the event stream for one
  discussion (comments, reactions, stances, outcomes, …) with `actor_id`, `kind`,
  timestamps, and embedded `users` / `comments` / `polls`. With no `limit`/`offset`
  it paginates up to a bounded cap and reports `scope.complete`; with either
  pagination knob it returns that one page.
- `get_user_activity(user_id, group_ids, since?, until?)` — aggregate one user's
  participation across groups (counts by kind / group / month, first/last activity).
  The primary tool for any user-centric question; fans out server-side with a bounded
  budget and reports completeness via `scope.complete`. If both `since` and `until`
  are supplied, `until` must be later than `since`.
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

Set `LOOMIO_MCP_READONLY=1` to register only the 8 read tools
(`get_*` / `list_*` / `get_user_activity`). All write tools
(`create_*`, `manage_*`) are skipped at server-init time. This is the
mode the Cloud Run deployment runs in.

## Docs map

| File | When to read |
|---|---|
| [INSTALL.md](INSTALL.md) | "I want to use this locally with Claude Desktop / Code today" |
| [DEPLOY.md](DEPLOY.md) | "I want to run this as a remote HTTP/OAuth endpoint" |
| [HOWTO.md](HOWTO.md) | "I want example prompts and use cases" |
| [DESIGN.md](DESIGN.md) | "I want to understand the load-bearing choices" |
| [NOTES-ON-LOOMIO-API.md](NOTES-ON-LOOMIO-API.md) | "I'm hitting a weird Loomio behaviour, or want the line-by-line endpoint reference" |
| [SECURITY.md](SECURITY.md) | "I'm doing a security review or rotating secrets" |
| [OPTIMIZATIONS.md](OPTIMIZATIONS.md) | "I want observability / usage analytics queries" |
| [CONTRIBUTING.md](CONTRIBUTING.md) | "I want to add a tool or send a PR" |
| [CHANGELOG.md](CHANGELOG.md) | "What changed?" |

## License

Apache-2.0
