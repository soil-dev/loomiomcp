# HOWTO

Recipes for common tasks. Assumes the connector is wired into your MCP
host (Claude Desktop, Claude Code, Claude.ai via a Custom Connector).
The model picks the tool; the calls below show what it will do and what
to expect back. Ids, keys and names are illustrative.

## Does the connector work, and what can it see?

> Check the Loomio connection.

`check_connection({})` — one forced key-health probe, no other call.
Returns `key_status` (`valid` / `rejected` / `unreachable`), the account
the API key belongs to (`user`), its groups with `member_state`
(`member`, `pending` = invited but not accepted, `parent` = a subgroup's
parent it has not joined), `readonly` / `b3_enabled` (true only when
the four b3 tools are actually registered — the secret set AND not
read-only), the instance's
Loomio version against the tested one, and `notes[]` that explain
anything unusual in fixed wording (a rejected key and how to fix it, a
valid key with no groups, pending invitations). Call it first in a
session, or after a 403 or an unexpectedly empty list.

## Which groups?

> What Loomio groups do you have access to?

`list_groups({})` — ONE call on Loomio's `GET /b2/groups`. Rows are the
groups the connector's user is a member of (pending invitations
included) with `membership: {accepted, admin, delegate, title}`, plus
each subgroup's parent flagged `member: false`. `total` is Loomio's own
count. A **publicly visible group the user has not joined is not
listed** — Loomio ≥ 3.8 still lets the connector read its public threads
by id (`get_group`, `list_discussions`, `list_polls`), and they appear in
`list_threads` and `search_content`.

> Tell me about the Finance group. Can members start threads there?

`get_group({id_or_key_or_handle: "example-org-finance"})` — the full
record including the `members_can_*` permission flags, `member` /
`membership`, `parent`, `url`. A group that exists but is hidden from
the user answers a 403 the connector explains as "hidden group"; an
unknown id or handle is 404.

## What's new?

> Anything new in Loomio since yesterday?

`list_threads({limit: 20, since: "2026-09-19T00:00:00Z"})` — ONE call
listing every thread the user can see across all groups, newest
activity first, with `items_count`, `replies_count`, `last_activity_at`,
`tags` and a `url` per row, and `total` for the whole visible set.
Loomio's route has no date filter, so `since` is applied client-side to
the newest-first rows: page with `offset` until `scope.exhausted` is
true (the page's last dated row already predates the cutoff), and
threads with no `last_activity_at` are dropped and counted in
`scope.undated_dropped`. Optional `group_id` / `type` filter the fetched
page client-side too, so for one group's threads prefer
`list_discussions`.

> What's being discussed in group 17?

`list_discussions({group_id: 17})` — newest activity first, `status`
defaults to `open` (unlocked threads; `closed` = locked, `all` = both),
bodies capped at 1500 characters (`description_truncated: true` marks a
cut; set `description_max_chars: 0` to omit bodies, `-1` for full text),
exact `total`.

## Read or summarise a thread

> Summarise discussion `abcDEF12`.

The cheapest complete read is Loomio's own Markdown rendering:
`get_thread_markdown({discussion_id: "abcDEF12"})` (2 calls: one to
resolve the thread, one for the Markdown) or, when a previous result
already gave the thread's `topic_id`,
`get_thread_markdown({topic_id: 4242})` (1 call). It returns the front
matter, body, every comment, poll (with a results table where Loomio
lets this user see one), vote and outcome in thread order; `max_chars`
(default 60000) caps from the end and `truncated` says whether the
newest items were cut.

> Show me the discussion record and every comment with ids.

`get_discussion({id_or_key: "abcDEF12", include_items: true})` — the
record with its counters and `url`, plus `thread_items` (the
`list_thread_items` result: items in thread order with the reply tree,
comments, polls, stances, outcomes, users; `items_limit` /
`items_body_max_chars` tune it). Every items reply is budgeted
(`max_total_chars`, default 120000 characters): when
`thread_items.truncated_by_budget` is true, continue with
`list_thread_items({topic_id: 4242, offset: <next_offset>})` — Loomio's
items route is unpaginated, so each call fetches the whole thread once
and slices it here; `kinds: ["new_comment"]` keeps only comments.

## Find the thread about something

> Find the thread where we discussed the budget.

`search_content({query: "budget", types: ["Discussion"], order:
"relevance"})` — full-text across everything visible, at most **20**
results (Loomio's cap; `capped: true` means there are more — narrow the
query, group or types). Each hit has a `snippet` with `**match**`
emphasis, `discussion_key` / `poll_key` and a deep-link `url`; open it
with `get_discussion` and read it with `get_thread_markdown`.

> What did user 4242 post recently?

`search_content({author_id: 4242})` — that user's 20 newest visible
items, no full-text search.

## Browse polls and decisions

> What's up for vote in group 17?

`list_polls({group_id: 17})` — `status` defaults to `active` (open, not
yet closed); `closed` for past decisions, `all` for every kept poll.
Each poll carries `poll_options`, `current_outcome`, the connector
user's own `my_stance`, and `results_visible` /
`results_hidden_reason`: when Loomio would hide the tallies from a
member who has not voted (`until_vote`) or until the poll closes
(`until_closed`), the connector strips them — **absent counts mean
hidden, not zero.**

> Show me poll `xyz12345`.

`get_poll({id_or_key: "xyz12345"})`. For the individual votes as items,
`list_thread_items({topic_id: <the poll's topic_id>, kinds:
["stance_created", "stance_updated"]})`. Anonymous polls never reveal who
voted what.

## Who is most engaged?

> Rank the members of groups 17 and 18 by participation this year.

`get_participation_report({group_ids: [17, 18], start_month: "2026-01",
end_month: "2026-09"})` — ONE call for the whole group set. Every user's
`threads`, `comments`, `polls`, `votes` (cast), `votes_issued`,
`votes_missed`, `outcomes`, `reactions` and `total`, sorted by `total`.
Read `scope.note` before relaying: rows include everyone who ever held a
membership (revoked and deactivated accounts too), anonymous polls do
not count toward votes, and a vote is attributed to the month its ballot
was issued. `groups_not_visible` names requested groups Loomio dropped
because the connector's user is not a member.

## A member's activity

> How active has user 4242 been in groups 17 and 18 since March?

`get_user_activity({user_id: 4242, group_ids: [17, 18], since:
"2026-03-01"})` — one report call per group plus one author search
(N + 1 calls). The `user_id` comes from `list_memberships` (its
`users[]` carry id + name) or from a `get_participation_report` row
(`user_id` + `name`); nothing searches people by name. For ONE named
member in ONE group that report row already answers "how active" in a
single call — read it instead of resolving the id first. Loomio's report is month-grained, so `since` / `until`
widen to whole calendar months and `scope.since_effective` /
`until_effective` state exactly what was counted; there is no per-month
breakdown per user — call again with a narrower window for a period
figure. `by_group` splits the counts; `sample_events` are the user's
newest visible items with urls (examples, not a list). For "rank the
members" use `get_participation_report` instead — one call for everyone.

## Audit memberships

> List the current members of the group.

`list_memberships({group_id: 17})` returns the roster — user ids, names,
usernames, roles (`admin` / `delegate`, `title`) and join state — for any
group the connector's user is a member of. Member email addresses appear
only as `user_email` on a membership row, and only when that user is an
**admin (coordinator)** of the group (or invited the member); `users[]`
never carry emails (Loomio adds the connector account's own there, and
the connector removes it). If the result is an empty list with a `scope.note`, the
connector's user is not a member of that group: Loomio answers an empty
list, not 403, in that case. A real group always has at least its
creator, so never read an empty roster as "the group has no members".

## Start a new discussion

> Open a discussion in group 17 titled "Q3 retro" with the body "what
> went well, what didn't, what's next".

`create_discussion({title: "Q3 retro", group_id: 17, description: "what
went well, …", description_format: "md"})`. Leave `private` out unless
you mean to override the group's default (Loomio applies its own —
public for public-only groups, private otherwise); a value against the
group's `discussion_privacy_options` answers 422. The result is the
created record with its `url` and `topic_id`. If Loomio's echo places
the thread in a different group than requested the call throws naming
the created id — it never reports a misplaced thread as success.

