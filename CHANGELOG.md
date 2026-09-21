# Changelog

## 0.0.12 — 2026-09-21

**Adopt Loomio 3.8's API; make it efficient.** Every capability Loomio
3.8.1's b2 User API (and, opt-in, its b3 Server API) offers is now a
tool with a description written for an AI caller; every read costs as
few upstream calls and bytes as the API allows; and nothing a tool
returns is wrong (a hidden poll result, a thread in the wrong group) or
bloated (a 50-row list with full HTML bodies and avatar metadata). The
0.0.11 hotfix made the connector's failures loud; this release makes
its answers right. Tool count 8 reads + 4 writes + 2 b3 → **14 reads +
10 writes + 4 b3** (28 with everything enabled; 14 in read-only mode).

Tested against Loomio 3.8.1: every request shape and response field
described below was checked against Loomio's controllers, serializers,
services, routes and controller tests at tag `v3.8.1`, and against
sanitised live captures of every read endpoint from a 3.8.1 instance.
The write path was exercised live on 2026-09-20 in a sandbox group of
that instance (see *Known limitations* for exactly what was and was not
run). `TESTED_LOOMIO_VERSION` stays `3.8.1`.

Added:

- **`check_connection`** — "does the connector work and what can it
  see", in one tool call and at most one request pair. Forces the
  key-health probe (`GET /b2/groups` + the public `GET /v1/boot/version`)
  and reuses the probe's own groups body, which the probe now keeps
  beside its verdict (`getCachedGroupsIndex` in
  `src/loomio/health-cache.ts` — stored *beside* `LoomioHealth`, never on
  it, so `/health` cannot grow a list of the user's groups). Returns
  `connector_version`, `tested_loomio_version`, `loomio_version`,
  `key_status`, `readonly`, `b3_enabled` (true iff the b3 tools are
  registered: the secret set AND not read-only — on a read-only
  deployment with the secret set it is false and a note says why,
  matching what `tools/list` advertises), the API key's `user` {id,
  name, username} (resolved from its own membership rows), `groups[]`
  with `member_state` `member` | `pending` | `parent` and `admin`,
  `groups_total`, and fixed-wording `notes[]` (rejected-key remediation,
  valid key but no groups, pending invitations, non-member parents,
  version drift, readonly / b3 flags). Never returns key material or
  upstream error text. Registered first, so it is the first tool a
  client reads.
- **`get_group`** — `GET /b2/groups/{id|key|handle}` (Loomio's
  ModelLocator tries the three in that order). Full record minus
  attachment / link-preview / cover metadata and minus the billing block
  GroupSerializer adds for any member (`subscription`: plan, state, seat
  caps, renewal / expiry dates — a serializer attribute no
  `exclude_types` profile can drop; `enabled` already says whether it is
  active) plus `new_host` / `discarded_by`, plus `member`,
  `membership` {accepted, admin, delegate, title}, `parent`,
  `subgroups_count`, `url`. Works for publicly visible groups the user
  has not joined (`can?(:show, group)`); a hidden group's
  `403 "Not authorized to show Group."` is classified as *hidden group*
  — the id is right, the remedy is membership — and 404 as *no such
  group*.
- **`list_threads`** — `GET /b2/threads?limit&offset` with
  `exclude_types=topic group parent membership reaction translation`
  (compact minus `tag`, because Loomio gates the rows' `tags` FIELD on
  `include_type?('tag')` — plain `compact=1` would strip it): every
  thread visible to the user across all groups (member groups plus
  public threads of public groups), newest activity first, with Loomio's
  exact `total`. Rows carry `topic_id`, `type`, the fronting record's
  `id` / `key` / `title` / `author_id`, `group_id`, the topic counters
  (`tags` included) and `url`. `group_id` / `type` filter
  **client-side** within the page (Loomio's route has no group filter)
  and `scope.note` says so. `since` (ISO-8601) is a client-side cutoff
  too — Loomio's route reads only `limit` / `offset` — applied to the
  newest-first rows: older rows are dropped, rows with no
  `last_activity_at` (Postgres sorts those FIRST) are dropped and
  counted in `scope.undated_dropped`, and `scope.exhausted` turns true
  when the page's last dated row already predates the cutoff (or the
  page was short), so "what's new this week" is a bounded loop instead
  of a guess; `total` stays the whole visible set.
