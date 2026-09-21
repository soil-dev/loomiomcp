# loomiomcp

[![npm](https://img.shields.io/npm/v/loomiomcp)](https://www.npmjs.com/package/loomiomcp)
[![CI](https://github.com/soil-dev/loomiomcp/actions/workflows/ci.yml/badge.svg)](https://github.com/soil-dev/loomiomcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Glama](https://glama.ai/mcp/servers/soil-dev/loomiomcp/badge)](https://glama.ai/mcp/servers/soil-dev/loomiomcp)

Model Context Protocol server for [Loomio](https://www.loomio.com). Lets
Claude (Desktop, Code, or web Projects via Custom Connector) read and
write Loomio discussions, polls, comments and group memberships — and
analyse member participation — in plain English. Targets Loomio's **b2**
API — the canonical surface documented at
[/help/api2](https://www.loomio.com/help/api2) and the namespace where
the controllers live in the open-source repo — as shipped in Loomio 3.8.

## Tool catalog

Every read is one upstream call unless the table says otherwise. Every
collection returns Loomio's exact `total` and a `scope` note naming
what was filtered, capped or not visible. The server also ships a
ten-line routing guide as MCP `instructions`, so a client knows which
tool answers which kind of question before it reads a single
description. The whole catalogue a client downloads at session start
(`instructions` + `tools/list` for the 24 full-mode tools) is about
36 KB, roughly 9 000 tokens (`node scripts/catalog-size.mjs` after
`npm run build`); the long-form guidance per tool — inputs, outputs,
cost, caveats, exact error texts — is in [HOWTO.md](HOWTO.md#tool-reference).

### Reads (always registered)

| Tool | Purpose | Upstream calls |
|---|---|---|
| `check_connection()` | Key status, the account the key belongs to, its groups (`member` / `pending` / `parent`), readonly and b3 flags, fixed-wording notes. Call first when unsure what the connector can see. | the health probe (1 authenticated + 1 public GET); its groups body is reused |
| `list_groups()` | The connector user's member groups (pending invitations included) with the user's own `membership` {accepted, admin, delegate, title}, plus each subgroup's parent flagged `member: false`. Sorted by `full_name`. | 1 (`GET /b2/groups`) |
| `get_group(id_or_key_or_handle)` | One group's full record — privacy, `members_can_*` permission flags, counters — with `member`, `membership`, `parent`, `url`. Works for publicly visible groups the user has not joined. | 1 |
| `list_discussions(group_id, status?, limit?, offset?, description_max_chars?, strip_html?)` | A group's discussions, newest activity first, each joined with its thread counters (`items_count`, `replies_count`, `last_activity_at`, `locked_at`, `pinned_at`, `tags`, …) and `url`. `status` defaults to `open` and is always sent. Bodies come as plain text (`strip_html`, default true; `description_format: "text"`) capped at 1500 chars (`description_truncated: true` marks a cut). | 1 |
| `get_discussion(id_or_key, strip_html?, include_items?, items_limit?, items_body_max_chars?)` | One discussion with the full body (as stored; `strip_html: true` for plain text), thread counters, group and users. `include_items: true` embeds `list_thread_items` for the thread (same reply budget; `thread_items.next_offset` says where to page on). | 1 (2 with `include_items`) |
| `list_polls(group_id, status?, limit?, offset?, description_max_chars?, strip_html?)` | A group's polls, newest first, as SLIM rows: identity, schedule, `hide_results`, participation counts, `stance_counts` + `total_score` when visible (aligned with `poll_options[]`), `current_outcome`, `my_stance`, `url`. The per-voter `results[]` breakdown and the type knobs Loomio left null are `get_poll`'s. `status` defaults to `active`. | 1 |
| `get_poll(id_or_key, strip_html?)` | One poll with `poll_options`, `current_outcome`, the user's own `my_stance`, thread counters and `url`. `results_visible` / `results_hidden_reason` apply Loomio's own visibility rule; hidden stance counts are stripped, never zeroed. | 1 |
| `list_threads(limit?, offset?, group_id?, type?, since?)` | Every thread the user can see across all groups, newest activity first — the cheapest "what is new" call. `group_id` / `type` / `since` filter client-side within the page (Loomio's route has no date filter); with `since`, page until `scope.exhausted`. | 1 (`GET /b2/threads`) |
| `list_thread_items(topic_id \| discussion_id \| poll_id, kinds?, limit?, offset?, include_reactions?, body_max_chars?, strip_html?, max_total_chars?)` | One thread's structured items (comments, polls, votes, outcomes, edits) with slimmed side-loads; comment bodies, vote reasons and outcome statements come as plain text by default (`strip_html`). Loomio's route is unpaginated: the thread is fetched once and sliced here, under a reply budget (`max_total_chars`, default 120000; `truncated_by_budget` + `next_offset`). Replaces `list_events`. | 1 with `topic_id`, 2 otherwise |
| `get_thread_markdown(topic_id \| discussion_id \| poll_id, max_chars?)` | The whole thread rendered to Markdown by Loomio — front matter, body, comments, polls with results tables (Loomio applies vote visibility itself), outcomes. Best single call for a summary. | 1 with `topic_id`, 2 otherwise |
| `search_content(query \| author_id, group_id?, types?, tag?, order?)` | Full-text search across everything visible; `author_id` alone lists a user's 20 newest items. Snippets carry `**match**` emphasis; every hit has a deep-link `url` and `group` {id, full_name, handle} (Loomio's "Parent - Subgroup" name). A vote-reason hit on a poll whose results are hidden from the user is dropped from a `query` search (its existence would confirm the term; `scope.hidden_stance_hits_dropped`) and kept with `snippet: null` + `snippet_hidden_reason` in author mode. Loomio caps results at 20 (`capped: true`), no paging. | 1 |
| `get_participation_report(group_ids \| group_scope, start_month?, end_month?, delegates_only?, limit?, include_inactive?)` | Loomio's participation report for a group set: each user's threads, comments, polls, votes cast vs issued vs missed, outcomes, reactions, `total`, sorted by `total`; the top `limit` rows (default 50, max 500), users with no counted activity dropped unless `include_inactive: true` (`total_users` counts all ranked). THE tool for "who is most engaged". | 1 for the whole group set |
| `get_user_activity(user_id, group_ids, since?, until?)` | One user's counts across groups (month-grained window) with `by_group`, plus `sample_events` from one author search. | N + 1 for N groups (4 in flight) |
| `list_memberships(group_id, limit?, offset?)` | A group's roster: ids, names, usernames, `admin` / `delegate`, `title`, `accepted_at`. Member emails only as `user_email` on a row, and only where the connector's user is a group admin; `users[]` never carry emails (the connector account's own, which Loomio adds, is removed). A non-member gets an empty list, not a 403 — the connector annotates it. | 1 (`compact=1`) |

### Writes (registered unless `LOOMIO_MCP_READONLY=1`)

| Tool | Purpose | Upstream calls |
|---|---|---|
| `create_discussion(title, group_id, …)` | Start a thread. Nested `{discussion: {…}}` body (a flat body silently loses `group_id` and `private`). Throws if Loomio's echo lands in another group. | 1 |
| `update_discussion(id_or_key, …)` | Edit title, body (replaced), privacy, comment / reaction / concurrent-poll settings, or add recipients. | 1 |
| `delete_discussion(id_or_key)` | Soft-discard: Loomio blanks the thread and keeps the records; an admin can restore. | 1 |
| `create_poll(title, poll_type, options, closing_at, group_id \| discussion_id \| topic_id, …)` | Any Loomio 3.8 poll type — `proposal`, `poll`, `count`, `check`, `question`, `score`, `ranked_choice`, `stv`, `meeting`, `dot_vote` — standalone or inside a discussion. Without `closing_at` Loomio saves an unopened draft (`opened: false` + `warning`); an opening poll is announced to every eligible voter unless `notify_on_open: false`. A `group_id` given with a thread reference is cross-checked before anything is written. | 1 (2 with `discussion_id`, or with `topic_id` + `group_id`) |
| `update_poll(id_or_key, …)` | Edit an open poll: title, details, closing time (the next full hour ends voting within the hour), options to ADD (Loomio's PATCH replaces the set and deletes unlisted options with their votes, so the connector reads the current names first and sends the union), `hide_results` (tighten only), voters. | 1 (2 with `options`) |
| `delete_poll(id_or_key)` | Soft-discard a poll. | 1 |
| `create_comment(discussion_id \| parent_id + parent_type, body, body_format?)` | Comment on a thread (`discussion_id` as numeric id or short key), or reply to a comment, poll, stance or outcome. Send `body_format: "html"` for HTML bodies (Loomio stores an omitted format as Markdown). | 1 (2 with a short key) |
| `update_comment(id, body, body_format?)` | Replace a comment's body. | 1 |
| `delete_comment(id)` | Soft-discard a comment. | 1 |
| `manage_memberships(group_id, emails, remove_absent?)` | Invite by email; with `remove_absent: true` **remove** everyone not listed. Group admin only. Read SECURITY.md first. | 1 |

### Instance-operator tools (b3; registered when `LOOMIO_B3_API_KEY` is set and not read-only)

| Tool | Purpose | Upstream calls |
|---|---|---|
| `deactivate_user(id)` | Deactivate an account instance-wide (Loomio runs it asynchronously). | 1 |
| `reactivate_user(id)` | Reactivate an account and restore the memberships the deactivation revoked. | 1 |
| `get_user(id \| identity_type + uid)` | One account by id or linked external identity — **email included**. | 1 |
| `list_users(is_admin?)` | Every account on the instance — **emails included**, unpaginated. | 1 |

The b3 secret authenticates the *server*, not a user: it is validated
against `ENV['B3_API_KEY']` on the Loomio instance and sees every
account. `get_user` and `list_users` are therefore for **single-tenant
deployments only** (one organisation per Loomio instance); on a shared
instance leave `LOOMIO_B3_API_KEY` unset.

### Deliberately not exposed

- **b3 update / destroy / redact users.** Irreversible (destroy and
  redact delete or scrub personal data for good) and Loomio records no
  actor identity for b3 calls, so nobody could later tell which agent
  session did it. Deactivate / reactivate cover the operational need
  and are reversible.
- **b3 chatbots / webhooks.** Group-admin configuration whose serializer
  returns the webhook URL and secret; nothing an AI caller needs, and a
  leak surface if it were readable.
- **The participation report's `base` and `countries` sections.**
  Instance-wide totals and per-country breakdowns; not answerable per
  group the way the `users` section is, and not what members see.

## Efficiency

Loomio 3.8 exposes aggregates its earlier releases lacked; this
connector uses them so every read costs as few upstream calls and bytes
as the API allows.

| Question | Before (0.0.11) | Now (0.0.12) |
|---|---|---|
| "Which groups can you see?" | `list_groups` probed `GET /b2/polls?group_id=N` per id: **50–500 calls**, blind to groups without polls | **1 call** on the native `GET /b2/groups`; parents included; no blind spots |
| "How active was user X?" | `get_user_activity` walked every discussion's event stream: **~200 calls**, and 0 on Loomio ≥ 3.4 (endpoint removed) | **N + 1 calls** for N groups on Loomio's participation report + one author search |
| "Who is most engaged in these groups?" | Not answerable without reconstructing from polls × memberships | `get_participation_report`: **1 call** for the whole group set |
| "Read / summarise this thread" | `list_events` per discussion, paginated, bodies in full | `get_thread_markdown` (1 call, Loomio renders) or `get_discussion` with `include_items` (2 calls) |
| "What is new anywhere?" | `list_discussions` per group | `list_threads`: **1 call** across every visible group |
| "Find the thread about …" | Not available | `search_content`: **1 call**, 20 hits with deep links |

Payload size is handled the same way:

- **Side-load profiles.** Lists send `exclude_types=group parent membership reaction translation`
  (the `topics` root — where the thread counters live — is kept and
  joined client-side); shows keep the group for its name and privacy;
  `list_threads` sends compact minus `tag`; rosters, search and thread
  items by bare `topic_id` use `compact=1`, while thread items for a
  thread whose record is already in hand also exclude `discussion` (no
  second copy of the opening post). `tag` is never excluded where topic
  rows are read: Loomio gates the rows' `tags` FIELD on it, not just the
  side-loaded root. Writes never carry these parameters.
- **Slimming.** Users become `{id, name, username}` (+ `email` only on
  the b3 tools); groups keep identity, privacy and counters; reactions,
  attachment and link-preview metadata are dropped unless asked for;
  `list_polls` rows leave the per-voter `results[]` to `get_poll`.
- **Body caps with explicit flags.** `description_max_chars` (lists,
  default 1500) and `body_max_chars` (thread items, default 4000) cap a
  record's text and mark it `*_truncated: true` with the original
  `*_chars`; `0` omits the field (`*_omitted: true`), `-1` returns
  everything. An HTML body longer than its cap is first stripped of tag
  attributes (Loomio stores `target` / `rel` on every link and an `id`
  on every heading — 17 % of a capped plain body, over half of a
  link-dense one; `href` and `alt` stay) so the capped characters carry
  content. `max_total_chars` (thread items, default 120000) budgets the
  whole reply and hands back `next_offset`. `max_chars` on
  `get_thread_markdown` (default 60000) caps the whole document from the
  END with top-level `truncated` and `chars`; `-1` returns it whole and
  `0` is refused. `get_*` return full text.
- **Compact JSON to the model.** Tool results are serialised without
  indentation (measured 10–37 % smaller than pretty-printed over the
  3.8.1 fixtures); `LOOMIO_MCP_PRETTY_JSON=1` restores indentation for
  a human reading a stdio session.
- **Exact totals.** Every collection surfaces Loomio's `meta.total` as
  `total`, so "how many" never needs a second page.

## Example questions

- "Check the Loomio connection and tell me which groups you can see." → `check_connection`
- "What is new in Loomio since yesterday?" → `list_threads`
- "Summarise the discussion about the budget." → `search_content`, then `get_thread_markdown`
- "Who are the coordinators of the Finance group?" → `list_groups`, `list_memberships`
- "Rank the members of these three groups by participation this year." → `get_participation_report`
- "How active has Ada Example been since March?" → `get_user_activity`
- "What was decided in the last five closed proposals?" → `list_polls` with `status: closed`
- "Post a status update in the release thread." → `create_comment` (writable mode)

HOWTO.md has longer walk-throughs.

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
notices every call failing. The `check_connection` tool reports the
same verdict to the AI caller.

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

## What the connector's user can see

Every read runs as the user whose API key is configured. Loomio ≥ 3.8
lets any authenticated user read **publicly visible** groups' public
threads, so `get_group`, `list_discussions`, `list_polls`,
`list_threads` and `search_content` reach beyond the user's member
groups — but `list_groups` (Loomio's `current_user.groups`) and the
participation report do not, and `list_memberships` answers a
non-member with an empty list. Instance `is_admin` widens nothing.
Poll results follow Loomio's own rule for that user: an open
`until_vote` poll the user has not voted in has its counts stripped
(`results_visible: false`, `results_hidden_reason: "until_vote"`), the
same rule hides vote reasons in `search_content` hits
(`snippet_hidden_reason`), and anonymous polls never reveal who voted
what.

## Loomio compatibility

Tested against **Loomio 3.8.1** (`TESTED_LOOMIO_VERSION` in
`src/version.ts`). Loomio publishes no API compatibility or deprecation
policy and ships tags often, so the connector reads the instance's
version from the public `GET /api/v1/boot/version` at startup and logs a
one-time `loomio.version_drift` warning when the `major.minor` differs;
`check_connection` repeats the warning in its `notes`. Every outbound
request carries `User-Agent: loomiomcp/<version>` — if your Loomio sits
behind a CDN/WAF, allow that user-agent (the connector recognises a WAF
403 and says so instead of blaming the key).

## Read-only mode

Set `LOOMIO_MCP_READONLY=1` to register only the 14 read tools. All
write tools (`create_*`, `update_*`, `delete_*`, `manage_*`) and the b3
tools are skipped at server-init time, and the client (`loomioPost` /
`loomioPatch` / `loomioDelete`) refuses a write before any request is
made even if one were reached. This is the mode the Cloud Run
deployment runs in.

## Docs map

| File | When to read |
|---|---|
| [INSTALL.md](INSTALL.md) | "I want to use this locally with Claude Desktop / Code today" |
| [DEPLOY.md](DEPLOY.md) | "I want to run this as a remote HTTP/OAuth endpoint" |
| [HOWTO.md](HOWTO.md) | "I want example prompts and use cases" |
| [DESIGN.md](DESIGN.md) | "I want to understand the load-bearing choices" |
| [NOTES-ON-LOOMIO-API.md](NOTES-ON-LOOMIO-API.md) | "I'm hitting a weird Loomio behaviour, or want the line-by-line endpoint reference" |
| [SECURITY.md](SECURITY.md) | "I'm doing a security review or rotating secrets" |
| [OPTIMIZATIONS.md](OPTIMIZATIONS.md) | "I want to know what each tool costs upstream, and the observability queries" |
| [CONTRIBUTING.md](CONTRIBUTING.md) | "I want to add a tool or send a PR" |
| [CHANGELOG.md](CHANGELOG.md) | "What changed?" |

## License

Apache-2.0