## Reply to an existing thread

> Add a comment to discussion 4242 saying "Looks good to me."

`create_comment({discussion_id: 4242, body: "Looks good to me.",
body_format: "md"})`. `discussion_id` also takes the short key from a
Loomio URL or a `search_content` hit (`"abcDEF12"`; one extra call to
resolve it). Send `body_format: "html"` whenever the body contains HTML
— Loomio stores an omitted format as Markdown, and a body that starts
with an HTML tag is refused without it. To reply to a specific comment
(or a poll, vote or outcome), pass `parent_id` + `parent_type`
(`"Comment"`, `"Poll"`, `"Stance"`, `"Outcome"`) instead — `parent_type`
is required with `parent_id`.

## Run a proposal or poll

> Create a proposal in discussion 4242: "Adopt the new release process?"

`create_poll({title: "Adopt the new release process?", poll_type:
"proposal", discussion_id: 4242, options: ["agree", "abstain",
"disagree", "block"], closing_at: "2026-10-01T12:00:00Z"})`. **Options
are required** for every type except `question` — Loomio has no
built-in options through the API and would save a proposal with none;
Loomio's own option keys (`agree`, `abstain`, `disagree`, `block`;
`looks_good` / `not_sure` / `concerned` for `check`; `accept` / `decline`
for `count`) get its icons and labels. Without `closing_at` the poll
does not open for voting on its own; Loomio rounds it down to the hour.
Use `group_id` instead of `discussion_id` for a standalone poll, or
`topic_id` (from the discussion record) to skip the resolution call.
**`closing_at` is effectively required**: without it Loomio saves the
poll as an unopened draft (`opened_at: null`) that nobody can vote on
and `list_polls` does not list by default — the result then carries
`opened: false` and a `warning`; `update_poll` with a future
`closing_at` opens it. **A poll that opens is announced**: Loomio's
`notify_on_open` defaults to true and sends a `poll_announced`
notification to every eligible voter (in-app for all, email/push per
their settings). Pass `notify_on_open: false` to create it quietly.
`notify_recipients: true` with `recipient_audience: "group"` (needs the
announce permission) or explicit `recipient_user_ids` /
`recipient_emails` is a separate, additional notification to those
recipients. Send `details_format: "html"` whenever `details` contain
HTML — Loomio stores an omitted format as Markdown. An anonymous poll
needs `closing_at` and is always `hide_results: "until_closed"`.

## Edit or discard something you posted

`update_discussion({id_or_key: 4242, description: "…", description_format:
"md"})`, `update_poll({id_or_key: "xyz12345", closing_at: "…"})`,
`update_comment({id: 99001, body: "…"})` — the text you pass **replaces**
the old text (read it first and send the whole new body). A closed poll
cannot be edited; reopen it in Loomio's UI first.

`update_poll({id_or_key: "xyz12345", options: ["Block"]})` **adds** an
option: Loomio's PATCH would otherwise read `options` as the complete
set and delete every unlisted option together with the votes cast on
it, so the connector reads the poll's current `poll_option_names` first
and sends the union (two calls; `options_sent` in the result shows what
went out). Spell existing names as `get_poll` returns them ("Agree", not
"agree"). Options cannot be removed through the connector.

To **end voting soon**, set `closing_at` to the next full hour:
`update_poll({id_or_key: "xyz12345", closing_at: "2026-10-01T15:00:00Z"})`
— Loomio rounds the time down to the hour, requires the future, and its
hourly job closes the poll when that hour arrives (within ~60 minutes).
An immediate close, reopening and recording an outcome have no b2
route; those need Loomio's UI.

`delete_discussion` / `delete_poll` / `delete_comment` are Loomio's
**soft discard**: the record leaves every list and its text is blanked,
but nothing is permanently erased and a group admin can restore it in
Loomio — the connector cannot. They carry `destructiveHint: true`, so
clients prompt; confirm with the human before calling.

## The connector says "Loomio returned 403"

Read the whole message — the connector classifies Loomio's 403 bodies:

