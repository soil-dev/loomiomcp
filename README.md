# loomiomcp

[![npm](https://img.shields.io/npm/v/loomiomcp)](https://www.npmjs.com/package/loomiomcp)
[![CI](https://github.com/soil-dev/loomiomcp/actions/workflows/ci.yml/badge.svg)](https://github.com/soil-dev/loomiomcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Glama](https://glama.ai/mcp/servers/soil-dev/loomiomcp/badge)](https://glama.ai/mcp/servers/soil-dev/loomiomcp)

Model Context Protocol server for [Loomio](https://www.loomio.com). Lets
Claude (Desktop, Code, or web Projects via Custom Connector) read and
write Loomio discussions, polls, comments, and group memberships — and
analyse member activity — in plain English. Targets Loomio's **b2** API
— the canonical surface documented at
[/help/api2](https://www.loomio.com/help/api2) and the namespace where
the controllers actually live in the open-source repo.

Tools (b2, per-user API key):

- `get_discussion(id_or_key)` — fetch one discussion
- `list_discussions(group_id, status?, limit?, offset?)` — list a group's discussions
- `create_discussion(title, group_id, …)` — start a new one
- `get_poll(id_or_key)` — fetch one poll
- `list_polls(group_id, status?, limit?, offset?)` — list a group's polls
- `create_poll(title, poll_type, …)` — start a new poll
- `list_memberships(group_id, limit?, offset?)` — list a group's members: user ids,
  names, usernames, roles (`admin` / `delegate` flags, `title`) and join state.
  **Any member** of the group can read the roster (Loomio ≥ 3.8). Email addresses
  (`user_email`) are included only for groups where the connector's user is an admin
  (coordinator), or for members it invited. A **non-member gets an empty list, not a
  403** — the connector adds `scope.note` so an empty roster is never mistaken for
  an empty group.
- `list_groups({start_id?, end_id?, stop_after_consecutive_misses?})` — enumerate
  visible groups by probing `b2/polls` across an id range (one outbound call per id;
  default scans are ~50–200 calls, a single invocation is capped at 500 ids).
  Caveats: a group with **no polls** is not discovered (the group object only arrives
  side-loaded with the polls that reference it), and instance `is_admin` does not
  widen the scope (Loomio ≥ 3.8 ignores it for the User API). If the scan finds
  nothing and the key-health probe reports the API key **rejected**, the tool throws
  instead of returning `[]`. Loomio 3.8 has a native `GET /api/b2/groups`; the
  connector adopts it in 0.0.12.
- `list_events(discussion_id, limit?, offset?, kinds?)` — the event stream for one
  discussion (comments, reactions, stances, outcomes, …) with `actor_id`, `kind`,
  timestamps, and embedded `users` / `comments` / `polls`. With no `limit`/`offset`
  it paginates up to a bounded cap and reports `scope.complete`; with either
  pagination knob it returns that one page. **Known limitation:** Loomio ≥ 3.4.0
  removed the `v1/events` endpoint this tool reads; against such an instance it
  fails with a clear error (never an empty stream). Port to
  `GET /api/b2/threads/{topic_id}/items` planned for 0.0.12.
- `get_user_activity(user_id, group_ids, since?, until?)` — aggregate one user's
  participation across groups (counts by kind / group / month, first/last activity).
  The primary tool for any user-centric question; fans out server-side with a bounded
  budget and reports completeness via `scope.complete`. If both `since` and `until`
  are supplied, `until` must be later than `since`. **Same limitation as
  `list_events`:** on Loomio ≥ 3.4.0 it throws on the first discussion probed and
  never returns zero counts as if the user had been inactive.
- `manage_memberships({group_id, emails, remove_absent})` — add and (with
  `remove_absent: true`) **remove** members. See SECURITY.md before using
  `remove_absent`.
- `create_comment(discussion_id, body, body_format?)` — reply on a discussion

Opt-in admin tools (b3, server-instance secret):

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

See DEPLOY.md for Cloud Run. The HTTP server also exposes an
unauthenticated **`GET /health`** that reports whether Loomio still
accepts the connector's API key — `200 {"status":"ok","key_status":"valid",…}`
or `503` with `key_status` `rejected` / `unreachable`. Point an uptime
check at it with content match `"key_status":"valid"` (DEPLOY.md has the
recommended setup); a rotated key is otherwise invisible until someone
notices every call failing.

## Auth

Loomio authenticates by API key sent in an HTTP bearer header:

```text
Authorization: Bearer <API_KEY>
```

The connector injects it server-side; it never reaches the MCP client.
Copy the key from the user's **API access** page in Loomio
(`/profile/api_access`).

**The key is not permanent.** Loomio regenerates a user's API key
whenever that user's password changes (and Loomio 3.3.1, August 2026,
rotated every user's key once). When that happens every call answers
`403 {"error":"You are not authorized to access this page."}`; the
connector recognises that body, says "key rejected — probably rotated"
with the remediation, and (HTTP) turns `/health` red. Fetch the current
key from the API access page and update `LOOMIO_API_KEY`. No API can
read another user's key.

Keys passed in the query string (`?api_key=…`) are **rejected** — Loomio
removed that scheme in July 2026 because URLs are retained in browser
history, proxy logs, and monitoring systems. A request carrying its key
that way is treated as unauthenticated and 403s.

The optional b3 admin namespace uses the same bearer header with a
different secret (validated against `ENV['B3_API_KEY']` on the Loomio
server, >16 chars). Only relevant if you operate a Loomio instance.

## Loomio compatibility

Tested against **Loomio 3.8.1** (`TESTED_LOOMIO_VERSION` in
`src/version.ts`). Loomio publishes no API compatibility or deprecation
policy and ships tags often, so the connector reads the instance's
version from the public `GET /api/v1/boot/version` at startup and logs a
one-time `loomio.version_drift` warning when the `major.minor` differs.
Every outbound request carries `User-Agent: loomiomcp/<version>` — if
your Loomio sits behind a CDN/WAF, allow that user-agent (the connector
recognises a WAF 403 and says so instead of blaming the key).

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
