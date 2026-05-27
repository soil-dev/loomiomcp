# HOWTO

Recipes for common tasks. Assumes the connector is wired into your MCP
host (Claude Desktop, Claude Code, etc.).

## Read a discussion

> What does discussion `abcDEF12` say?

The model calls `get_discussion({id_or_key: "abcDEF12"})` and summarises.

## What groups can the bot see?

> What Loomio groups do you have access to?

The model calls `list_groups({})`. Default scan probes ids 1..200,
costing ~50–200 outbound calls in 2–5 seconds. Don't wire this into
every chat turn — once per session is usually enough. Use the
`start_id` / `end_id` knobs to cover wider id ranges in chunks
(max 500 ids per call).

## Browse polls in a group

> Show me poll `xyz12345`.

`get_poll({id_or_key: "xyz12345"})`.

> What's been polled in group 17? Include closed ones.

`list_polls({group_id: 17, status: "all"})`. Use `status: "closed"`
to see just historical poll outcomes, `status: "active"` (the
default) for live ones.

## Start a new discussion

> Open a discussion in group 17 titled "Q3 retro" with the body "what
> went well, what didn't, what's next".

The model calls `create_discussion({title: "Q3 retro", group_id: 17,
description: "what went well, …", description_format: "md"})`. The
connector auto-resolves the `private` field from the group's
`discussion_privacy_options` — see NOTES-ON-LOOMIO-API.md for the
rationale and override behaviour.

## Reply to an existing thread

> Add a comment to discussion 4242 saying "Looks good to me."

`create_comment({discussion_id: 4242, body: "Looks good to me."})`.
Optional `body_format` ('md' or 'html'); defaults to the group's
setting.

## Run a quick proposal

> Create a proposal in group 17: "Adopt the new release process?".

The model calls `create_poll({title: "Adopt the new release process?",
poll_type: "proposal", discussion_id: <id of an existing discussion>})`.
If you want a standalone poll, omit `discussion_id`.

Note: Loomio's b2 API currently has a bug where polls can't be
created in groups configured `public_discussions_only` (see
NOTES-ON-LOOMIO-API.md → "Gotcha 3"). Most groups allow private
polls; this just means you can't create polls in the most
public-facing ones via API.

## Audit memberships

> List the current members of the group.

`list_memberships({group_id: 17})` returns everyone visible to the API-key user.

## Add a new member

> Invite alice@example.com.

`manage_memberships({group_id: 17, emails: ["alice@example.com"]})`. Additive only —
nobody is removed.

## Reconcile to a roster (DANGEROUS)

> Set the group membership to exactly these 12 emails.

This requires `manage_memberships({group_id: 17, emails: [...], remove_absent: true})`.
Read `list_memberships({group_id: 17})` first and confirm the diff with a human. The
connector marks this tool with `destructiveHint: true` so clients can
prompt. See SECURITY.md.