- `"You are not authorized to access this page."` with **UNAUTHENTICATED**
  — the API key is dead, almost always **rotated** (Loomio regenerates it
  when the user's password changes). The message says where the current
  key is (`/profile/api_access`). On a single `list_discussions` /
  `list_polls` call it can instead mean the target group is not visible
  to the connector's user; on the threads, search, reports and groups
  endpoints it can only mean the key.
- `"Not authorized to <action> <Model>."` — the key is fine; the
  connector's user lacks permission for that record. For `get_group`,
  `"Not authorized to show Group."` means the group exists and is hidden
  from the user.
- `"User is not an admin"` — `manage_memberships` needs the coordinator
  role on that group.
- "answered by a CDN/WAF in front of Loomio" — not a Loomio error at
  all; the request was blocked before Loomio saw it.

A **404 from the thread tools** means either no such thread or a thread
the connector's user may not see — Loomio does not distinguish. On the
HTTP deployment, `GET /health` gives the operator the key verdict
without a tool call (see DEPLOY.md); `check_connection` gives it to the
model.

## Add a new member

> Invite alice@example.com.

`manage_memberships({group_id: 17, emails: ["alice@example.com"]})`.
Additive only — nobody is removed. Requires the connector's user to be
an admin (coordinator) of that group.

## Reconcile to a roster (DANGEROUS)

> Set the group membership to exactly these 12 emails.

This requires `manage_memberships({group_id: 17, emails: [...],
remove_absent: true})`. Read `list_memberships({group_id: 17})` first
and confirm the diff with a human: Loomio removes every member not
listed — pending invitees too, cascading to subgroups, the connector's
own user included if its email is absent. The connector marks this tool
with `destructiveHint: true` so clients can prompt. See SECURITY.md.

## Instance administration (b3, single-tenant only)

With `LOOMIO_B3_API_KEY` set (and the server not read-only) four more
tools appear: `deactivate_user({id})` / `reactivate_user({id})`, and the
reads `get_user({id})` or `get_user({identity_type: "saml", uid: "…"})`
and `list_users({is_admin: true})`. The reads return **email addresses**
for any account on the instance, which is why they exist only on
deployments where one organisation owns the whole Loomio instance. A
`uid` containing a dot cannot be resolved on Loomio 3.8.1 — use the
numeric id.

## Drive the connector against a real Loomio from a shell

`scripts/live-test.mjs` (gitignored — it needs real credentials and
instance-specific ids, which it reads from the environment only) spawns
the built `dist/index.js` over stdio and calls every advertised read
tool once:

```
npm run build
LOOMIO_API_KEY=… LOOMIO_API_BASE_URL=https://loomio.example.org/api \
  READ_GROUP_ID=17 node scripts/live-test.mjs
```

It prints one line per tool — ok / error, what came back (counts,
totals, truncation flags) and the reply size — and a summary. With
`WRITE_GROUP_ID=<a sandbox group>` it also runs the write chain
(`create_discussion` → `update_discussion` → `create_comment` →
`update_comment` → threaded reply → `create_poll` → `update_poll` →
`delete_comment` → `delete_poll` → `delete_discussion`), prints the
created ids and discards anything the chain left standing. `USER_ID`
picks the user for `get_user_activity` (default: the connector's own
user); `B3_READS=1` adds `get_user` / `list_users` when the server
advertises them. Never point `WRITE_GROUP_ID` at a real group.

## Tool reference

The tool descriptions and field texts a client downloads at session start
are deliberately short: the whole 24-tool catalogue is about 36 KB
(~9 000 tokens, `node scripts/catalog-size.mjs` after `npm run build`),
paid before the first question. Each description says what a tool
returns and costs, which sibling to prefer, and the one caveat that
changes behaviour. Everything else — field-by-field outputs, permission
rules, Loomio's counting rules, the exact 403 / 404 texts — lives here,
one subsection per tool. Ids and names are illustrative.

### Shared conventions

**Cost.** "1 call" is one upstream request to Loomio. Addressing a thread
by `discussion_id` / `poll_id` instead of `topic_id`, or a comment's
discussion by its short key, adds one `compact=1` GET to resolve the
record; every row a list returns already carries the `topic_id` the
thread tools take, so pass it on and skip that call.

**Ids.** Discussions and polls accept a numeric `id` or the short `key`
from a Loomio URL (`/d/{key}`, `/p/{key}`) or a search hit
(`discussion_key` / `poll_key`). Groups also accept the URL handle.
Comments have numeric ids only. A person's `user_id` comes from
`list_memberships` (`users[]`), a `get_participation_report` row, or
`check_connection` (the connector's own account); nothing searches
people by name.

**`*_max_chars`** (`description_max_chars` on `list_discussions` /
`list_polls`, `body_max_chars` on `list_thread_items`,
`items_body_max_chars` on `get_discussion`): `-1` returns the field
whole, `0` omits it (`<field>_omitted: true`, `<field>_chars` kept),
`N` keeps the first N characters and marks the record
`<field>_truncated: true` with `<field>_chars`. No ellipsis is appended
and a cut never splits a surrogate pair. When `strip_html` is off and an
HTML body is longer than its cap, tag attributes (link `rel` / `target`,
heading ids, mention classes) and inter-tag whitespace are stripped
first so the capped characters carry words; `href` and `alt` survive.
`get_*` tools return full text.

**`strip_html`** (default `true` on `list_discussions`, `list_polls` and
`list_thread_items`; `false` on `get_discussion` and `get_poll`). When on
and the stored format is `html`, the body (`description`, `details`,
comment `body`, stance `reason`, outcome `statement`) is converted to
plain text BEFORE the cap and the record's `*_format` becomes `"text"`:
block boundaries (`p`, `div`, headings, `blockquote`, `pre`, tables,
lists) become newlines, each `<li>` starts with `- `, links keep their
text and lose the href, `script` / `style` are dropped, entities are
decoded, whitespace is collapsed. Markdown bodies, discarded (nulled)
bodies and format-less fields are never rewritten. With `strip_html` on,
`<field>_chars` counts the text the caller received; with it off, the
stored length. Write echoes (`create_*`, `update_*`, `delete_*`) return
HTML as stored. Poll `details` inside `list_thread_items` stay as stored.
`scope.strip_html` echoes the flag on every list.

**`*_format` on writes** (`description_format`, `details_format`,
`body_format`): Loomio stores an omitted format as `md` — every column
defaults to `"md"` and there is no group-level format setting. An HTML
body sent without `'html'` is kept as literal Markdown: the browser
happens to render it, but notification emails, chatbot posts and exports
strip the tags. The creates therefore refuse a body that starts with an
HTML block tag unless the format is given; on `update_*`, an omitted
format keeps the stored one.

**Collections** return Loomio's exact `total` (pre-pagination),
`returned`, and a `scope` block naming filters, caps, what was dropped or
not visible, and the upstream calls made. Relay those caveats with the
rows.

**Poll results** follow Loomio's own rule for the connector's user:
tallies are visible when `hide_results` is `off`, the poll is closed, or
it is `until_vote` and the connector's user has voted. Otherwise
`results`, `stance_counts`, `total_score`, `stv_results` and other
voters' `option_scores` / `reason` are stripped, and `results_visible:
false` + `results_hidden_reason` (`until_closed` | `until_vote`) say so.
Absent counts mean hidden, never zero. Anonymous polls never reveal who
voted what (`participant_id` is null on their stances).

**403 / 404.** The connector classifies Loomio's 403 bodies (see *The
connector says "Loomio returned 403"* above). Per tool the message
Loomio sends is listed below; `"Not authorized to <action> <Model>."`
always means the key is fine and the user lacks that permission.

### check_connection

- **Inputs:** none.
- **Cost:** one forced key-health probe — the authenticated
  `GET /b2/groups` plus the public version lookup the HTTP `/health`
  route also uses; the probe's groups body is reused, so no further
  call is made unless it failed to parse.
- **Returns:** `connector_version`, `tested_loomio_version`,
  `loomio_version` (null when unavailable), `key_status` — `valid` |
  `rejected` (Loomio no longer accepts the key: rotated with the user's
  password, or wrong) | `unreachable` (network / timeout / 5xx / a
  CDN-WAF 403 that never reached Loomio — says nothing about the key) —,
  `checked_at`, `readonly`, `b3_enabled` (true iff the four b3 tools are
  registered: secret set AND not read-only; a secret on a read-only
  deployment registers nothing and a note says so), `user` {id, name,
  username} (the account the key belongs to, resolved from its own
  membership rows; null when it is in no group), `groups[]` {id, name,
  handle, `member_state`: `member` | `pending` (invited, not yet
  accepted — Loomio already treats it as a member for visibility) |
  `parent` (a subgroup's parent the user has not joined, for navigation
  only), admin}, `groups_total`, `notes[]` in fixed wording
  (rejected-key remediation, valid key but no groups, pending
  invitations, non-member parents, version drift, readonly / b3 flags).
- **Caveats:** never returns key material or upstream error text. Use it
  before a long task, after a 403 or an unexpected empty list.

### list_groups

- **Inputs:** none. The 0.0.11 id-probe knobs (`start_id` / `end_id` /
  `stop_after_consecutive_misses`) are no longer in the schema; an
  older caller that still sends them is not rejected (unknown keys are
  dropped) and gets the same one-call result.
- **Cost:** 1 (`GET /b2/groups` = `current_user.groups`: every
  un-revoked membership, pending invitations included).
- **Returns:** rows with `id`, `key`, `handle`, `name`, `full_name`
  ("Parent - Subgroup"), `group_privacy` (`open` | `closed` | `secret`),
  `is_visible_to_public`, `discussion_privacy_options`,
  `memberships_count`, `discussions_count`, `polls_count`, `enabled`,
  `parent_id`, `url`, `member: true` and `membership` {accepted, admin,
  delegate, title}. Each subgroup's parent is appended too (Loomio
  side-loads it without a visibility check), flagged `member: false`
  with no `membership` — it may or may not be readable. Rows are deduped
  by id and sorted by `full_name`; `total` is Loomio's `meta.total`
  (member groups only); `scope.member_groups` /
  `scope.non_member_parents` split the count.
- **Caveats:** a publicly visible group the user has not joined is not
  listed, although Loomio ≥ 3.8 lets any authenticated user read its
  public threads: such a group is readable by id with `get_group`,
  `list_discussions`, `list_polls`, and its threads appear in
  `list_threads` and `search_content`. Instance `is_admin` widens
  nothing. An empty list with a valid key means the user is in no group.
  A 403 on this path can only be the key, so the tool throws the
  classified message instead of returning `[]`.

### get_group

- **Inputs:** `id_or_key_or_handle` — Loomio resolves a numeric id, then
  a short key, then a URL handle, in that order.
- **Cost:** 1.
- **Returns:** `group` — the full record (name, full_name, handle,
  description, group_privacy, is_visible_to_public,
  discussion_privacy_options, every `members_can_*` permission flag,
  memberships_count / discussions_count / polls_count / subgroups_count,
  created_at, parent_id, …) minus attachment, link-preview and
  cover-image metadata and minus the billing `subscription` block (plan,
  seat caps, renewal dates; `enabled` already says whether the group is
  active) — plus `member` (the connector's user holds a membership,
  accepted or pending), `membership` {accepted, admin, delegate, title}
  or null, `parent` {id, name, handle} or null, `subgroups_count`,
  `url`.
- **Caveats:** works for groups the user is not a member of whenever
  Loomio's `can?(:show, group)` admits them — publicly visible, or shown
  to parent-group members and the user is one. Read
  `members_can_start_discussions`, `members_can_raise_motions`,
  `members_can_add_members`, `members_can_edit_comments` before a write.
  403 `"Not authorized to show Group."` = the group exists and is hidden
  from this user; an unknown identifier is 404.

### get_discussion

- **Inputs:** `id_or_key`; `strip_html` (default false);
  `include_items`; `items_limit` (default 200, max 1000);
  `items_body_max_chars` (default 4000).
- **Cost:** 1; 2 with `include_items`.
- **Returns:** `discussion` — id, key, title, full `description` +
  `description_format`, group_id, `topic_id`, author_id, created_at,
  updated_at, versions_count, discarded_at, attachments_count — joined
  with the thread counters from Loomio's topic row (items_count,
  replies_count, last_activity_at, locked_at, pinned_at, tags,
  members_count, seen_by_count, active_polls_count, closed_polls_count)
  and its canonical `url`; `group` (slim, with
  `discussion_privacy_options`); `users` (author and others referenced).
  With `include_items: true`, `thread_items` is the `list_thread_items`
  result for this thread (the opening post is not serialised a second
  time); its `truncated_by_budget` + `next_offset` say when to page on
  with `list_thread_items`. Embedded items use `strip_html`'s default
  (true); there is no separate knob.
- **Caveats:** Loomio's API reports no per-thread privacy flag: infer it
  only when `group.discussion_privacy_options` is `public_only` or
  `private_only` (a `public_or_private` group leaves it unknown), or
  from the `private` you passed on create / update. 403 `"Not
  authorized to show Discussion."`; unknown id or key 404.

### list_discussions

- **Inputs:** `group_id`; `status` — `open` (unlocked; the connector's
  default, sent explicitly because Loomio's own default when the
  parameter is absent is every kept thread INCLUDING locked ones),
  `closed` (locked), `all`; `limit` 1–200 (Loomio default 50); `offset`;
  `description_max_chars` (default 1500); `strip_html` (default true).
- **Cost:** 1.
- **Returns:** rows shaped like `get_discussion` (topic counters and
  `url` joined, body capped), `users` slim, exact `total`, `scope`
  echoing the filter and `strip_html`.
- **Caveats:** only that group's threads — subgroups are not included.
  The connector's user must be able to see the group (member, or the
  group is publicly visible), otherwise the generic 403 (the error says
  the group may simply be invisible).

### create_discussion

- **Inputs:** `title`, `group_id`; `description` + `description_format`;
  `private` (true = members only); `tags` (new tags need
  `members_can_create_tags` unless admin); `recipient_audience: 'group'`
  (needs the announce permission, 403 otherwise), `recipient_user_ids`,
  `recipient_emails` (non-members are invited as guests),
  `recipient_message`, `notify_recipients` (false = add recipients
  without emailing them).
- **Cost:** 1 (`POST /b2/discussions`, nested body).
- **Returns:** the created discussion shaped like `get_discussion`
  (`id`, `key`, `url`, `topic_id`, group, counters). Quote the `url`
  back to the human.
- **Caveats:** omit `private` and Loomio applies the group's own default
  (public for public-only groups, private otherwise); a value against
  the group's `discussion_privacy_options` answers 422. Permission:
  the user must be allowed to start threads in the group — 403 `"Not
  authorized to create Discussion."` otherwise. If Loomio's echo places
  the thread in a different group than requested the call THROWS naming
  the created id; it never reports a misplaced thread as success.

### update_discussion

- **Inputs:** `id_or_key`; any of `title`, `description` (+
  `description_format`; omitted keeps the stored format), `private`
  (422 against `discussion_privacy_options`), `allow_comments`,
  `allow_reactions`, `allow_concurrent_polls`, and recipients to add
  (`recipient_user_ids`, `recipient_emails`, `recipient_audience:
  'group'`, `recipient_message` — a message makes Loomio record a
  visible "edited" item and notify, `notify_recipients`). At least one
  field is required.
- **Cost:** 1 (`PATCH /b2/discussions/{id}`).
- **Returns:** the updated record shaped like `get_discussion`
  (`versions_count` increments). Idempotent.
- **Caveats:** the body is REPLACED, not appended — read it with
  `get_discussion` first and send the whole new text. Cannot move a
  thread to another group or change its tags (Loomio drops both silently
  on update). Permission: the author, a thread admin, or any member
  where the group allows members to edit discussions — else 403 `"Not
  authorized to update Discussion."`; a discarded thread cannot be
  edited; unknown 404.

### delete_discussion

- **Inputs:** `id_or_key`. **Cost:** 1 (`DELETE /b2/discussions/{id}`).
- **Semantics:** Loomio's SOFT delete — `discarded_at` / `discarded_by`
  stamped, title and body blanked, the thread leaves every list, but the
  records (and every comment, poll and vote in it) remain and a group
  admin can restore the thread in Loomio; the connector cannot undo it.
- **Returns:** the discarded record (`discarded: true`) plus a note.
- **Caveats:** permission: the author or a thread admin — 403 `"Not
  authorized to discard Discussion."` otherwise. Confirm with the human
  first (`destructiveHint: true`); prefer `update_discussion` for a
  mistake in the text.

### get_poll

- **Inputs:** `id_or_key`; `strip_html` (default false).
- **Cost:** 1.
- **Returns:** `poll` — id, key, title, full `details` + `details_format`,
  poll_type, group_id, `topic_id`, author_id, closing_at, closed_at,
  hide_results, anonymous, specified_voters_only, voters_count,
  decided_voters_count, undecided_voters_count, cast_stances_pct,
  poll_option_names, the type knobs — joined with the thread counters;
  `poll_options[]` {id, name, priority, meaning, prompt};
  `current_outcome` (statement, author, created_at) or null;
  `my_stance` (the connector user's own vote: cast_at, option_scores,
  reason) or null; `url`; `group` and `users` slim; `results_visible` /
  `results_hidden_reason` and, when visible, `results[]`,
  `stance_counts`, `total_score`, `stv_results`.
- **Caveats:** a poll has no `discussion_id`: `topic_id` is its thread,
  and for a poll inside a discussion it is that discussion's topic_id —
  pass it to `list_thread_items` / `get_thread_markdown`. 403 `"Not
  authorized to show Poll."`; unknown 404.

### list_polls

- **Inputs:** `group_id`; `status` — `active` (default, sent explicitly:
  kept, opened, not yet closed), `closed` (closed_at set), `all` (every
  kept poll) — exactly how Loomio reads the parameter; `limit` 1–200;
  `offset`; `description_max_chars` (caps `details`, default 1500);
  `strip_html` (default true).
- **Cost:** 1.
- **Returns:** SLIM rows — identity, type, schedule, hide_results /
  anonymous, participation counts, `stance_counts` + `total_score` when
  visible (aligned with `poll_options[]`), topic counters,
  `poll_options[]`, `current_outcome`, `my_stance`, `url`; the
  per-voter `results[]` and the type knobs Loomio left null are omitted
  (use `get_poll`). Same results gate as `get_poll`. `users` slim; exact
  `total`.
- **Caveats:** for per-user participation questions ("who voted", "how
  often did X vote") do not reconstruct from polls × memberships: call
  `get_participation_report` (one call, votes issued vs cast) or
  `get_user_activity`; those never confuse "abstained" with "did not
  vote".

### create_poll

- **Inputs:** `title`; `poll_type` — one of `proposal`, `poll`, `count`,
  `score`, `ranked_choice`, `meeting`, `dot_vote`, `check`, `question`,
  `stv`; `options` — required for every type except `question`
  (`ranked_choice` / `stv` need at least 2; Loomio's model validates
  none of this and would save an option-less proposal, so the schema
  refuses what the UI would). Option names Loomio recognises get its
  icons, meanings and locale labels: for `proposal` `agree`, `abstain`,
  `disagree`, `block`, `veto`, `consent`, `objection`, `object`,
  `looks_good`, `could_be_better`, `needs_a_rethink`, `accept`,
  `decline`, `yes`, `no`; for `count` `accept`, `decline`; for `check`
  `looks_good`, `not_sure`, `concerned`; any other name is a plain
  option; `meeting` options are ISO-8601 start times. Place: `group_id`
  for a standalone poll (its own thread; `tags` apply there), or
  `discussion_id` / `topic_id` for a poll inside a thread — exactly one
  of those two; a `group_id` given alongside is only cross-checked
  against the thread's group (one extra read, 409 on mismatch, nothing
  written). `anonymous` (permanent; needs `closing_at`; refused for
  `count`, `question`, `meeting`; forces `hide_results: until_closed`,
  `stance_reason_required: disabled`, `notify_on_closing_soon:
  undecided_voters`). `details` + `details_format`. `closing_at`
  (ISO-8601, future; Loomio rounds it DOWN to the hour). `hide_results`
  `off` (default) | `until_vote` | `until_closed` (never relaxable
  later). `specified_voters_only` (only `recipient_user_ids` /
  `recipient_emails` may vote). `shuffle_options`. `notify_on_open`
  (Loomio's default is TRUE: `poll_announced` to every eligible voter,
  in-app for all, email/push per their settings).
  `notify_on_closing_soon` `nobody` (API default; the web form
  pre-selects `undecided_voters`) | `author` | `undecided_voters` |
  `voters`. `stance_reason_required` `optional` (default) | `disabled` |
  `required` | `required_for_disagree_or_block` | `required_for_block`;
  `reason_prompt`. `show_none_of_the_above` (poll, ranked_choice).
  `min_score` (score; default 0), `max_score` (score default 5; meeting
  2 = yes / maybe / no), `dots_per_person` (dot_vote, default 8),
  `minimum_stance_choices` (poll 1; ranked_choice = ranks required,
  default 3), `maximum_stance_choices` (poll 1 = single choice; raise
  for multi-choice), `stv_seats`, `meeting_duration` (minutes; no
  default through the API — the form uses 60), `can_respond_maybe`
  (meeting; API default false — the form uses true). Recipients:
  `recipient_audience: 'group'` (announce permission, 403 otherwise),
  `recipient_user_ids`, `recipient_emails` (non-members become guests),
  `recipient_message`, `notify_recipients` (default false; a separate,
  additional notification — not the open announcement).
- **Cost:** 1; 2 with `discussion_id`, or with `topic_id` + `group_id`.
- **Returns:** the poll shaped like `get_poll` (`id`, `key`, `url`,
  `poll_options`, `topic_id`) plus `opened` and, when false, a
  `warning`.
- **Caveats:** without `closing_at` Loomio saves the poll UNOPENED
  (`opened_at` null): nobody can vote, `list_polls` (status `active`)
  omits it, and `update_poll` with a future `closing_at` opens it later.
  Permission: group admin, member where `members_can_raise_motions`, or
  thread admin, and the thread must allow another poll
  (`allow_concurrent_polls` or none active) — 403 `"Not authorized to
  create Poll."` otherwise. The call THROWS naming the created id if
  Loomio's echo disagrees on the group / thread or shows no options.

### update_poll

- **Inputs:** `id_or_key`; any of `title`, `details` (+
  `details_format`), `closing_at` (extend or shorten; must stay in the
  future; rounded down to the hour; a `closing_at` that first opens a
  draft also triggers `poll_announced` unless `notify_on_open` is
  false), `options` (names to ADD), `hide_results` (may be tightened;
  `until_closed` can never be relaxed), the other settings listed under
  `create_poll`, and recipients to add as voters (`recipient_message`
  records a visible "edited" item and notifies; `notify_recipients`
  emails them). At least one field is required.
- **Cost:** 1 (`PATCH /b2/polls/{id}`); 2 with `options`.
- **`options` semantics:** Loomio's PATCH reads `options` as the
  COMPLETE set and deletes every unlisted option together with the votes
  cast on it. The connector therefore reads the poll's current
  `poll_option_names` first and sends the union (stored names first, in
  their order, then the new ones); the result's `options_sent` shows
  exactly what went out. Spell existing names as `get_poll` returns them
  ("Agree", not "agree"). It never removes an option it saw, but the two
  calls are not atomic: an option another editor adds in between is
  dropped by Loomio, so avoid concurrent edits. Removing options is not
  offered.
- **Returns:** the updated poll shaped like `get_poll`.
- **Caveats:** cannot change `poll_type`, `anonymous`, the group or
  tags. Permission: a poll admin (author or group admin), thread not
  locked, poll NOT closed — a closed poll answers 403 `"Not authorized
  to update Poll."` (reopen it in Loomio first). An anonymous poll's
  configuration is frozen once any ballot exists (422). To END VOTING
  SOON set `closing_at` to the next full hour: Loomio's hourly job
  closes the poll when that hour arrives (within ~60 minutes). An
  immediate close, reopening, and recording an outcome have no b2
  route; those need Loomio's UI.

### delete_poll

- **Inputs:** `id_or_key`. **Cost:** 1 (`DELETE /b2/polls/{id}`).
- **Semantics:** Loomio's SOFT delete — the poll leaves every list, its
  title / details are blanked and its vote items vanish from the thread
  view, but the poll and the votes remain and a group admin can restore
  it in Loomio; the connector cannot undo it.
- **Returns:** the discarded record (`discarded: true`) plus a note.
- **Caveats:** permission: a poll admin, thread not locked — 403 `"Not
  authorized to destroy Poll."` otherwise. To end voting early prefer
  `update_poll` with `closing_at` at the next full hour.

### list_threads

- **Inputs:** `limit` (default 20, max 100), `offset` (both upstream);
  `group_id`, `type` (`Discussion` | `Poll`), `since` (ISO-8601) — all
  three applied CLIENT-SIDE within the fetched page.
- **Cost:** 1 (`GET /b2/threads`).
- **Returns:** rows with `topic_id`, `type`, the fronting record's
  `id` / `key` / `title` / `author_id`, `group_id`, `items_count`,
  `replies_count`, `last_activity_at`, `locked_at`, `pinned_at`, `tags`,
  `active_polls_count`, `closed_polls_count`, poll schedule for poll
  threads, `url`; no bodies. `total` is the whole visible set (member
  groups plus public threads of public groups).
- **Caveats:** Loomio's route has no group or date filter. A filtered
  page can be short while `total` stays instance-wide; for one group's
  threads prefer `list_discussions` / `list_polls`, which filter
  upstream. With `since`, rows older than the cutoff are dropped, rows
  with no `last_activity_at` are dropped and counted in
  `scope.undated_dropped`, and `scope.exhausted` turns true when the
  page's last dated row already predates the cutoff (or the page was
  short) — page with `offset` until then.

