# HOWTO

Recipes for common tasks. Assumes the connector is wired into your MCP
host (Claude Desktop, Claude Code, etc.).

## Read a discussion

> What does discussion `abcDEF12` say?

The model calls `get_discussion({id_or_key: "abcDEF12"})` and summarises.

## What groups can the connector see?

> What Loomio groups do you have access to?

The model calls `list_groups({})`. Default scan probes ids 1..200,
costing ~50–200 outbound calls in 2–5 seconds. Don't wire this into
every chat turn — once per session is usually enough. Use the
`start_id` / `end_id` knobs to cover wider id ranges in chunks
(max 500 ids per call).

Two caveats until the native listing lands in 0.0.12: a group with
**no polls** is not discovered (the probe reads groups off `b2/polls`),
so a missing group is not proof the connector cannot see it; and an
empty result comes with `scanned.note` explaining what it can mean —
unless the connector's key-health probe says the API key is rejected,
in which case the tool throws rather than report "no groups".

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

Note: on Loomio ≤ 3.0.x polls could not be created via the API in
groups configured `public_discussions_only` (NOTES-ON-LOOMIO-API.md →
"Gotcha 3"). Loomio ≥ 3.1.0 derives the poll's privacy from the group,
so this should now work everywhere; it will be re-verified live in
0.0.12.

## Audit memberships

> List the current members of the group.

`list_memberships({group_id: 17})` returns the roster — user ids, names,
usernames, roles (`admin` / `delegate`, `title`) and join state — for any
group the connector's user is a member of. Email addresses appear only
when that user is an **admin (coordinator)** of the group (or invited the
member). If the result is an empty list with a `scope.note`, the
connector's user is not a member of that group: Loomio answers an empty
list, not 403, in that case. A real group always has at least its
creator, so never read an empty roster as "the group has no members".

## Analyse a member's activity

> How active has user 4242 been in groups 17 and 18 this year?

`get_user_activity({user_id: 4242, group_ids: [17, 18], since: "2026-01-01"})`
aggregates the user's events across every discussion in those groups.
**Known limitation:** Loomio ≥ 3.4.0 removed the `v1/events` endpoint
this reads, so against a current Loomio the call fails with a clear
error on the first discussion probed — it never returns zero counts as
if the person had been inactive. Report that as "not available on this
Loomio version", not as "no activity". The port to Loomio's thread-items
endpoint is planned for 0.0.12. The same applies to `list_events`.

## The connector says "Loomio returned 403"

Read the whole message — the connector classifies Loomio's 403 bodies:

- `"You are not authorized to access this page."` with **UNAUTHENTICATED**
  — the API key is dead, almost always **rotated** (Loomio regenerates it
  when the user's password changes). The message says where the current
  key is (`/profile/api_access`). On a single `list_*` call it can
  instead mean the target group is not visible to the connector's user.
- `"Not authorized to <action> <Model>."` — the key is fine; the
  connector's user lacks permission for that record.
- `"User is not an admin"` — `manage_memberships` needs the coordinator
  role on that group.
- "answered by a CDN/WAF in front of Loomio" — not a Loomio error at
  all; the request was blocked before Loomio saw it.

On the HTTP deployment, `GET /health` gives the operator the same
verdict without a tool call (see DEPLOY.md).

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