- **`list_thread_items`** — the successor to `list_events`:
  `GET /b2/threads/{topic_id}/items`. Addressed by exactly one of
  `topic_id` (1 call), `discussion_id` or `poll_id` (2 calls: one
  `compact=1` GET to read the record's `topic_id`). Loomio's items route
  is **unpaginated**, so the whole thread is fetched once per call and
  `limit` (default 200, max 1000) / `offset` slice it here; `kinds[]`
  filters client-side with `other` as passthrough for unknown kinds;
  `total` / `matched` / `returned` say what was counted. Side-loads are
  narrowed to what the returned items reference and slimmed: comments
  (body capped by `body_max_chars`, default 4000), polls (identity,
  schedule, `hide_results`, participation counts, `poll_options[]` {id,
  name, priority} — the ids a stance's `option_scores` is keyed by, so
  a vote is readable without a `get_poll` — and `stance_counts` only
  when visible, aligned with those options), stances (`participant_id`
  null on anonymous polls), outcomes, users {id, name, username}.
  `max_total_chars` (default 120000, -1 = none) budgets the WHOLE reply
  in shaped characters: `limit` × `body_max_chars` bound each dimension
  but not their product (200 comments at 4000 chars ≈ 900 KB, fifteen
  times get_thread_markdown's document cap), so the slice stops before
  the item that would overrun the budget — never before the first —
  and returns `truncated_by_budget: true` plus `next_offset`
  (`next_offset` is also set when `limit` ended the slice; `scope.chars`
  says what the budget counted). Three side-load profiles: `compact=1` for a bare
  `topic_id` (the response must name the thread), compact plus
  `discussion` when the thread's record is already in hand — a
  `discussion_id` was just resolved, or `get_discussion` passed its
  record through — so the opening post is not serialised a second time,
  and, with `include_reactions`, the explicit list minus `reaction`
  (keeping `discussion`, whose serializer carries the opening post's
  reactions); `scope.profile` names the one used. A thread the user
  cannot see is **404**, never 403, and the error says so; a 404 while
  resolving a `discussion_id` / `poll_id` says "no such id or key"
  instead (those show routes answer 403 for an invisible record), so
  the two wordings never suggest a membership problem that is not one.
- **`get_thread_markdown`** — `GET /b2/threads/{topic_id}/markdown`:
  Loomio's own `ThreadMarkdownService` rendering (front matter, title,
  body, every comment / poll / vote / outcome in order; Loomio applies
  the poll vote-visibility rule itself here). `max_chars` (default
  60000, -1 = all) caps from the end with `truncated` and `chars`. The
  best single call for "summarise this thread".
- **`search_content`** — `GET /b2/search?compact=1`: full-text over
  discussions, comments, polls, stances and outcomes the user can see
  (member groups plus public groups' public threads). `query` (prefix
  matching, `!term` negation, trigram "did you mean" for short unquoted
  queries), `author_id` alone for a user's 20 newest visible items, or
  both; `group_id`, `types[]` (sent as Loomio's comma-separated
  `types=`), `tag`, `order` (`authored_at_desc` default,
  `authored_at_asc`, `relevance`). Each hit: `type`, `id` (the RECORD id,
  not the pg_search row id), `title`, `snippet` (Loomio's `<b>` highlight
  → `**match**`, HTML entities decoded, ≤ 400 chars), `group` {id,
  full_name, handle} (`full_name` because the controller emits Loomio's
  "Parent - Subgroup" `full_name`, not the short `name`), `author`,
  `authored_at`, `discussion_key` / `poll_key`, `sequence_id`, a
  deep-link `url`. Vote reasons follow the poll-visibility rule below:
  Loomio indexes the stances of open `until_vote` polls (its own web
  search shows a member those reasons), so a Stance hit whose poll hides
  results from the connector's user is gated from the response's own
  `polls` / `my_stance` roots (no extra call): in a `query` search the
  row is **dropped** and counted in `scope.hidden_stance_hits_dropped`
  — with a term to probe, the hit's mere existence would confirm the
  term occurs in the withheld reason, a word-by-word oracle over exactly
  what `list_thread_items` strips — while in author-only mode (nothing
  to probe) it stays with `snippet: null` + `snippet_hidden_reason`.
  Loomio's hard cap: **20 results, no paging, no total** — `capped:
  true` (computed over Loomio's rows, before the drop) says the match
  set is larger.
- **`get_participation_report`** — ONE `GET /b2/reports?section=users`
  for a whole group set (`group_ids` 1–50 as a comma-separated string,
  or `group_scope: 'my'`), `start_month` / `end_month` as `YYYY-MM`
  (default: the 12 months ending this month; validated client-side —
  Loomio answers 500 to anything else), `delegates_only`. Every user's
  `threads`, `comments`, `polls`, `votes` (= `votes_cast`),
  `votes_issued`, `votes_missed`, `all_votes_cast`, `outcomes`,
  `reactions` and `total` (threads+comments+polls+votes+outcomes),
  sorted by `total` desc; `country` dropped; `groups` echoes what Loomio
  counted and `groups_not_visible` names requested groups it dropped
  silently (the connector's user is not a member — Loomio's built-in
  fence). THE tool for "who is most engaged" / "rank the members".
- **`update_discussion` / `delete_discussion`**, **`update_poll` /
  `delete_poll`**, **`update_comment` / `delete_comment`** — the b2
  `update` and `destroy` actions Loomio 3.1.0 added. PATCH bodies are
  nested for discussions and polls and flat for comments (same rule as
  create, below); `update_*` refuse an empty change set at the schema.
  `update_poll`'s `options` ADDS names honestly: Loomio's `Poll#options=`
  (alias of `poll_option_names=`) treats the array as the COMPLETE set
  and marks every unlisted existing option for destruction — saved with
  `allow_destroy`, cascading to the votes cast on it (`PollOption
  has_many :stance_choices, dependent: :destroy`) — so the tool first
  GETs the poll's stored `poll_option_names` and PATCHes the union
  (existing names first, then the new ones; one extra call; the result
  echoes `options_sent`) — so it never sends a bare list Loomio would
  read as the complete set. Removal is not offered. The two calls are
  not atomic (see *Known limitations*). `notify_on_open` is exposed on
  both create and update. `delete_*` are Loomio's
  **soft discard** (`discarded_at` stamped, title / body nulled, records
  kept, restorable by an admin in Loomio's UI) and return
  `discarded: true` plus a note saying so. `delete_*` AND `update_*`
  carry `destructiveHint: true` (the MCP spec defines `false` as
  additive-only; an overwrite is not) and `idempotentHint: true`.
  Upstream tests
  cited in each module: "update happy case" / "destroy soft deletes
  discussion" (discussions), "update happy case" / "destroy soft deletes
  poll" (polls), "update accepts a bearer token with flat parameters" /
  "destroy soft deletes comment" (comments); the JSON shapes were also
  exercised live (200) on 2026-09-20.
- **`get_user` / `list_users`** (b3, opt-in) — `GET /b3/users/{id}`,
  `GET /b3/users/identity/{type}/{uid}` and `GET /b3/users[?is_admin=]`.
  Rows as Loomio renders them: id, name, username, **email**, is_admin,
  active, deactivated_at, identities[]. Registered only when
  `LOOMIO_B3_API_KEY` is set AND the server is not read-only — the same
  gate as the b3 writes, because every row carries an email — and
  documented as **single-tenant deployments only**. Loomio 3.8.1's
  identity route cannot resolve a `uid` containing a dot (Rails reads
  the suffix as a format); the description says to use the numeric id.
- **Server-level `instructions`** (`SERVER_INSTRUCTIONS` in
  `src/server.ts`, delivered in the MCP `initialize` result): a ten-line
  routing guide — check_connection first; list_threads for "what's new";
  get_thread_markdown for summaries; search_content for keywords;
  get_participation_report for rankings; get_user_activity per user;
  trust `results_visible`; never infer anonymous voters; writes replace,
  deletes are soft; relay `total` and `scope`.
- **Response shaping layer** — `src/loomio/types.ts` (the wire shapes of
  3.8.1's serializers, everything optional because Loomio hides fields
  conditionally), `src/loomio/shape.ts` (`joinTopics`, `slimUser` /
  `slimGroup`, `truncateText` / `truncateField`, `highlightToMarkdown`,
  the canonical-URL builders) and `src/loomio/visibility.ts` (poll
  result gating). All pure and unit-tested.
- **Topic join.** Since Loomio 3.1 a thread's `items_count`,
  `replies_count`, `last_activity_at`, `locked_at`, `pinned_at`, `tags`,
  `members_count`, `seen_by_count`, `active_polls_count` and
  `closed_polls_count` live on the side-loaded `topics[]` row; every
  discussion and poll read keeps that root and folds those fields onto
  the record (`reader_*` state, `ranges` and the like are dropped). A
  record whose topic Loomio withheld comes back without the fields, not
  with zeros. `tag` is never in a topic-reading profile: Loomio gates the
  rows' `tags` FIELD on `include_type?('tag')`, so excluding the type
  removes the field, not only the side-loaded root.
- **Poll result gating.** `PollSerializer` emits `results`,
  `stance_counts`, `total_score` and `stv_results` whenever
  `results_available?` — i.e. for every open `until_vote` poll too,
  leaving the "vote first" rule to the browser client, which an API user
  that never votes would bypass. The connector applies Loomio's full
  `results_visible?(voted:)` predicate with "voted" = the API user's own
  stance is cast, strips those fields (and other voters' `option_scores`
  / `reason` on stances) when it says no, and always emits
  `results_visible` + `results_hidden_reason` (`until_closed` |
  `until_vote`) so absent counts read as *hidden*, never as zero. In a
  thread the user's own stance is recognised via the id the health probe
  learned (`cachedOwnUserId`); with no cached identity it assumes "not
  voted", which hides more, never less (`scope.own_user_known`).
- **Canonical URLs** on every record, from Loomio's own route formats:
  `/d/{key}[/{slug}]`, `/p/{key}[/{slug}]`, `?comment_id=` /
  `?sequence_id=` deep links, `/{handle}` or `/g/{key}` for groups. The
  site base is `LOOMIO_API_BASE_URL` with its trailing `/api` removed.
- **Payload controls.** `description_max_chars` on `list_discussions`
  and `list_polls` (default 1500) and `body_max_chars` on
  `list_thread_items` (default 4000): `0` omits the field
  (`<field>_omitted: true`), `-1` returns it whole, `N` keeps the first
  N characters and marks the record `<field>_truncated: true` with
  `<field>_chars` (no ellipsis is appended — in a Markdown body it would
  be indistinguishable from content; cuts never split a surrogate pair).
  `max_chars` on `get_thread_markdown` (default 60000) caps the whole
  document from the END with top-level `truncated` and `chars`; `-1`
  returns it whole and `0` is refused. `get_*` return full text. Tool
  results are serialised as COMPACT JSON (10–37 % fewer bytes than the
  indented form over the 3.8.1 fixtures); `LOOMIO_MCP_PRETTY_JSON=1`
  restores indentation for humans reading a stdio session.
  `get_discussion` gains `include_items` (embeds the `list_thread_items`
  result; one extra call) so "read this whole thread" is one tool call,
  with `items_limit` / `items_body_max_chars` forwarded to it (the reply
  budget applies there too, and `thread_items.truncated_by_budget` /
  `next_offset` say when to page on with `list_thread_items`).
  **HTML compaction under a cap** (`compactHtml` / `truncateBody` in
  `src/loomio/shape.ts`): Loomio stores rich text with the attributes
  its editor and `HasRichText` add on save — `target="_blank"
  rel="nofollow ugc noreferrer noopener"` on every link, an `id` on every
  heading, `class` / `data-mention-id` on mentions — which were measured
  at 17 % of a capped plain body and over half of a link-dense one. When
  a list row's HTML body (`description_format` / `details_format` /
  `body_format` = `html`) is LONGER than its cap, every tag attribute
  except `<a href>` and `<img alt>` and the whitespace between tags are
  stripped before the cap is applied, so the 1500 characters carry
  words; `<field>_chars` stays the stored length. Bodies that fit,
  Markdown bodies and every `get_*` are returned byte-for-byte.
- **Client** (`src/loomio/client.ts`): `loomioPatch` / `loomioDelete`
  (both refuse before any request under `LOOMIO_MCP_READONLY`, like
  `loomioPost`), `loomioGetB3`, `nestedBody` / `flatBody`, `csvParam`,
  and the read profiles `EXCLUDE_TYPES` / `readParams` — lists send
  `exclude_types=group parent membership reaction translation`
  (keeping `topics`), shows `exclude_types=parent membership reaction
  translation` (keeping the group), the groups index and show
  `exclude_types=tag translation`, `list_threads` compact minus `tag`,
  rosters / search / thread items by bare `topic_id` `compact=1`,
  thread items for a known thread compact plus `discussion`,
  items-with-reactions `compact` minus `reaction`. Writes never carry
  these parameters (Loomio's `:raise` mode would 400).
  `classifyForbidden` knows the new paths: on `/b2/threads…`,
  `/b2/search`, `/b2/reports` and the `/b2/groups` index Loomio applies
  visibility as a filter and never as a 403, so the generic body there
  means the key and nothing else; `GET /b2/groups/:id`'s
  `"Not authorized to show Group."` is explained as a hidden group.
- **`redactPath`** covers `/b2/threads/:id(/items|/markdown)`,
  `/b2/search`, `/b2/reports`, `/b2/groups/:key`, `/b2/groups/:handle`
  and `/b3/users/identity/:type/:uid` (the provider uid is frequently an
  email address); query strings — search text, group id lists — never
  reach a log line.
- **`strip_html`** on every read that carries rich text: `list_discussions`,
  `list_polls` and `list_thread_items` default to `true`, `get_discussion`
  and `get_poll` to `false`. When on and the stored format is `html`,
  the body (`description`, `details`, comment `body`, stance `reason`,
  outcome `statement`) is converted to plain text BEFORE the `*_max_chars`
  cap — block boundaries become newlines, list items `- `, links keep
  their text and lose the href, entities are decoded — and the record's
  `*_format` becomes `"text"`; Markdown, discarded and format-less
  bodies are untouched, write echoes return HTML as stored. With it on,
  `*_chars` counts the text the caller received; off, the stored length
  (the HTML-compaction path is unchanged). `scope.strip_html` echoes the
  flag. Implementation: `htmlToText` / `stripBodyHtml` in
  `src/loomio/shape.ts`.
- **`get_participation_report` `limit` / `include_inactive`**: rows are
  sorted by `total` desc and cut to `limit` (1–500, default 50), and
  users with `total` 0 in the period are dropped before ranking unless
  `include_inactive: true`. The result gains `total_users` (ranked rows
  before the cut), `scope.limit`, `scope.include_inactive`,
  `scope.inactive_dropped`, and the note states the call's own numbers
  ("showing the top N of M ranked users", "K user(s) with no counted
  activity were dropped"). Neither knob reaches the wire. Motivation: a
  group set's report is a roster dump of everyone who EVER held a
  membership, most rows zero.
- **`scripts/catalog-size.mjs`**: spawns the built `dist/index.js` over
  stdio, runs `initialize` + `tools/list`, and prints the catalogue's
  bytes (total, descriptions, input schemas, instructions) with a
  per-tool breakdown (`--b3` for the 28-tool set, `--json`). The number
  `tests/server.test.ts` pins comes from the same wire format.
- **Tests**: 21 files, 571 tests (from 15 files). Fixtures
  (`tests/fixtures.ts`) follow the roots, field names, nesting and
  `meta.total` presence of the live 3.8.1 captures with every id, name,
  handle, title and body anonymised. Request-shape assertions on every
  tool (path, query including `exclude_types` / `compact` / `status`,
  method, body nesting) and response-shape assertions (topic join,
  slimming, truncation flags, results gating, url building, `total` /
  `scope`); `tests/server.test.ts` and `tests/readonly.test.ts` pin the
  advertised tool set per mode by name and by annotation, the
  instructions text, the discovery order, that no description carries an
  email address or an undocumented hostname, and — through a real
  in-memory MCP client — that every cross-field schema rule (exactly one
  thread reference, per-type option minimums, `query` XOR `author_id`,
  …) is enforced on `tools/call` before any upstream request.

Changed:

- **`list_groups` is one call** on the native `GET /b2/groups`
  (`current_user.groups`: every un-revoked membership, pending
  invitations included) instead of the 0.0.11 id probe (one
  `GET /b2/polls?group_id=N` per id, 50–500 calls, blind to poll-less
  groups, and — as the 3.8.1 review found — listing public groups the
  user had never joined). Rows are the slim group record plus `member`
  and the user's own `membership` {accepted, admin, delegate, title}; each
  subgroup's parent (Loomio side-loads it without a visibility check) is
  appended flagged `member: false`; deduped by id, sorted by `full_name`;
  `total` is Loomio's `meta.total`. `start_id` / `end_id` /
  `stop_after_consecutive_misses` are **gone from the schema** (an older
  caller that still sends them is not rejected: unknown keys are dropped
  and it gets the same one-call result). A 403 on this path can only be
  the key, so the tool throws the
  classified message instead of returning `[]`. The description says
  what "visible" means and that a publicly visible non-member group is
  readable by id with get_group / list_discussions / list_polls.
- **`get_user_activity` reads Loomio's participation report**
  (`GET /b2/reports?section=users&group_scope=custom&group_ids={id}`,
  one call per group, at most 4 in flight) plus ONE author-mode search
  for `sample_events` — **N + 1 calls for N groups** instead of the
  0.0.11 walk over every discussion's event stream (~200 calls, and
  impossible on Loomio ≥ 3.4). Same input contract (`user_id`,
  `group_ids` 1–50, `since`, `until`). The report is month-grained, so
  `since` / `until` are widened to whole calendar months and
  `scope.since_effective` / `until_effective` state exactly what was
  counted; there is **no per-month breakdown per user** (the service's
  `interval` shapes only the `base` section), so `by_month` is gone and
  the scope note says to call again with a narrower window. `counts`
  are the nine report counters plus `total`; `by_group` carries the
  group's name, the user's delegate flag and `listed: false` when Loomio
  has no row for the user there. `scope.groups_not_visible` names
  requested groups Loomio dropped (not a member), `groups_failed` the
  report calls that errored, `complete` is false when either is
  non-empty, and a call in which **every** report failed throws instead
  of returning zeros. A 403 aborts at once — on `/b2/reports` it can only
  be the key — and the abort is shared across the lanes: the requests
  already in flight are the last ones issued (a lane whose request
  resolves after the abort pulls no further group), which the tests pin
  with deferred responses, together with the cap itself. The scope
  notes and both report descriptions state Loomio's vote-month rule in
  full: a vote is counted in the month its counted stance ROW was
  created — when the ballot was issued (the poll opened, or the voter
  was added later) or, for a vote Loomio replaced on change
  (`StanceService.update` builds a new row and retires the old one when
  the position changes after a reply or after 15 minutes; `uncast`
  likewise), when it was changed — not necessarily the month it was
  first cast.
- **`list_discussions` / `get_discussion`** join the topic counters,
  drop attachment / link-preview / `mentioned_usernames` bloat (keeping
  `attachments_count`), cap the description on the list, slim `users`
  to {id, name, username} and the show's `group` to identity + privacy +
  counters, add `url`, and surface `total` + `scope`. `status` is still
  sent explicitly (default `open`).
- **`list_polls` / `get_poll`** join the topic counters, gate results
  (above), fold the poll's `poll_options[]` {id, name, priority,
  meaning, prompt}, `current_outcome` and the API user's own
  `my_stance` onto the record, drop the chart / result-presentation
  knobs Loomio's Vue client reads, cap `details` on the list, add `url`,
  `total` and `scope`. A `list_polls` ROW is slimmer than the show: it
  drops `results[]` / `stv_results` (per option: up to 50 `voter_ids`,
  a `voter_scores` map over every voter, colours, ranks, plus a
  synthetic "undecided" row naming the non-voters — 30–40 % of a
  visible poll's bytes and hundreds of KB of user ids over a 50-row
  page) while keeping `stance_counts` + `total_score`, which are the
  same per-option tallies aligned with `poll_options[]`; drops
  `poll_option_names` when `poll_options[]` names them; and drops the
  type-specific voting knobs Loomio left null. `get_poll` has the whole
  record. `status` (`active` default, `closed`, `all`) is
  sent explicitly and maps 1:1 onto how `PollsController#index` reads
  it.
- **`list_memberships`** sends `compact=1` (the roster needs no topics
  join and no group record; `users` still arrives) and reduces each row
  to id, user_id, group_id, admin, delegate, title, inviter_id,
  created_at, accepted_at and `user_email` where Loomio sent it; users
  are slimmed to id / name / username with NO email — the only
  `users[].email` this endpoint emits is the connector account's own
  (`AuthorSerializer#include_email?` for `current_user_id`), which is
  not roster data. `total`, `returned` and the 0.0.11 empty-roster
  `scope.note` (now mentioning the past-the-end case when `offset` was
  given) stay.
- **`create_discussion` sends a NESTED body** `{"discussion": {…}}` and
  no longer makes the `GET /v1/groups/{id}` privacy lookup: `private` is
  sent only when the caller sets it, and Loomio's own
  `TopicService.private_default` applies otherwise (one call instead of
  two, and no v1 request from a key-authenticated connector). After the
  create, if Loomio's echo places the thread in a different group than
  requested the tool **throws naming the created id** (misdirected-write
  guard) instead of reporting success. The result is shaped like
  `get_discussion` (record + counters + `url` + group + users).
- **`create_poll`** sends a NESTED `{"poll": {…}}` body with the
  `recipient_*` keys **both** nested and top-level (PollService.invite
  reads them from the raw params; `create_anonymous_poll_voters` from
  the resource hash). Attaching to a thread uses `topic_id` —
  `PermittedParams#poll_attributes` has no `discussion_id` (400) — so a
  `discussion_id` is resolved with one `compact=1` GET (`resolveThread`,
  shared with the thread tools) and a `group_id` given alongside
  `discussion_id` OR `topic_id` is cross-checked BEFORE anything is
  written (409 on a mismatch; with `topic_id` the check reads
  `GET /b2/threads/{topic_id}` — one extra call only when both are
  given, since Loomio derives the group from the thread and ignores a
  `group_id` in the body). Post-
  create guards throw naming the created id when the echo disagrees on
  the thread / group or shows no options although options were sent.
  `PollTypeEnum` gains `check`, `question` and `stv`; per-type rules from
  `config/poll_types.yml` (`POLL_TYPE_RULES`) refuse what Loomio's model
  does not validate: `options` are **required** for every type except
  `question` (Loomio has NO default options through the API — the 0.0.11
  description's "proposal has built-in agree / disagree / abstain" was
  wrong; those come from the web client's templates), `ranked_choice` /
  `stv` need ≥ 2, `count` / `question` / `meeting` cannot be anonymous,
  an anonymous poll needs `closing_at` (PollService.invite raises a bare
  `AccessDenied` for an anonymous poll that is not open, AFTER the poll
  was saved) and may not set `hide_results` other than `until_closed`.
  Every tuning knob Loomio permits is exposed (`hide_results`,
  `specified_voters_only`, `shuffle_options`, `notify_on_closing_soon`,
  `stance_reason_required`, `reason_prompt`, score / choice bounds,
  `stv_seats`, `meeting_duration`, `can_respond_maybe`, `tags`) — and
  `notify_on_open`, the Poll column (DB default TRUE) that makes Loomio
  announce a poll to every eligible voter the moment it opens
  (`PollService.create` → `announce_poll_opened`; on update,
  `open_poll_if_ready` when a `closing_at` first opens a draft):
  the common create_poll call (title + options + closing_at) notifies
  the whole group unless `notify_on_open: false` is sent, and the tool
  says so instead of "nobody is notified" (which was true only of the
  separate `recipient_*` / `notify_recipients` path). A poll created
  WITHOUT `closing_at` is saved by Loomio as a draft — `opened_at` null,
  nobody can vote, `Poll.active` (the list_polls default) omits it — with
  HTTP 200, so the result carries `opened` and, when false, a `warning`
  naming `update_poll` with a future `closing_at` as the way to open it;
  the description moves `closing_at` into the required clause. The
  field descriptions state Loomio's API-side defaults, which differ from
  its web form's: `notify_on_closing_soon` is 'nobody' (column default;
  the form pre-selects 'undecided_voters'), `meeting_duration` is unset
  (the form uses 60), `can_respond_maybe` is false (the form: true) —
  `config/poll_types.yml`'s `defaults:` reach only poll templates, while
  `min_score` / `max_score` / `dots_per_person` / `*_stance_choices` DO
  fall back to them through the model's readers and need no client
  default. A `group_id` given with `topic_id` is cross-checked BEFORE the
  POST (one `GET /b2/threads/{topic_id}`), like one given with
  `discussion_id`.
- **`create_comment` sends FLAT JSON** `{discussion_id, body,
  body_format}` — exactly what Loomio's own controller test posts —
  instead of the form-encoded body with `?discussion_id=` in the query
  (400 on 3.8.1). Replies via `parent_id` + `parent_type` (`Comment`,
  `Poll`, `Stance`, `Outcome`, or `Discussion`); `parent_type` is
  required with `parent_id` at the schema, because without it Loomio
  500s in the ability check. `discussion_id` takes the numeric id OR the
  short key a URL / search hit hands the caller: `comments.parent_id` is
  an integer column (a key on the wire would be cast to 0 — a thread-less
  comment), so a key is resolved with one `compact=1`
  `GET /b2/discussions/{key}` before the POST, as `create_poll` does; a
  numeric id costs nothing extra. The result carries the comment's
  `topic_id` so the thread tools can show it in context.
- **`*_format` on every create refuses HTML without its format.**
  `description_format` (discussions), `details_format` (polls) and
  `body_format` (comments) are all `default: "md"` columns in Loomio
  3.8.1 (db/schema.rb); no service on the b2 write path assigns them and
  there is no group-level format setting. An HTML body sent without its
  format is therefore stored as Markdown — the browser happens to render
  it, but every server-side rendering (notification emails, chatbot
  posts, exports: Redcarpet with `filter_html`) strips the tags. The
  three create schemas now refuse a body that starts with an HTML block
  tag unless the format is given (`refuseHtmlWithoutFormat`,
  `src/tools/_common.ts`), the field descriptions say the default is
  'md', and the update schemas say an omitted format keeps the stored
  one. (`update_poll`'s `details` gets the same guard.)
- **Every collection tool** returns Loomio's exact `meta.total` as
  `total`, `returned`, and a `scope` block (filters applied, caps, what
  was dropped / not visible / truncated, upstream calls made).
- **Tool catalogue trimmed from ~83 KB to 36 KB (≈ 9 000 tokens) per
  session; long-form guidance moved to HOWTO.md.** The first 0.0.12
  draft's `tools/list` for the 24 full-mode tools weighed 82 892 bytes
  (37 KB of descriptions, 41 KB of input schemas) plus 3.2 KB of
  instructions — about 20 700 tokens every session paid before its
  first question, more than most answers. Now 35 611 bytes (7.7 KB
  descriptions, 23.0 KB schemas — two thirds of that structural JSON the
  zod → JSON Schema conversion emits) and 1 747 chars of instructions;
  the 28-tool b3 set is 39.0 KB. Every description is at most 700 chars
  (350 for `delete_*` / `update_comment`) in a fixed shape — what it
  returns and costs, which sibling to prefer, the one caveat that
  changes behaviour — and every field `.describe()` at most 120 chars
  (self-naming fields such as `title` or `group_id` carry none). The
  cut text — field-by-field outputs, permission rules, exact 403 / 404
  texts, Loomio's counting rules, the 15 thread-item kinds, the per-type
  poll option keys — lives in HOWTO.md under "Tool reference", one
  subsection per tool. Shared poll fields are described per tool where
  the rule differs: `update_poll`'s `closing_at` reads "omitted =
  unchanged" (the create-side "effectively REQUIRED" had been copied
  onto it and made a rename invent a new deadline) and its
  `hide_results` states the one PATCH rule (`until_closed` cannot be
  left); `delete_poll` and the instructions send "close this poll" to
  `closing_at` = the next full hour, since no close route exists.
  `tests/server.test.ts` pins the ceilings
  (24 tools ≤ 36 000 bytes, 28 ≤ 40 000, instructions ≤ 1 800 chars,
  per-description caps); `scripts/catalog-size.mjs` measures them.
- **`get_participation_report` no longer returns zero-activity rows by
  default** (see *Added*: `limit` / `include_inactive`). A caller that
  relied on the all-zero rows to enumerate ever-members passes
  `include_inactive: true`.
- **Every tool description** rewritten for an AI caller: what it
  returns, when to use it against its siblings, cost in upstream calls,
  privacy notes, Loomio's limits, and the exact 403 / 404 it can hit.
  All four `ToolAnnotations` hints on every tool: reads `readOnlyHint` +
  `idempotentHint` (`check_` joins the read prefixes), `update_*`
  idempotent, `delete_*` destructive + idempotent, `manage_memberships`
  and `deactivate_user` destructive, `openWorldHint` everywhere.
  Registration order is discovery → reading → analysis → writes → admin.
- **429 message** names the remaining fan-out (`get_user_activity`'s
  one report per group) instead of the retired ones.
- **Health probe** sends the groups read profile
  (`exclude_types=tag translation`) so the once-a-minute probe does not
  haul tag and translation side-loads it never reads.
- **Docs** rewritten around the new surface: README (tool catalog with
  upstream calls, efficiency before / after, deliberately-not-exposed
  section, b3 section), NOTES-ON-LOOMIO-API (endpoint-by-endpoint notes
  for groups, threads, search, reports, the write bodies; old gotchas
  marked historical), DESIGN, HOWTO, SECURITY (search / report exposure,
  b3 reads), DEPLOY, INSTALL, OPTIMIZATIONS (upstream cost per tool),
  CONTRIBUTING, glama.json (28 tools, one line each).

Removed:

- **`list_events`** (`src/tools/events.ts`, `tests/events.test.ts`). It
  read `GET /api/v1/events`, which Loomio 3.4.0 removed; the
  `V1EventsRemovedError` and `MAX_SCAN_DISCUSSIONS` budget went with it.
  `list_thread_items` is the replacement — and, because the b2 items
  route runs as the key's user, it also sees the private threads the
  user belongs to, which the anonymous v1 read never did.
- **`create_discussion`'s `GET /v1/groups/{id}` privacy resolver**
  (`resolveDiscussionPrivate`). The connector now makes exactly one v1
  request, the public `GET /v1/boot/version` in the health probe.
- **Form-encoded write bodies** (`PostOptions.encoding: "form"`). Every
  b2 write is JSON; the 3.1.2-era double-wrapping bug the form path
  worked around is gone and the form path itself 400s on 3.8.1.
- **The `list_groups` id probe** and its per-call 500-id cap.

Fixed:

- **`create_discussion` and `create_poll` no longer misdirect.** The
  flat JSON bodies 0.0.11 sent reached Loomio 3.8.1 pre-wrapped by
  Rails' `wrap_parameters` with only the model's COLUMN names, so
  `group_id`, `private`, `options` and `recipient_*` were silently
  dropped: a discussion landed as a group-less private thread and a poll
  as a group-less poll with no options — both with HTTP 200 (confirmed
  live on 2026-09-20). Nested bodies fix it; the post-create guards make
  any recurrence loud.
- **`create_comment` no longer 400s** on Loomio ≥ 3.1.3 (form encoding
  with `?discussion_id=`).
- **`list_groups`** no longer misses poll-less groups, no longer lists
  public groups the user is not in, and no longer costs one request per
  candidate id.
- **`list_discussions` / `get_discussion`** carry `items_count`,
  `last_activity_at`, `locked_at`, `pinned_at`, `tags` and the other
  counters again (they moved to `topics[]` in Loomio 3.1).
- **Open `until_vote` polls no longer leak their tallies** to a caller
  whose user has not voted.
- **`get_user_activity` works again** against Loomio ≥ 3.4 and never
  returns zeros for a scan that counted nothing.
- **`create_poll`'s description** no longer claims built-in options for
  proposals, and the write descriptions no longer claim a format default
  that does not exist: 0.0.11's `description_format` / `body_format`
  said "defaults to Loomio's group default" — Loomio has no such setting
  and stores an omitted format as `md` (see *Changed*).
- **`list_memberships` no longer discloses the connector account's own
  email address** (Loomio serialises it on the account's own `users[]`
  row for every member group).

Known limitations:

- **Write-path verification status.** Exercised live on a Loomio 3.8.1
  sandbox (2026-09-20, a private group, the connector's user a plain
  member): nested `POST /b2/discussions` and `POST /b2/polls`
  (standalone and via `topic_id` inside a discussion), flat
  `POST /b2/comments`, nested `PATCH` on discussions and polls, flat
  `PATCH` on comments, and `DELETE` on all three (soft discard); the
  flat-body misdirection and the 400s for form-encoded / nested comment
  bodies and for `discussion_id` on polls were reproduced. Verified
  against Loomio's controllers and their tests but **not** run live:
  the `recipient_*` / `notify_recipients` variants, `specified_voters_only`
  and anonymous polls, replies via `parent_id` + `parent_type` (ANY
  parent type — only a top-level comment via `discussion_id` was run
  live), `update_discussion`'s `private` change, `update_poll`'s option
  adding (the replacement semantics of Loomio's `options=` that make
  the connector read-then-merge come from `poll.rb` / `poll_option.rb`
  and Loomio's model tests, not from a live run), `notify_on_open`
  (its announce path comes from `poll_service.rb` and Loomio's
  `poll_service_test.rb`, not from a live run), the draft-poll `warning`
  path (the `opened_at: null` echo shape comes from a live capture of a
  poll created without `closing_at`, the warning itself was not exercised
  live), a comment via a short-key `discussion_id` (the resolver is the
  same GET the thread tools ran live; the POST after it was not), and
  creates in a `public_only` group (Gotcha 3 in NOTES-ON-LOOMIO-API.md
  is fixed upstream per source, unverified live).
- **`update_poll`'s `options` read-then-write is not atomic.** Loomio's
  `Poll#options=` replaces the whole option set and b2 has no
  add-option primitive and no version check (`versions_count` does not
  move on an option-only change), so the connector reads the stored
  names and PATCHes the union: it never removes an option it SAW, but an
  option another editor adds between that read and the write is absent
  from the union and Loomio destroys it — with any votes already cast
  on it — answering 200 with no signal, and the echo cannot reveal it
  (it reflects the post-destruction state). The window is one sequential
  round-trip; Loomio's own web client submits the complete set the same
  way over a minutes-long form. Avoid concurrent edits of one poll's
  options; the descriptions say so.
- **Search drops, rather than annotates, hidden vote reasons in `query`
  mode.** A caller looking for "the vote about X" will not see Stance
  hits whose poll hides results from the connector's user; `scope.
  hidden_stance_hits_dropped` counts them. Author-only mode still lists
  them (snippet withheld). This is stricter than Loomio's own search,
  which shows a member the full reason.
- **The tool catalogue is large.** `tools/list` for the full 28-tool set
  is ~89 KB (~46 KB in read-only mode) plus ~3 KB of server
  instructions, paid once per session before the first call — 2.6× the
  0.0.11 catalogue (14 tools, 31 KB, no instructions), half from
  doubling the tool count and half from richer schemas and the caveats
  this release's review added (announce-on-open, draft polls, the
  format default, the options window, `since`, the reply budget). The
  descriptions deliberately carry what the model must relay (DESIGN.md)
  and every `.describe()` states the value's Loomio-side semantics; the
  duplications that carried no information (the poll-type / option-key
  list stated three times, the kinds list twice, the `options`
  paragraph twice) were removed. `tests/server.test.ts` pins a 92 KB
  ceiling so further growth is a decision, not drift.
- **Search is capped at 20 results** by Loomio (`SearchQuery::RESULT_LIMIT`)
  with no paging and no total; `capped: true` is the only signal that
  more exist. Typo tolerance depends on the instance's `pg_search_words`
  vocabulary rebuild.
- **Thread items are unpaginated upstream**: every `list_thread_items`
  call (and `get_discussion` with `include_items`) fetches the whole
  thread once; a 3000-item thread costs the same request whether one or
  one thousand items are returned.
- **`get_user_activity` is month-grained** (whole calendar months, no
  per-user per-month series), counts a vote in the month its counted
  stance row was created (ballot issued at poll open or when the voter
  was added; a vote Loomio replaced on change counts in the month of the
  change), excludes anonymous polls from every vote column, and does
  not count content posted as a non-member guest — all properties of
  Loomio's report, stated in `scope.note`.
- **`get_participation_report` rows include everyone who ever held a
  membership** in the groups (revoked and deactivated accounts too);
  all-zero rows mean "no counted activity", not "inactive member".
- **`until_vote` gating is client-side** and depends on knowing the API
  user's own id (from the health probe's groups body); until the first
  successful probe the thread tools assume "not voted" and hide, and
  `scope.own_user_known` says which case applied.
- **`list_threads` filters `group_id` / `type` / `since` client-side**
  within the fetched page; `total` stays instance-wide, and `since`
  needs the caller to page until `scope.exhausted` (threads with no
  `last_activity_at` are dropped and counted, not dated).
- **b3 identity lookups** cannot resolve a `uid` containing a dot on
  Loomio 3.8.1 (Rails treats the suffix as a format); use the numeric
  id.
- **Deliberately not exposed**: b3 `update` / `destroy` / `redact` users
  (irreversible, and Loomio records no actor identity for b3 calls),
  `/b2/chatbots` (group-admin only; the serializer returns the webhook
  URL and credential to admins), the participation report's `base` and
  `countries` sections, and `GET /b2/threads/{topic_id}` as a tool of
  its own (its row is what `list_threads` returns, and the items /
  markdown tools fill the thread header from their own responses; the
  connector reads it only for `create_poll`'s `topic_id` + `group_id`
  cross-check).

## 0.0.11 — 2026-09-20

Hotfix: **detect, explain, stop lying.** Between Loomio 3.0.24 (the
release this connector was built against) and 3.8.1, Loomio changed
its API in ways that made the connector fail *quietly*: a rotated API
key turned every call into one generic 403, `get_user_activity`
reported zero activity for everyone once its upstream endpoint was
removed, and `list_groups` answered an empty list when the key was
dead. This release makes each of those failures loud and specific.
It adds no new Loomio endpoints — the ports to Loomio's newer b2
surface (native groups listing, thread items, topic side-load) are
0.0.12. Tool count unchanged (8 reads + 4 writes + 2 b3 admin).

Tested against Loomio 3.8.1: every behaviour described below was
checked against the controllers, serializers, routes and controller
tests at Loomio tag `v3.8.1`. `TESTED_LOOMIO_VERSION` in
`src/version.ts` records that, and the health probe warns once when
the instance's `major.minor` differs from it — Loomio publishes no API
compatibility policy, so a new minor is a prompt to re-verify.

Added:

- **Key-health probe** (`src/loomio/health.ts`). An authenticated
  `GET /b2/groups` (200 → `valid`; 403 with Loomio's unauthenticated
  body → `rejected`; anything else, including a CDN/WAF 403 that never
  reached Loomio → `unreachable` with a `detail`) plus the public
  `GET /v1/boot/version` for the instance's Loomio version. Cached 60 s
  with a shared in-flight promise, so a hammered `/health` costs Loomio
  one request pair per minute. Every `key_status` change (including the
  first result) emits a **forced** `loomio.auth` event that bypasses the
  `LOOMIO_MCP_LOG_VERBOSE` gate, carrying `key_status`, `loomio_version`
  and a closed-vocabulary `reason` (`unauthenticated_body`, `waf`,
  `unrecognised_403`, `http_<status>`, `timeout`, `network_error`,
  `config_error`) — never the free-text `detail`, which may quote an
  upstream body fragment or error message and is reserved for the
  startup stderr warning. A one-time forced `loomio.version_drift` fires
  on a `major.minor` mismatch. Never logs or returns the key.
- **`GET /health`** on the HTTP transport (`src/http/health.ts`).
  Unauthenticated, per-IP rate-limited (same config as `/mcp`, separate
  bucket), `Cache-Control: no-store`. Body:
  `{status, connector_version, key_status, loomio_version, checked_at}`
  — HTTP 200 iff `key_status === "valid"`, else 503. Exposes exactly
  those fields: no key material, no `detail`, no Loomio hostname. Point
  an uptime check at it with content match `"key_status":"valid"`
  (DEPLOY.md). `LOOMIO_MCP_HEALTH_PATH` moves the page (e.g. to
  `/-/health`) for hosting front-ends that reserve `/healthz` and answer
  it with their own 404 before the container is reached; verify with
  `curl` that the connector's JSON comes back before trusting an alert.
- **Startup key check.** The HTTP entry probes after `listen` and logs
  the verdict; the stdio entry probes once and, on `rejected`, writes a
  one-paragraph warning to stderr (key rotated? where the current one
  is). Neither exits — a transient error must not kill the server, and a
  live process with classified 403s is more diagnosable than a
  crash-loop.
- **`User-Agent: loomiomcp/<version>`** on every outbound request. A
  CDN/WAF in front of an instance (Cloudflare is common) blocks default
  library user-agents outright; an explicit UA also lets instance
  operators pick the connector out of Loomio's logs.
- **`src/version.ts`** — single source of truth for `VERSION` and
  `TESTED_LOOMIO_VERSION`. `McpServer`, the User-Agent and `/health`
  import it; `tests/version.test.ts` pins `package.json` to it (0.0.9
  shipped with the two out of step).

Changed:

- **403s are classified** (`classifyForbidden` in `src/loomio/client.ts`,
  pure and unit-tested). Loomio ≥ 3.1.1 answers 403 with a body that
  says *why*, and the connector now reads it: a CDN/WAF body (JSON
  problem `type` mentioning cloudflare, or non-JSON) → "blocked in front
  of Loomio, not a permissions error — check WAF rules / User-Agent";
  the generic `"You are not authorized to access this page."` →
  **unauthenticated** — most often a rotated key (Loomio regenerates a
  user's key when that user's password changes, and 3.3.1 rotated every
  key once) — with remediation (`/health`, `GET /api/b2/groups`, the
  user's API access page `/profile/api_access`). The classification is
  **path-aware**: only `GET /b2/discussions?group_id=` and
  `GET /b2/polls?group_id=` go through `records_visible_in_group`, so
  only there does the message add "or the group is not visible to the
  connector's user"; on `/b2/memberships` (a non-member gets `200 []`),
  on every `/…/:id` read (which answers `"Not authorized to …"`) and on
  writes the same body can only mean the key was rejected, and the
  message says so. Writes include `POST /b2/discussions` and
  `POST /b2/polls`, whose paths coincide with the two gated GET lists:
  the classifier is **method-aware**, so a rotated key on `create_*` is
  never hedged towards "group not visible" (the one bare refusal a
  valid key can hit on a write — `POST /b2/polls` for an anonymous poll
  with no future `closing_at`, raised after the poll was saved — is
  named in the message). On `/b3/` paths the generic body is about the
  **b3 server secret**: `LOOMIO_B3_API_KEY` must equal the Loomio
  server's `ENV['B3_API_KEY']` (itself longer than 16 characters), and
  the message says exactly that — never the per-user key, never
  `/profile/api_access` — and the health verdict, which probes the b2
  key only, does not colour it.
  The key-health verdict colours the message only when
  it is **fresh** (younger than the 60 s cache): a fresh `rejected` makes
  it definitive, a fresh `valid` on a gated list points at visibility
  first, and a stale verdict is ignored — so a startup `valid` from days
  ago can never make a post-rotation 403 read as "not a key problem".
  `"Not authorized to <action> <Model>."` → per-record permission,
  surfaced verbatim; `"User is not an admin"` → needs the group admin
  (coordinator) role on that group; a numeric body or
  `action: "upgrade"` → Loomio subscription/plan limit; anything else →
  the body text. The old "Loomio sends the same 403 whether the key is
  invalid or the user lacks the role" text is gone — it described
  Loomio ≤ 3.1.0. A **401** is explained per namespace: Loomio's b2/b3
  API answers its own authentication failures with 403, so a 401 on a
  b2/b3 path came from something in front of Loomio (proxy, CDN,
  basic-auth gate); on a v1 path Loomio itself can answer 401
  (`require_current_user`, "you gotta be signed in") because v1 is a
  session-cookie API and the connector's key is not a v1 credential.
- **Upstream text in error messages is clipped** to 200 characters
  (`clip` in `src/loomio/client.ts`) at every echo site: non-JSON error
  bodies (a CDN's multi-KB HTML 502 page), the uncatalogued-403 body,
  `"Not authorized to …"` remainders, plan-limit and Cloudflare titles,
  and Rack::Attack's 429 text. The suffix states the original length.
  These messages land in MCP tool results (agent context) and inside
  `get_user_activity`'s "Last error"; unbounded upstream text there is
  both noise and an injection surface.
- **429 handled.** Loomio's Rack::Attack throttle (per client IP, 900
  requests per 5 minutes by default, `text/plain`) becomes a clear
  `LoomioApiError` with the `Retry-After` header when present; the
  invitation-limit JSON 429 is surfaced with Loomio's own message.
- **`list_memberships`** passes Loomio's response through. When
  `memberships` is empty it adds `scope.note`: on Loomio ≥ 3.8 a
  non-member (or a hidden group) gets `200 []`, not 403, and a real
  group always has at least its creator — so an empty roster almost
  always means "the connector's user is not a member". Description
  rewritten: **any member** can list the roster (ids, names, usernames,
  roles, join state); `user_email` appears only for groups where the
  connector's user is an admin, or for members it invited. The "caller
  MUST be a group admin / 403" claims are removed.
- **`manage_memberships`** sends `remove_absent: 1` on the wire when the
  flag is true and **omits the key** otherwise. Loomio reads
  `params[:remove_absent].to_i == 1`; a JSON boolean has no `#to_i` in
  Ruby, so the previous body raised `NoMethodError` → HTTP 500 — *after*
  the invitations had been sent. The zod schema keeps the boolean.
  Description now states the role requirement (group admin/coordinator
  on that group; Loomio answers `403 "User is not an admin"`; parent-
  group admin and instance admin do not count) and the full blast radius
  of `remove_absent`: pending invitees are revoked too, the revocation
  cascades to subgroups, and the connector's own user is removed if its
  email is absent.
- **Membership 403 fence removed.** `src/loomio/access.ts`,
  `tests/access.test.ts` and `explainForbidden` are deleted. The fence
  existed because Loomio ≤ 3.1.0 returned a bare `{"error":403}` for
  every refusal; the classified bodies make it redundant, and its extra
  probe was one more way to spend Loomio's rate budget.
- **`list_discussions` always sends `status`** (default `open`).
  Loomio's own fall-through for a missing `status` is every kept thread
  *including locked ones*, so omitting it silently widened the list.
  The description states the default.
- **`deactivate_user` / `reactivate_user`** use the member routes
  `POST /b3/users/{id}/deactivate` and `…/{id}/reactivate`; the `?id=`
  collection routes are marked `deprecated: true` in Loomio's OpenAPI
  document. The response is typed as `{ success: true, user }` and
  returned. Descriptions: deactivation runs **asynchronously**
  server-side (the echoed user may still show `active: true`);
  reactivation is synchronous and **restores the memberships the
  deactivation revoked**.
- **`list_groups`** no longer claims that `is_admin` bypasses membership
  (Loomio ≥ 3.8 ignores it for the User API) and now states the probe's
  blind spot: a group with **no polls** is never discovered, because the
  group object only reaches the response as a side-load of the polls
  that reference it. Scope now includes publicly visible groups (Loomio
  ≥ 3.8 lets any authenticated user read them). The description no
  longer claims that `b2/polls` embeds a subgroup's parent in `groups`:
  Loomio side-loads it under a separate `parent_groups` root (with no
  visibility check on the parent), which the probe deliberately does
  not read, so a parent group is discovered only when its own id is
  probed. When the scan finds
  nothing it consults the health probe: `rejected` → throws the
  key-rejected error instead of returning `groups: []`; otherwise the
  result carries `scanned.note` saying what the emptiness does and does
  not prove. Each probe records *why* it missed (404 vs 403), and when
  any miss was a 403 the health probe is **forced** rather than served
  from its 60 s cache — with a valid key a non-existent id answers 404
  (`Group.find` runs after `authenticate_api_key!`), so an all-403 scan
  is exactly what a key rotated seconds after the last `valid` probe
  looks like. The `unreachable` note is fixed text; the probe's
  operator-facing `detail` stays out of tool results, as it stays out
  of `/health`.
- **`list_polls` description** no longer says "Caller must be a group
  member": polls and discussions share the `records_visible_in_group`
  gate, so a publicly visible group's public polls are readable by any
  authenticated user on Loomio ≥ 3.8 (same wording as
  `list_discussions`).
- **`create_poll` description** no longer presents the
  public-discussions-only 422 as a current limitation: Loomio ≥ 3.1.0
  derives the poll topic's privacy from the group
  (`TopicService.private_default`) when `private` is omitted, so the
  create should work in every group (not yet re-verified live; 0.0.12).
  HOWTO.md carried the same stale paragraph and is fixed alongside.
- **`LOOMIO_API_BASE_URL` validation** refuses a URL with userinfo
  (`user:password@host`) before undici can quote the whole URL —
  password included — back in an error message, and no validation
  message repeats the configured value verbatim any more (the scheme
  error names `protocol//host` only).
- **`redactPath`** also collapses `/users/<id>` (b3 member routes),
  `/groups/<id>` and `/threads/<id>` — the resources Loomio addresses by
  a string key in the path — so no id or handle reaches a log line.
- **Rate limiter** factored into `src/http/rate-limit.ts` so `/mcp` and
  `/health` share one config and one keying rule (source IP) with
  separate buckets. `resolveMcpRateLimitConfig` is re-exported from its
  old home.
- **Docs** brought in line with Loomio 3.8.1 throughout (README,
  INSTALL, DEPLOY, SECURITY, DESIGN, HOWTO, NOTES-ON-LOOMIO-API,
  OPTIMIZATIONS, CONTRIBUTING, glama.json). NOTES-ON-LOOMIO-API.md gains
  a dated "Loomio 3.1 → 3.8 changes that matter" section; obsolete
  gotchas are marked historical rather than deleted.

Fixed:

- **`get_user_activity` no longer reports zero activity when it counted
  nothing.** Loomio ≥ 3.4.0 removed `GET /api/v1/events`; the previous
  fan-out swallowed the resulting 404 on every discussion and returned
  `counts.total: 0` for every user with only `scope.complete: false` to
  hint otherwise. Now the FIRST discussion's stream is probed on its own
  — a 404 there throws `V1EventsRemovedError` at the cost of one request
  — and, as a backstop, a scan that ends with zero successful event
  fetches and at least one failure throws instead of returning counts,
  as does a scan where every group listing failed. Partial results are
  still returned with the existing `scope.*` completeness flags.
- **`list_events` on a 404** throws a clear error naming the removed
  endpoint and the planned port instead of returning an empty stream.
- **`manage_memberships` with `remove_absent: true` no longer 500s after
  inviting** (see Changed).
- **`list_groups` no longer returns an empty list for a rejected key**
  (see Changed).
- **Version skew** between `package.json` and the advertised MCP server
  version can no longer recur (see `src/version.ts`).

Known limitations:

- **`list_events` and `get_user_activity` do not work against Loomio
  ≥ 3.4.0** (August 2026), which removed the v1 `events` endpoint they
  read (the Event model became TopicItem). Both tools now fail with a
  clear error rather than lying; their descriptions say so. The port to
  `GET /api/b2/threads/{topic_id}/items` is planned for 0.0.12.
- **Write bodies pending verification.** Since Loomio 3.1.3 the b2
  `permitted_params` prefers a wrapped resource hash (`{discussion:
  {…}}`) when one is present and only falls back to the flat-body
  handling this connector was built on. The flat/form-encoded write
  behaviour is unchanged in this release and is re-verified against a
  live 3.8.x instance in 0.0.12.
- **`list_groups` is still probe-based** (misses poll-less groups; costs
  one request per id). Native `GET /api/b2/groups` arrives in 0.0.12.
- **Topic side-load not yet joined.** Since Loomio 3.1.0 a discussion's
  `items_count`, `last_activity_at` and similar counters live on the
  side-loaded `topics[]` record (and `compact=1` drops that record).
  `list_discussions` / `get_discussion` return Loomio's response as-is;
  the join is 0.0.12.

## 0.0.10 — 2026-07-25

Dependency security updates. No code, tool, or API changes.

Clears every high-severity advisory in the tree (9 vulnerabilities →
3; 5 high → 0):

- **`undici` 8.3.0 → 8.9.0** (runtime dependency — the HTTP client for
  every outbound Loomio call). Fixes HTTP response queue poisoning via
  keep-alive socket reuse, cross-user information disclosure via a
  shared-cache whitespace bypass, and a Set-Cookie SameSite downgrade.
  The first and third matter most here: this is a multi-user service
  that funnels all callers through one upstream identity over pooled
  keep-alive connections.
- Transitive bumps: `body-parser` 2.3.0, `fast-uri` 3.1.4,
  `postcss` 8.5.23, `hono` 4.12.32, `vite` 8.1.5 (supersedes the
  individual Dependabot PRs).

Three advisories are left unfixed **deliberately**, all unreachable
here:

- `@hono/node-server` path traversal in `serve-static` on **Windows**
  via encoded backslash. The connector never uses hono (it uses the
  express / stdio transports), never serves static files, and ships in
  a Linux container. npm's proposed fix is a **downgrade** of
  `@modelcontextprotocol/sdk` to 1.24.3 — breaking our core dependency
  to patch a bundled framework we don't invoke.
- `esbuild` dev-server file read on **Windows** — a devDependency
  (via tsup/vite), absent from the production image
  (`npm ci --omit=dev`), and we never run its dev server.

Verified against the live Loomio instance with the new undici: bearer
auth, paginated reads, probe-based `list_groups`, and
`get_user_activity` aggregation all return real data. (The unit suite
mocks `undici`, so a live check is what actually exercises the upgrade.)

## 0.0.9 — 2026-07-25

**Breaking upstream change — this release is required.** Loomio moved
API-key authentication to an HTTP bearer header and now rejects keys
passed in the query string. Every request from 0.0.8 and earlier fails
against an updated Loomio instance.

- **Bearer authentication.** b2 and b3 now send
  `Authorization: Bearer <key>`; URLs carry no credential. Auth
  injection moved from `buildUrl()` to a single new `authHeaders()` in
  `src/loomio/client.ts`. No configuration change: `LOOMIO_API_KEY` and
  `LOOMIO_B3_API_KEY` are unchanged.
- **Why it presented as a permissions bug.** Loomio answers a
  query-string key with `403 {"error":"You are not authorized to access
  this page."}` — the same response as an invalid key or a missing
  group role. `tests/loomio-auth.test.ts` now pins the scheme so a
  regression fails in CI instead of surfacing as a blanket 403.
- b3 bearer support follows Loomio's published note but is **untested
  here** — it needs a server-instance `B3_API_KEY`, which only Loomio
  instance operators hold.
- Docs updated throughout (README, INSTALL, DEPLOY, SECURITY, DESIGN,
  CONTRIBUTING, NOTES-ON-LOOMIO-API, glama.json).

## 0.0.8 — 2026-06-04

Follow-up hardening on the stateless OAuth client store (0.0.7). No
tool/API changes; tool counts unchanged.

- **Public clients honoured.** A client that registers with
  `token_endpoint_auth_method: "none"` (PKCE-only, no secret) is no
  longer issued a `client_secret`. 0.0.7 derived a secret for *every*
  client, leaving a public client in a contradictory state (auth method
  `none` yet carrying a secret). Confidential (`client_secret_post`)
  clients — including Claude.ai's — are unchanged, so there's no
  re-auth at this upgrade.
- **Oversized `client_id` guard.** `getClient` now rejects a
  `client_id` larger than 16 KB before doing any HMAC/JSON work —
  cheap defence against a crafted-input CPU drain. Legitimate signed
  ids are ~400 bytes.

## 0.0.7 — 2026-06-01

Fixes frequent connector **re-authentication** on the public (open-DCR)
deployment.

Cause: registered OAuth clients were held in an in-memory map
(`InMemoryClientsStore`), so any process recycle — a redeploy,
scale-to-zero, or a refresh routed to a different instance — lost the
registration and forced the client to re-authenticate. (Access/refresh
tokens are stateless and survive; but the SDK re-validates the client
against the store on every refresh, and the lookup missed.)

Fix: new **`StatelessClientsStore`**. The `client_id` is now a signed
blob (HMAC, same key as the tokens) encoding the registration metadata;
`getClient` verifies the signature and reconstructs the client instead
of a map lookup, and the `client_secret` is derived deterministically
from the `client_id`. So **any instance recognises any client with zero
shared state** — refresh and re-authorize survive restarts,
scale-to-zero, redeploys, and multi-instance routing. It mirrors the
existing stateless-token design. Open-DCR HTTP deployments use this
store; `InMemoryClientsStore` is retained for local/dev (single process).

Notes:

- At the upgrade, clients registered under the old in-memory UUIDs will
  re-authenticate **once**, then stay connected.
- Revocation remains global only (rotate `MCP_OAUTH_SIGNING_KEY`, which
  also invalidates outstanding tokens) — acceptable since all callers
  share one upstream Loomio identity.
- No tool/API changes; tool counts unchanged.

## 0.0.6 — 2026-05-29

Tooling and project-metadata only — **no API, tool, or behaviour
changes** (the compiled output is identical to 0.0.5 apart from the
advertised version string).

- **CI**: added `.github/workflows/ci.yml` — typecheck + tests + lint +
  build on every push/PR, across Node 22 and 24. (The repo had 121
  tests but nothing ran them automatically.)
- **`glama.json`**: corrected a stale inventory (it still said "9
  tools", pre-dating `list_events` / `get_user_activity`). Now
  accurately describes 12 tools (8 read, 4 write) plus the 2 opt-in b3
  admin tools, and notes the ToolAnnotations.
- **README**: npm / CI / license / Glama badges.

## 0.0.5 — 2026-05-29

Audit follow-ups + general-purpose hygiene. No new tools; counts
unchanged (8 reads + 4 writes + 2 b3 admin).

`list_events`:

- Without `limit`/`offset` it now **auto-paginates the full discussion
  stream** (merging the embedded `comments` / `users` / `polls` arrays
  across pages) up to a bounded cap, and reports `scope.complete` /
  `scope.pages_fetched` / `scope.events_truncated`. Pass `limit` and/or
  `offset` to get exactly one page as before. Previously a single
  default-page fetch could silently miss later events in a long thread.

`get_user_activity`:

- **Count fix:** `comment_edited` and `stance_updated` events were in
  the activity set but missing from the `counts` object, so they were
  silently bucketed as `other`. They're now counted under their own
  keys.
- **New completeness signal `scope.groups_truncated`** — groups whose
  discussion listing hit the per-group page cap (so some discussions
  weren't scanned). Joins the `complete` / `groups_failed` /
  `discussions_failed` / `discussions_truncated` / `discussions_capped`
  set from 0.0.4.
- **`until` must be later than `since`** when both are supplied
  (rejected at the schema layer).

General-purpose hygiene:

- Removed deployment-specific references so the connector reads as the
  general-purpose tool it is. Tool descriptions (which ship to every
  client over MCP) now use neutral examples instead of one instance's
  group names; docs use `example.org` placeholders and describe the
  Cloud Run / IaC deployment pattern generically rather than naming a
  specific operator's repos. No behaviour change.

## 0.0.4 — 2026-05-29

Hardening + clearer errors from a full pre-release audit. No new tools,
no API shape changes; counts unchanged (8 reads + 4 writes + 2 b3 admin).

Security:

- **Rate limiter now keys on the source IP, not the OAuth client_id**
  (`src/http/transport.ts`). Under open DCR a caller can `POST /register`
  for unlimited fresh client_ids, so a client-id-keyed limit was
  bypassable — each new client got its own bucket. Keying on IP restores
  the intended "N per minute per source" bound (trust-proxy=1 makes
  `req.ip` the real client address on Cloud Run).

Clearer 403s on the membership tools (the original motivation):

- Loomio answers a 403 with a bare `{"error":403}` and returns that SAME
  body whether the key is invalid, the bot isn't a member, or the bot is
  a member but lacks the group-admin (coordinator) role that
  `b2/memberships` requires. Indistinguishable from the response alone,
  so a raw 403 reads as a bug when it's usually a deliberate permission
  boundary (the bot is kept non-admin so it can't read everyone's email).
- New access classifier (`src/loomio/access.ts`): on a 403 from an
  admin-gated call it probes the member-gated `b2/polls?group_id=N` with
  the same key. Probe 200 → key valid, bot is a member, just not an admin;
  403 → invalid key or not a member; anything else → inconclusive. One
  extra GET, only on the rare 403 path; if the probe itself errors the
  original 403 is preserved rather than masked.
- `list_memberships` / `manage_memberships` now raise a tailored error
  explaining which case applies and what to do, and point at the
  non-admin fallback: names / usernames / ids (not email) via
  `get_user_activity` / `list_events`. NOTES-ON-LOOMIO-API.md "Gotcha 5"
  documents the behaviour (verified live).

`get_user_activity` robustness:

- **Global fan-out budget.** The per-group and per-discussion page caps
  multiplied with no overall ceiling; `MAX_SCAN_DISCUSSIONS` now bounds
  the expensive event-fetch stage so one public, auto-approvable call
  can't run away on a large instance.
- **Completeness signals.** The result's `scope` now carries `complete`,
  `groups_failed`, `discussions_failed`, `discussions_truncated`, and
  `discussions_capped`. Previously a group that 403'd mid-scan was
  silently dropped and the partial total looked authoritative — bad for
  the tool's headline participation-analysis use. Partial scans are now
  flagged so they're reported as partial.
- **`since` / `until` are validated.** An unparseable timestamp used to
  slip through and silently disable the time filter (NaN comparisons are
  always false), turning a bounded query into a full-history scan that
  still looked bounded. Now rejected at the schema layer.

Other:

- `redactPath` (`src/log.ts`) also redacts alphanumeric short-keys after
  `discussions` / `polls`, not just numeric ids — matches the documented
  "ids are de-identified" invariant now that verbose logging is on in
  production. (The api_key was never at risk; the query string is
  dropped regardless.)
- MCP server `version` synced to the package version.
- Docs: README tool catalog now lists `list_events` / `get_user_activity`
  (added in 0.0.2 but missed from the README list); DEPLOY.md leads with
  the open-DCR + readonly recipe and the custom-domain `PUBLIC_BASE_URL`;
  SECURITY.md gains an "HTTP / multi-user posture" section (open DCR,
  shared bot key, bot-memberships-as-boundary, the IP-keyed limiter, the
  403 fence). Readonly deployments advertise 8 tools, local stdio 12,
  with b3 14.

Deployment (tracked in the separate infrastructure repo, not here): the
reference Cloud Run service gained a 60s request timeout, instance/
concurrency caps matched to the fan-out workload, and a config toggle
for verbose logging.

## 0.0.3 — 2026-05-28

Tool-selection tuning. No new tools, no API changes — just rewrites
of the descriptions Claude reads when deciding which tool to call.

Motivation: in two real consumer chats analysed by the maintainer,
Claude reached for `list_polls` + `list_memberships` and reconstructed
participation client-side instead of calling `get_user_activity`,
even though the latter answers the question directly. The
reconstruction is more expensive AND ambiguous (you can't tell
"didn't vote" from "abstained" by reading a poll record alone). This
release rewires the descriptions so the right tool wins.

Description changes (counts unchanged: 8 reads + 4 writes + 2 b3 admin):

- `get_user_activity` — major rewrite. Explicit framing as the
  primary entry point for any user-centric question — single OR
  multi-user. Adds the pattern "for an N-user comparison, **call
  this tool N times**" with example phrasings: "compare participation
  across two groups", "rank members of group N by participation",
  "build a participation card for each member".
  Reframes the cost as amortised (the same `list_discussions` fetch
  serves every per-user call in the same conversation) and explains
  the canonical-stream advantage over a `list_polls`-based
  reconstruction.

- `list_polls` — adds a cross-ref at the end: for per-user
  participation questions, prefer `get_user_activity`. Calls out the
  abstain-vs-didn't-vote ambiguity that `list_polls` cannot resolve.

- `list_memberships` — adds an explicit "do NOT use this to construct
  a participation analysis" warning, redirecting to `get_user_activity`
  per member.

- `list_events` — adds a "do NOT loop this over every discussion
  yourself" warning, redirecting to `get_user_activity` for any
  cross-discussion user-centric question.

The data-driven follow-up — whether to add a `get_group_summary`
composite — is deferred until verbose logs from production show
whether description tuning alone closes the gap.

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
  adding a tool. Cross-repo links bridge the connector, the
  infrastructure repo, and the image-build repo.
- `encodePathSegment` rejects `""` / `"."` / `".."` defence-in-depth
  before URL-encoding.
- `list_groups` schema caps per-call probe span at 500 ids and
  rejects inverted ranges.
- `LoomioAuthError` now carries the HTTP status code; non-403
  auth failures propagate as errors instead of silently returning
  empty results.

## 0.0.1 — 2026-05-27

First tagged release. The connector has been live-tested against a
self-hosted Loomio 3.0.24 instance and the production Cloud Run
deployment is serving real traffic. Expect rough
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