### list_thread_items

- **Inputs:** exactly one of `topic_id`, `discussion_id`, `poll_id`;
  `kinds` — any of `new_discussion`, `new_comment`, `poll_created`,
  `stance_created`, `stance_updated`, `outcome_created`,
  `poll_closed_by_user`, `poll_edited`, `poll_reopened`,
  `discussion_edited`, `discussion_title_edited`,
  `discussion_description_edited`, `discussion_closed`,
  `discussion_reopened`, `discussion_moved`, plus `other` for any kind
  the connector does not catalogue; `limit` (default 200, max 1000),
  `offset` (both client-side, after the kinds filter);
  `include_reactions` (default false: reactions are dropped upstream);
  `body_max_chars` (default 4000); `strip_html` (default true: comment
  bodies, stance reasons and outcome statements); `max_total_chars`
  (default 120000; `-1` = no budget; `0` is refused).
- **Cost:** 1 by `topic_id`; 2 by `discussion_id` / `poll_id`.
- **Returns:** `items[]` in thread order — `sequence_id`, `depth`,
  `parent_id` (the reply tree), `kind`, `actor_id`, `created_at`,
  `itemable_type` / `itemable_id` — plus only the records the returned
  items reference: `comments` (body capped, `body_truncated` /
  `body_chars` when cut), `polls` (identity, type, schedule,
  hide_results, participation counts, `poll_options[]` {id, name,
  priority} — the ids a stance's `option_scores` is keyed by —,
  `stance_counts` only when visible), `stances` (`participant_id`, null
  on anonymous polls; `option_scores`; `reason`), `outcomes`, `users`
  {id, name, username}; `total` (every item), `matched` (after the kinds
  filter), `returned`; `truncated_by_budget`; `next_offset`; `scope`
  (side-load `profile`, `chars` counted, `strip_html`, `own_user_known`).
