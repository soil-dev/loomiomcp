# HOWTO

Recipes for common tasks. Assumes the connector is wired into your MCP
host (Claude Desktop, Claude Code, etc.).

## Read a discussion

> What does discussion `abcDEF12` say?

The model calls `get_discussion({id_or_key: "abcDEF12"})` and summarises.

## Start a new discussion

> Open a discussion in group 17 titled "Q3 retro" with the body "what
> went well, what didn't, what's next".

The model calls `create_discussion({title: "Q3 retro", group_id: 17,
description: "what went well, …", description_format: "md"})`.

## Run a quick proposal

> Create a proposal in group 17: "Adopt the new release process?".

The model calls `create_poll({title: "Adopt the new release process?",
poll_type: "proposal", discussion_id: <id of an existing discussion>})`.
If you want a standalone poll, omit `discussion_id`.

## Audit memberships

> List the current members of the group.

`list_memberships()` returns everyone visible to the API-key user.

## Add a new member

> Invite alice@example.com.

`manage_memberships({emails: ["alice@example.com"]})`. Additive only —
nobody is removed.

## Reconcile to a roster (DANGEROUS)

> Set the group membership to exactly these 12 emails.

This requires `manage_memberships({emails: [...], remove_absent: true})`.
Read `list_memberships()` first and confirm the diff with a human. The
connector marks this tool with `destructiveHint: true` so clients can
prompt. See SECURITY.md.