- **Caveats:** Loomio's items route is UNPAGINATED — the whole thread is
  fetched once per call and sliced here. `max_total_chars` budgets the
  WHOLE reply in shaped characters: the slice stops before the item that
  would overrun it (never before the first) and `next_offset` says where
  to continue; `next_offset` is also set when `limit` ended the slice.
  Poll results follow the visibility rule above; own votes are
  recognised via the id the health probe learned. A thread the user
  cannot see is 404 (never 403); a 404 while resolving `discussion_id` /
  `poll_id` means no such id or key.

### get_thread_markdown

- **Inputs:** exactly one of `topic_id`, `discussion_id`, `poll_id`;
  `max_chars` (default 60000; `-1` = whole document; `0` refused).
- **Cost:** 1 by `topic_id`; 2 otherwise.
- **Returns:** `heading`, `markdown`, `chars` (the full length),
  `truncated`, the thread's type / id / key / title / url when known,
  `scope`. The document is Loomio's own rendering: YAML front matter
  (group, created, last_activity, tags), the title with author and date,
  the opening body, then every comment, poll (options, status, and a
  results table or a "hidden until…" line — Loomio applies the
  vote-visibility rule itself), vote and outcome in thread order with
  author + UTC timestamp headings.
- **Caveats:** the cap cuts from the END, so `truncated: true` means the
  newest items were dropped; for recent activity in a huge thread prefer
  `list_thread_items` with an offset. Discarded items are omitted;
  anonymous votes never name the voter.

### search_content

- **Inputs:** `query` (words match as prefixes, `!word` excludes, close
  spellings are tried for short unquoted queries) and / or `author_id`
  (alone: that user's 20 newest visible items, no full-text search);
  `group_id` (not its subgroups; an invisible group yields no results,
  not an error); `types` (subset of `Discussion`, `Comment`, `Poll`,
  `Stance`, `Outcome`; e.g. `['Outcome']` for decisions); `tag` (exact
  name); `order` — `authored_at_desc` (default), `authored_at_asc`,
  `relevance` (best exact matches first; prefer it when hunting for THE
  thread about something). Author-only mode is always newest first.
- **Cost:** 1 (`GET /b2/search`).
- **Returns:** `results[]` — `type`, `id` (the record's own id),
  `title` (its thread), `snippet` (Markdown with `**match**` emphasis,
  ≤ 400 chars), `group` {id, full_name, handle} (`full_name` is
  Loomio's "Parent - Subgroup" form — join to `list_groups` on `id`, not
  the name), `author` {id, name}, `authored_at`, `discussion_key`,
  `poll_key`, `poll_id`, `sequence_id`, `url`; `returned`, `capped`,
  `mode`, `scope` (`hidden_stance_hits_dropped`).
- **Caveats:** Loomio's hard limits — at most 20 results, no paging, no
  total; `capped: true` means more matches exist, so narrow the search
  rather than assume completeness. Vote reasons follow the visibility
  rule, and stricter: a Stance hit on a poll whose results are hidden
  from the connector's user is DROPPED from a `query` search (with a
  term to probe, the hit's mere existence would confirm the term occurs
  in the withheld reason) and counted in
  `scope.hidden_stance_hits_dropped`; in author-only mode it stays with
  `snippet: null` + `snippet_hidden_reason`. Private content in groups
  the user has not joined is silently absent.

### get_participation_report

- **Inputs:** `group_ids` (1–50, counted TOGETHER — a user in several
  gets one combined row) or `group_scope: 'my'` (every group the
  connector's user belongs to plus the subgroups it can see);
  `start_month` / `end_month` as `YYYY-MM`, both inclusive (default:
  the 12 months ending this month); `delegates_only`; `limit` (1–500,
  default 50: rows kept after sorting by `total` desc);
  `include_inactive` (default false: users with `total` 0 in the period
  are dropped before ranking).
- **Cost:** 1 (`GET /b2/reports?section=users` — the report Loomio
  shows members on a group's participation page; no admin role needed).
- **Returns:** `users[]` — `user_id`, `name`, `delegate`, `threads`,
  `comments`, `polls`, `votes` (= `votes_cast`), `votes_issued`,
  `votes_missed`, `all_votes_cast`, `outcomes`, `reactions`, `total`
  (threads + comments + polls + votes + outcomes; reactions and issued /
  missed ballots excluded) — sorted by `total` desc; `total_users`
  (ranked rows before the `limit` cut, after the inactive filter);
  `returned`; `groups` (what Loomio actually counted);
  `groups_not_visible` (requested groups Loomio dropped silently because
  the connector's user is not a member); `period` {start_month,
  end_month, since_effective, until_effective}; `scope` {scope,
  group_ids, limit, include_inactive, inactive_dropped, complete, note}.
  The note states the call's own numbers ("showing the top N of M
  ranked users", "K user(s) with no counted activity were dropped —
  pass include_inactive: true to list them").
- **Caveats — read before relaying:** the row set is everyone who EVER
  held a membership in the groups, revoked and deactivated accounts too;
  with `include_inactive: true` their all-zero rows are normal and mean
  "no counted activity in the window", not "inactive member"
  (`list_memberships` tells current membership). Anonymous polls are
  excluded from `votes` / `votes_issued` / `votes_missed`. A vote is
  counted in the month its counted stance row was created — when the
  ballot was issued (poll opened, or the voter added later) or, for a
  vote Loomio replaced on change, when it was changed — not necessarily
  when it was first cast. Guests' content is not counted.
  `scope.complete` is false when a group was dropped. Rows carry
  `user_id` + `name`, so one named member's row answers "how active"
  without resolving the id first. There is no instance-wide totals tool
  (the report's `base` section is not exposed).

### get_user_activity

- **Inputs:** `user_id`; `group_ids` (1–50); `since` / `until`
  (ISO-8601). The report is MONTH-GRAINED, so both widen to whole
  calendar months: `since: 2026-03-15` counts from 1 March;
  `until: 2026-06-01T00:00Z` counts through May.
- **Cost:** one report call per group (at most 4 in flight) plus one
  author-mode search — N + 1 for N groups.
- **Returns:** `counts` — `threads`, `comments`, `polls`, `votes`
  (= votes_cast), `votes_issued`, `votes_missed`, `outcomes`,
  `reactions`, `total` — the same per group in `by_group` (with the
  group's name, the user's delegate flag there, and `listed: false`
  when Loomio's report has no row for the user in that group); `user`
  {id, name, delegate_in}; `latest_item_at`; `sample_events` (the user's
  newest visible items in these groups: type, id, title, group,
  authored_at, url, `in_window` when a window was given; at most 20, no
  date filter — examples, not a list); `scope` {since_effective,
  until_effective, groups_not_visible, groups_failed, complete, note}.
- **Caveats:** `groups_not_visible` are requested groups Loomio dropped
  silently (not a member) — their activity is NOT in the counts;
  `groups_failed` are report calls that errored; `complete` is false
  when either is non-empty; a call in which every report failed throws
  instead of returning zeros. There is no per-month breakdown per user:
  call again with a narrower window for a period figure. The same
  counting rules as `get_participation_report` apply (anonymous polls,
  stance-row month, guests). For "compare A and B" call once per user
  with the same `group_ids`.

### list_memberships

- **Inputs:** `group_id`; `limit` 1–200 (Loomio default 50); `offset`.
- **Cost:** 1 (`GET /b2/memberships?group_id=…&compact=1`).
- **Returns:** `memberships[]` {id, user_id, group_id, admin, delegate,
  title, inviter_id, created_at, accepted_at (null = invited, not yet
  accepted), user_email — only when Loomio sent it}, `users[]` {id, name,
  username — never email}, `total` (Loomio's exact roster size),
  `returned`, `scope`.
- **Caveats — who sees what:** any member can read the roster; no admin
  role is needed. Member email addresses arrive as `user_email` on the
  membership row only for groups where the connector's user is an admin
  (coordinator), and for members it invited itself — other rosters come
  back without emails, silently. Loomio also puts the connector
  account's OWN email on its `users[]` row; the connector removes it.
  If the connector's user is NOT a member (or the group is hidden from
  it), Loomio answers 200 with an EMPTY list rather than 403 and
  `scope.note` says so — a real group always has at least its creator,
  so never read an empty roster as "no members". Use it for "who are
  the coordinators" (`admin: true`), to resolve a member's name to a
  `user_id`, to find a member by email (admin groups only), and always
  before `manage_memberships` with `remove_absent`.

### manage_memberships

- **Inputs:** `group_id`; `emails` (1+ addresses to ensure are
  members); `remove_absent` (default false).
- **Cost:** 1 (`POST /b2/memberships`).
- **Returns:** `added_emails`, `removed_emails` — exactly what changed.
- **Caveats:** requires the group admin (coordinator) role on THAT group
  — 403 `"User is not an admin"` otherwise; being an admin of the parent
  group or an instance admin does not count. Default mode is additive:
  every address not yet a member is invited, no existing member is
  touched. `remove_absent: true` makes Loomio REMOVE every existing
  member whose email is NOT in `emails` — pending invitees included,
  cascading to the group's subgroups, and the connector's OWN user if
  its email is absent (locking the connector out of the group). An empty
  or stale list can wipe the entire group; there is no server-side
  dry-run and no undo. Always call `list_memberships` first, compute the
  diff explicitly, and confirm with a human. See SECURITY.md.

### create_comment

- **Inputs:** `body` + `body_format`; the target — `discussion_id`
  (numeric id, or the short key from a URL / search hit, which costs one
  call to resolve because Loomio's `parent_id` column is an integer and
  a key on the wire would be cast to 0) for a top-level comment, or
  `parent_id` + `parent_type` (`Comment` for a threaded reply; `Poll`,
  `Stance`, `Outcome` to comment on those; `Discussion` is equivalent to
  `discussion_id`). `parent_type` is required with `parent_id` (Loomio
  500s in its ability check without it).
- **Cost:** 1 (`POST /b2/comments`, flat body); 2 when `discussion_id`
  is a short key.
- **Returns:** the comment (`id`, `topic_id`, `parent_id` /
  `parent_type`, `body`, timestamps) with its author; use the `topic_id`
  with `list_thread_items` / `get_thread_markdown` to see it in context.
- **Caveats:** permission: a member of the thread whose group allows
  comments, and the thread must not be locked — 403 `"Not authorized to
  create Comment."` otherwise.

### update_comment

- **Inputs:** numeric `id`; `body` (REPLACES the whole text — read the
  current one with `list_thread_items` first); `body_format` (omitted
  keeps the stored format).
- **Cost:** 1 (`PATCH /b2/comments/{id}`).
- **Returns:** the updated comment; Loomio sets `edited_at` and
  increments `versions_count`. Idempotent.
- **Caveats:** permission: the author while the group allows members to
  edit comments, or a thread admin where the group allows admins to edit
  user content; the comment must be kept and the thread unlocked — 403
  `"Not authorized to update Comment."` otherwise.

### delete_comment

- **Inputs:** numeric `id`. **Cost:** 1 (`DELETE /b2/comments/{id}`).
- **Semantics:** Loomio's SOFT delete — the body is blanked and the
  comment drops out of the thread view, but the record stays (replies
  keep their place) and the author or a thread admin can restore it in
  Loomio; the connector cannot undo it.
- **Returns:** the discarded record (`discarded: true`, `body: null`)
  plus a note.
- **Caveats:** permission: the author (as a thread member) or a thread
  admin, thread not locked — 403 `"Not authorized to discard Comment."`
  otherwise. Prefer `update_comment` for a wording fix.

### deactivate_user, reactivate_user, get_user, list_users (b3)

All four authenticate with `LOOMIO_B3_API_KEY` — the Loomio SERVER's
own secret (`B3_API_KEY`, ≥ 17 chars), not a user key — and are
registered only when it is set AND the server is not read-only. They
are meant for single-tenant deployments: one organisation owns the
whole Loomio instance.

- **`deactivate_user({id})`** — 1 call (`POST /b3/users/{id}/deactivate`,
  the member route; the `?id=` collection route is deprecated).
  Asynchronous on Loomio's side: it enqueues `DeactivateUserWorker` and
  answers `{success: true, user}` at once, so the echoed user can still
  show `active: true` / `deactivated_at: null` — re-read with `get_user`
  to confirm. The worker then stamps `deactivated_at`, revokes the
  user's memberships, mobile devices and pending membership requests.
  Reversible with `reactivate_user` while the record persists. 404 if
  the user is not currently active. `destructiveHint: true`.
- **`reactivate_user({id})`** — 1 call, synchronous: clears
  `deactivated_at` AND restores exactly the memberships the deactivation
  revoked (those whose `revoked_at` matches its timestamp); memberships
  revoked separately are not touched. Returns `user` already
  `active: true`. 404 if the user is not currently deactivated.
- **`get_user({id})` or `get_user({identity_type, uid})`** — 1 call
  (`GET /b3/users/{id}` or `/b3/users/identity/{type}/{uid}`, e.g. the
  SAML / OAuth subject). Returns `user` {id, name, username, EMAIL,
  is_admin, active, deactivated_at, identities[{identity_type, uid,
  email, name}]} for ANY account on the instance, member of the
  connector's groups or not, plus `resolved_by`. A `uid` containing a
  dot (most emails) cannot be resolved on Loomio 3.8.1 — Rails reads the
  suffix as a format — so use the numeric id for those. 404 when nothing
  matches.
- **`list_users({is_admin?})`** — 1 call (`GET /b3/users`, unpaginated,
  ordered by id): EVERY account, active and deactivated, in every group
  or none; `is_admin: true` narrows to instance administrators, `false`
  to non-admins. Rows as `get_user`. On a large instance the response is
  big (thousands of rows): prefer `get_user` when you know who you want
  and `list_memberships` for "who is in group X" (no b3 secret needed).
  Use it for "who are the instance admins", "find the account for this
  email", or an audit of deactivated accounts.
