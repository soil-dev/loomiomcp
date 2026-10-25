# HOWTO

Recipes for common tasks. Assumes the connector is wired into your MCP
host (Claude Desktop, Claude Code, Claude.ai via a Custom Connector).
The model picks the tool; the calls below show what it will do and what
to expect back. Ids, keys and names are illustrative.

## Does the connector work, and what can it see?

> Check the Loomio connection.

`check_connection({})` — one forced key-health probe, and no other call
up to 50 member groups (Loomio ≥ 3.11.1 puts only the first 50 in the
probe's reply; beyond that the rest is read in pages of 500).
Returns `key_status` (`valid` / `rejected` / `unreachable`), the account
the API key belongs to (`user`), its groups with `member_state`
(`member`, `pending` = invited but not accepted, `parent` = a subgroup's
parent it has not joined), `readonly` / `b3_enabled` (true only when
the nine b3 tools are actually registered — the secret set AND not
read-only), the instance's
Loomio version against the tested one, and `notes[]` that explain
anything unusual in fixed wording (a rejected key and how to fix it, a
valid key with no groups, pending invitations). Call it first in a
session, or after a 403 or an unexpectedly empty list.

## Which groups?

> What Loomio groups do you have access to?

`list_groups({})` — ONE call on Loomio's `GET /b2/groups` for up to 500
member groups (Loomio ≥ 3.11.1 pages the index; one more call per
further 500). Rows are the
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

The best read for a summary is Loomio's own Markdown rendering — the
smallest reply that covers the whole thread, laid out by Loomio:
`get_thread_markdown({discussion_id: "abcDEF12"})` or, when a previous
result already gave the thread's `topic_id`,
`get_thread_markdown({topic_id: 4242})` — the same cost either way: one
read of the thread for the vote-visibility check (which also fills
`type`, `id`, `key`, `title` and `url`), one read of its items per 500
when the thread has any reply — the same items `list_thread_items`
would read — and one for the Markdown: 3 calls for most threads, 2 for
a bare opening post. Upstream it is therefore not the cheapest read:
`list_thread_items({topic_id: 4242})` is (1 call per 500 items), at
the price of a larger, structured reply. `get_thread_markdown` returns
the front matter, the body and the activity as a reply tree —
comments, polls with their votes and results tables, outcomes;
`max_chars` (default 60000) caps from the end and `truncated` says
whether the newest items were cut.

Loomio ≥ 3.10 prints an open poll's votes and results into this
document even when the poll hides results until the reader votes, so
the connector **refuses** a thread holding an open `until_vote` poll
its user has not voted in (the error names the poll). Read that thread
with `list_thread_items` instead — it applies the rule — or wait for
the poll to close. The check reads the thread's items (1 call per 500)
unless the thread holds only its opening post; on Loomio 3.8 / 3.9,
whose export still applies the rule, it is skipped. The exact rule is
in the [get_thread_markdown reference](#get_thread_markdown).

> Show me the discussion record and every comment with ids.

`get_discussion({id_or_key: "abcDEF12", include_items: true})` — the
record with its counters and `url`, plus `thread_items` (the
`list_thread_items` result: items in thread order with the reply tree,
comments, polls, stances, outcomes, users; `items_limit` /
`items_body_max_chars` tune it). Every items reply is budgeted
(`max_total_chars`, default 120000 characters): when
`thread_items.truncated_by_budget` is true, continue with
`list_thread_items({topic_id: 4242, offset: <next_offset>})` — the
connector asks Loomio for exactly that window (1 call per 500 items;
Loomio ≥ 3.11.1 pages this route, older Loomio returns the whole thread
and the connector slices it); `kinds: ["new_comment"]` keeps only
comments, which costs a read of the thread from its start.

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
- a bare `{"error":403}` — a subscription / plan limit: the member or
  thread cap, or (on the b3 membership tools) the target group's
  subscription is inactive or expired. Not the key, not a role.
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

With `LOOMIO_B3_API_KEY` set (and the server not read-only) nine more
tools appear. Four manage accounts: `deactivate_user({id})` /
`reactivate_user({id})`, and the reads `get_user({id})` or
`get_user({identity_type: "saml", uid: "…"})` and
`list_users({is_admin: true})`. Five more, on Loomio 3.13 and later,
manage any group's members without the connector's user belonging to
it:

> Make alice@example.com a coordinator of the Finance subgroup.

1. `list_instance_groups({})` — every group on the instance, ordered by
   id, 50 per page (`offset: next_offset` until it is null) — to find
   the group's id.
2. `list_instance_memberships({group_id: 12})` — that group's direct
   members and pending invitations with their emails; the row's `id` is
   the **membership** id.
3. `update_membership_roles({id: <membership id>, admin: true})`, or
   `revoke_membership({id: <membership id>})` to remove the person (from
   the subgroups and threads too). If the person is not in the group
   yet, `add_group_members({group_id: 12, emails: ["alice@example.com"]})`
   invites them first — confirm the list with a human: every added
   person gets Loomio's invitation email.

No tool creates a bare account: `POST /b3/users` is deliberately not
exposed (it can create instance administrators). Accounts for unknown
addresses are created as a side effect of inviting them — as group
members by `add_group_members` (any group, b3) and `manage_memberships`
(a group the connector's user administers), and as thread guests, in
no group, by `recipient_emails` on `create_discussion`,
`update_discussion` and `create_poll` — invitation email included each
time. So "create an account for bob@example.org" means choosing, with
the human, the group or thread to invite them to.

The reads return **email addresses** for any account and any roster on
the instance, which is why all nine exist only on deployments where one
organisation owns the whole Loomio instance. A `uid` containing a dot
cannot be resolved by `get_user` — still so on Loomio 3.13.1 — use the
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
(~9 000 tokens, `node scripts/catalog-size.mjs` after `npm run build`;
about 17 KB for the 14 read-only tools, 44 KB for the 33 with the b3
secret), paid before the first question. Each description says what a tool
returns and costs, which sibling to prefer, and the one caveat that
changes behaviour. Everything else — field-by-field outputs, permission
rules, Loomio's counting rules, the exact 403 / 404 texts — lives here,
one subsection per tool. Ids and names are illustrative.

### Shared conventions

**Cost.** "1 call" is one upstream request to Loomio. Addressing a thread
by `discussion_id` / `poll_id` instead of `topic_id`, or a comment's
discussion by its short key, adds one GET to resolve the record (for a
poll, with its thread's topic row, so the header names the thread);
every row a list returns already carries the `topic_id` the
thread tools take, so pass it on and skip that call
(`get_thread_markdown` is the exception: it reads the thread once on
every reference, so the three cost the same).

**Paged collections.** Since Loomio 3.11.1 two routes the connector
reads are paged by Loomio: the groups index (ordered by id) and a
thread's items (ordered by `sequence_id`) — 50 rows per request unless
asked otherwise, at most 500, with `meta.total` the whole count on
every page. The connector always asks for up to 500 and follows only
the pages a call needs: `list_groups` and `check_connection` read until
`meta.total` (at most 20 pages), `list_thread_items` reads the caller's
window (at most 2 pages), and a whole-thread read — `kinds`, or
`get_thread_markdown`'s check — at most 10 pages (5 000 items). A walk
its cap stops is flagged (`partial`, `groups_partial`,
`scan_truncated`) or, for the Markdown check, refused; it is never
returned as if complete. Loomio before 3.11.1 ignores `limit` /
`offset` and answers with the whole collection: the connector
recognises that on the first reply and makes no further request.

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
voted what: Loomio's b2 API serializes no stances for them at all.
`get_thread_markdown` is the one read where Loomio itself stopped
applying the `until_vote` rule (3.10+); the connector refuses that case
instead (see its section).

**403 / 404.** The connector classifies Loomio's 403 bodies (see *The
connector says "Loomio returned 403"* above). Per tool the message
Loomio sends is listed below; `"Not authorized to <action> <Model>."`
always means the key is fine and the user lacks that permission.

### check_connection

- **Inputs:** none.
- **Cost:** one forced key-health probe — the authenticated
  `GET /b2/groups` plus the public version lookup the HTTP `/health`
  route also uses; the probe's groups body is reused. On Loomio ≥
  3.11.1 that body is the index's first page (50 groups), so a user in
  more than 50 groups costs one more call per further 500
  (`offset=50&limit=500`, …; at most 20). Older Loomio returns every
  group in the probe's reply: no extra call. A fresh read from offset 0
  is made only if the probe's body failed to parse.
- **Returns:** `connector_version`, `tested_loomio_version`,
  `loomio_version` (null when unavailable), `key_status` — `valid` |
  `rejected` (Loomio no longer accepts the key: rotated with the user's
  password, or wrong) | `unreachable` (network / timeout / 5xx / a
  CDN-WAF 403 that never reached Loomio — says nothing about the key) —,
  `checked_at`, `readonly`, `b3_enabled` (true iff the nine b3 tools are
  registered: secret set AND not read-only; a secret on a read-only
  deployment registers nothing and a note says so), `user` {id, name,
  username} (the account the key belongs to, resolved from its own
  membership rows; null when it is in no group), `groups[]` {id, name,
  handle, `member_state`: `member` | `pending` (invited, not yet
  accepted — Loomio already treats it as a member for visibility) |
  `parent` (a subgroup's parent the user has not joined, for navigation
  only), admin}, `groups_total`, `groups_partial: true` (only when the
  remaining pages could not be read — the call failed or hit the page
  cap; `groups` then holds the first page, `groups_total` still counts
  them all, and a note says "Only the first N of M member groups are
  listed"), `notes[]` in fixed wording
  (rejected-key remediation, valid key but no groups, pending
  invitations, non-member parents, partial list, version drift,
  readonly / b3 flags).
- **Caveats:** never returns key material or upstream error text. Use it
  before a long task, after a 403 or an unexpected empty list. A
  continuation failure never fails the call: the key verdict is still
  the answer.

### list_groups

- **Inputs:** none. The 0.0.11 id-probe knobs (`start_id` / `end_id` /
  `stop_after_consecutive_misses`) are no longer in the schema; an
  older caller that still sends them is not rejected (unknown keys are
  dropped) and gets the same one-call result.
- **Cost:** 1 per 500 member groups (`GET /b2/groups` =
  `current_user.groups`: every un-revoked membership, pending
  invitations included). Loomio ≥ 3.11.1 pages the index (50 by
  default, at most 500 per request); the connector requests 500 at a
  time until `meta.total`, at most 20 pages (10 000 groups), and
  reports `scope.upstream_calls`. Older Loomio returns everything in
  the first reply: always 1.
- **Returns:** rows with `id`, `key`, `handle`, `name`, `full_name`
  ("Parent - Subgroup"), `group_privacy` (`open` | `closed` |
  `parent_members` | `secret`; `parent_members` — a subgroup visible to
  its parent group's members — exists since Loomio 3.11.0, which
  reported such subgroups as `closed` before),
  `is_visible_to_public`, `discussion_privacy_options`,
  `memberships_count`, `discussions_count`, `polls_count`, `enabled`,
  `parent_id`, `url`, `member: true` and `membership` {accepted, admin,
  delegate, title}. Each subgroup's parent is appended too (Loomio
  side-loads it without a visibility check), flagged `member: false`
  with no `membership` — it may or may not be readable. Rows are deduped
  by id and sorted by `full_name`; `total` is Loomio's `meta.total`
  (member groups only); `scope.member_groups` /
  `scope.non_member_parents` split the count. A parent the user IS a
  member of is a member row (`member: true`) even when Loomio's page
  carried it only under `parent_groups` — on a paged index a member
  parent shows up there on every page holding one of its subgroups.
  `scope.partial: true` (with a note) when the 20-page cap stopped the
  walk: `member_groups` < `total`.
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
  `url`. Loomio 3.11.0 removed `closed_polls_count`, `delegates_count`,
  `discussion_templates_count` and `org_discussions_count` from the
  group record (they still arrive from Loomio ≤ 3.10), and
  `subgroups_count` is counted live on every read since then rather
  than read from a cached column. `group_privacy` may be
  `parent_members` (3.11+; see list_groups).
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
- **Cost:** 1; with `include_items` 2, +1 per further 500 embedded
  items (at most 3, since `items_limit` ≤ 1000). The items are read
  from offset 0 in pages of 500, lazily: a second items page is read
  only when `items_limit` > 500, the thread has more than 500 items and
  the first page was not already cut by the reply budget. On Loomio
  before 3.11.1 the whole thread arrives at once: always 2.
- **Returns:** `discussion` — id, key, title, full `description` +
  `description_format`, group_id, `topic_id`, author_id, created_at,
  updated_at, versions_count, discarded_at, attachments_count — joined
  with the thread counters from Loomio's topic row (items_count,
  replies_count, last_activity_at, locked_at, pinned_at, tags,
  has_tagged_replies, seen_by_count, active_polls_count; and from
  Loomio ≤ 3.10 also members_count and closed_polls_count, which
  3.11.0 removed) and its canonical `url`.
  On Loomio 3.13+ a thread's `tags` is the union over every tagged
  contribution (`has_tagged_replies: true` says some come from replies,
  not from the opening post); `group` (slim, with
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
  **Tags:** a tag name the group does not have yet, sent by a user who
  may not create tags, is dropped SILENTLY on Loomio 3.13+ (the thread is
  created without it) and refused with the generic 403 on Loomio ≤ 3.12;
  check the echo's `tags` when they matter.

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
  reason; plus `weight` on a weighted poll) or null; `url`; `group` and
  `users` slim; `results_visible` / `results_hidden_reason` and, when
  visible, `results[]`, `stance_counts`, `total_score`, `stv_results`.
  Quorum: `quorum_pct`, and `quorum_count` / `quorum_votes_required` /
  `quorum_reached` only when the poll HAS a quorum — Loomio 3.13 sends
  `quorum_reached: false` on polls with none, so the three are dropped
  when `quorum_pct` is null.
- **Loomio 3.10+ result fields:** on a `weighted_voting: true` poll the
  tallies are in vote-weight units — `stance_counts` entries, the
  `results[]` scores and `total_score` may be fractional decimal
  strings — and `result_heading_keys` (kept on weighted polls only) says
  which result columns are weighted. `total_score` is a decimal STRING
  such as `"3.0"` on every poll (the integer 0 when nothing was
  counted); read it as a number, not as text. `results[]` rows also
  carry `unweighted_score` (3.10+) and `test_requirement_key` (3.13+);
  `voter_scores` is `{}` except on meeting polls; the id −1 row lists
  the non-voters (named `poll_receipts_page.not_voted` from 3.13,
  `poll_common_votes_panel.undecided` in 3.10–3.12). `voter_has_access`
  (the web client's vote-button state) is dropped; `voting_system` is
  gone since 3.10.
- **Caveats:** a poll has no `discussion_id`: `topic_id` is its thread,
  and for a poll inside a discussion it is that discussion's topic_id —
  pass it to `list_thread_items` / `get_thread_markdown`. Anonymous
  polls have no stances on the b2 API: the tallies (when visible) are
  all there is. 403 `"Not authorized to show Poll."`; unknown 404.

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
  (use `get_poll`). Same results gate and the same Loomio 3.10+ field
  rules as `get_poll` (weighted tallies, string `total_score`, quorum
  trio only with a quorum); `weighted_voting` appears only when true.
  `users` slim; exact `total`.
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
  default 3 — on Loomio 3.10+ a voter ranks AT LEAST that many, up to
  every option), `maximum_stance_choices` (poll 1 = single choice; raise
  for multi-choice; Loomio 3.10+ ignores it for `score`, `dot_vote`,
  `ranked_choice`, `stv` and `meeting`, where the option count always
  applies), `stv_seats` (must be fewer than the options: Loomio 3.10+
  answers 422 otherwise, so the connector refuses it before sending),
  `meeting_duration` (minutes; no default through the API — the form
  uses 60), `can_respond_maybe`
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
  `tags` on a standalone poll follow the create_discussion rule (dropped
  silently on Loomio 3.13+ when the user may not create them).

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
  `replies_count`, `last_activity_at`, `locked_at`, `pinned_at`, `tags`
  (3.13+: the union over every tagged contribution, with
  `has_tagged_replies`), `active_polls_count`, `closed_polls_count` and
  `members_count` (Loomio ≤ 3.10 only; 3.11 removed them), poll
  schedule for poll threads, `url`; no bodies. `total` is the whole visible set (member
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
  `offset` (positions in the thread — or, with `kinds`, in the filtered
  list);
  `include_reactions` (default false: reactions are dropped upstream);
  `body_max_chars` (default 4000); `strip_html` (default true: comment
  bodies, stance reasons and outcome statements); `max_total_chars`
  (default 120000; `-1` = no budget; `0` is refused).
- **Cost:** by `topic_id`, 1 call per 500 items of the window (at most
  2, since `limit` ≤ 1000); +1 by `discussion_id` / `poll_id`. With
  `kinds`, 1 call per 500 items of the WHOLE thread from its start (at
  most 10). On Loomio before 3.11.1 always exactly 1 (+1 to resolve).
  `scope.upstream_calls` reports the number.
- **Paging (Loomio ≥ 3.11.1).** Loomio pages this route itself —
  ordered by `sequence_id`, 50 per request by default, at most 500,
  `meta.total` = the whole thread on every page. Without `kinds` the
  connector asks for exactly the caller's window (`offset`, `limit`), in
  pages of 500, lazily: a second page is read only when the first was
  used up without a budget cut and the window is not yet full. With
  `kinds` — a filter Loomio does not have — it reads the thread page by
  page from item 0 (at most 10 pages, 5 000 items), filters, then
  applies `offset` / `limit` to the matches, so `matched` and
  `next_offset` count matches; if the 10-page cap stopped the scan,
  `scope.scan_truncated: true` and the note says only the first 5 000
  items were scanned (read later items without `kinds`). Every item of
  a long thread is reachable by following `next_offset`.
- **Older Loomio** returns the whole thread whatever was asked. The
  connector recognises that on the first reply (more items than asked
  for, or the whole `total` at a non-zero offset), slices the window
  itself, makes no further request and reports
  `scope.server_paged: false`. `server_paged` is false ONLY when that
  was detected: an old server whose whole thread fits the first window
  at offset 0 (say 120 items under the default `limit: 200`) cannot be
  told from a bounded page and reports `true` — the items, `total` and
  `next_offset` are correct either way; only the flag cannot say which
  server answered.
- **Returns:** `items[]` in thread order — `sequence_id`, `depth`,
  `parent_id` (the reply tree), `kind`, `actor_id`, `created_at`,
  `itemable_type` / `itemable_id`, and on a `discussion_edited` /
  `poll_edited` item the editor's `change_note` (Loomio 3.11+; capped
  by `body_max_chars`) — plus only the records the returned items
  reference: `comments` (body capped, `body_truncated` /
  `body_chars` when cut), `polls` (identity, type, schedule,
  hide_results, participation counts, `poll_options[]` {id, name,
  priority} — the ids a stance's `option_scores` is keyed by —,
  `weighted_voting`, `stance_counts` only when visible), `stances`
  (`participant_id`; `option_scores`; `reason`; `weight` only on a
  weighted poll — anonymous polls have no stances at all), `outcomes`,
  `users` {id, name, username}; `total` (every item), `matched` (after
  the kinds filter), `returned`; `truncated_by_budget`; `next_offset`;
  `scope` (side-load `profile`, `chars` counted, `strip_html`,
  `own_user_known`, `upstream_calls`, `server_paged`, `scan_truncated`
  when set). The header's `type`, `id`, `key` and `title` name the
  THREAD: by `discussion_id` from the discussion; by `poll_id` from the
  thread's topic row, so a poll inside a discussion yields that
  discussion (a standalone poll, itself); by bare `topic_id` from the
  thread's opening item — so on a later window they may be `null` (they
  were on the page at offset 0; the note says so) and no extra call is
  made for them.
- **Caveats:** `max_total_chars` budgets the
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
- **Cost:** the same on any reference — one guard read of the thread,
  1 per 500 items when the guard scans the thread (any thread holding
  more than its opening item; at most 10), then the document: 2 calls
  for a bare opening post, 3 for most threads. On Loomio 3.8 / 3.9 the
  guard is skipped (see the refusal below): 2 calls, plus 2 when the
  health probe behind that decision is older than a minute and is
  re-run first. `scope.upstream_calls` reports the number;
  `scope.open_polls_checked` how many open polls the guard examined;
  `scope.guard_skipped_pre_3_10: true` marks a skipped guard.
- **Returns:** `heading`, `markdown`, `chars` (the full length),
  `truncated`, the thread's `type` / `id` / `key` / `title` /
  `group_id` / `url` (always filled now: the guard read supplies them),
  `scope`. The document is Loomio's own rendering, in the Loomio ≥ 3.10
  layout: YAML front matter (`key`, `url`, group, created,
  last_activity, `tags` — the union over every tagged contribution —
  and, on 3.13+, `root_tags`, the opening post's own); the title line
  `<Type>: <title> · <author> · <UTC time>` (`heading`); the opening
  body; then the activity as a reply tree of nested blockquotes. Each
  poll is a `##` section (status, options, a results table or a "hidden
  until…" line) with its votes and their replies beneath; every item is
  headed `**Author** · <UTC time> · #<seq>`, where `seq` is
  `list_thread_items`' `sequence_id`; reactions are inline and tagged
  contributions carry `Tags:` lines. Removed items stay as `_Removed_`
  placeholders that keep their replies. Superseded, removed and
  undecided votes are listed; an open poll hiding results until it
  closes shows `voted` without the choice.
- **Refusal (vote visibility).** Since Loomio 3.10 the export decides
  poll visibility by "results available" alone, ignoring
  `hide_results: until_vote`, so it would print an open until_vote
  poll's votes and results table to a reader who has not voted — what
  `get_poll`, `list_polls`, `list_thread_items` and `search_content`
  withhold. The connector therefore checks the thread first and throws
  (no document is fetched) when it holds an OPEN until_vote poll its
  user has not voted in; the error names each such poll (id, key,
  title) and points to `list_thread_items` (same `topic_id`) and
  `get_poll`. The block lifts when the poll closes or the connector's
  user votes. Nothing is redacted — the document is either served whole
  or not at all. What the export prints is decided by the thread's
  ITEMS — every poll whose `poll_created` item sits in the thread — so
  the guard decides from them, in this order:
  - a poll the guard read itself (a standalone poll thread's own, or
    the poll a `poll_id` named) that is OPEN, hides results until the
    user votes, and the user has not voted → refused from the guard
    read alone;
  - a thread holding only its opening item (`items_count` ≤ 1: a
    discussion with no reply, or a standalone poll with no vote or
    comment yet) → served, no scan;
  - **everything else** → the thread's items are read from the start,
    1 call per 500 items, at most 10, and every poll they bring is
    checked; the read stops at the first page showing such a poll
    (refused), but serving needs the whole thread, and a scan the cap
    stops refuses ("could not verify"). If the connector's own user id
    is unknown it assumes "not voted", which refuses rather than leaks.

  Why the items and not Loomio's `active_polls_count`, which would
  spare most threads the scan: the count follows each poll's
  `topic_id`, which an admin can change (`PATCH /b2/polls/{id}`, or a
  stale browser tab after a move) without moving the poll's items, so
  a thread can read 0 while its export still prints an open poll's
  votes; and Loomio's v1 "move comments" can move polls into any
  thread, a poll's own included, where the thread read never shows
  them — the moved items are in the scan.

  **Loomio 3.8 / 3.9.** The leak dates from Loomio 3.10; before it the
  export applied "hide results until vote" per reader itself (only the
  reader's own votes and, once results are visible, everyone's). There
  the guard is skipped and no refusal happens — but only when a health
  probe reported 3.8.x / 3.9.x within the last minute. An older probe
  saying so is re-run first (the shared probe: `GET /b2/groups` and
  `GET /v1/boot/version`, at most once a minute), so an instance
  upgraded since is never exported unguarded; an unknown version or
  3.10+ keeps the guard at no extra cost.
- **Caveats:** the cap cuts from the END, so `truncated: true` means the
  newest items were dropped; for recent activity in a huge thread prefer
  `list_thread_items` with an offset. On Loomio ≥ 3.11.1, which pages
  the items route, a thread longer than 5 000 items cannot be checked
  and is always refused; Loomio 3.10 – 3.11.0 answer the scan with the
  whole thread in one reply, so it is never cut short there. Anonymous
  votes never name the voter.

### search_content

- **Inputs:** `query` (words match as prefixes, `!word` excludes, close
  spellings are tried for short unquoted queries) and / or `author_id`
  (alone: that user's 20 newest visible items, no full-text search);
  `group_id` (not its subgroups; an invisible group yields no results,
  not an error); `types` (subset of `Discussion`, `Comment`, `Poll`,
  `Stance`, `Outcome`; e.g. `['Outcome']` for decisions); `tag` (exact
  name — on Loomio 3.13+ only contributions explicitly tagged with it
  match: the opening post, a comment, a poll or an outcome; votes never
  carry tags. Before 3.13 it matched every item of a thread carrying
  the tag. Same parameter, different answer: the scope note says so
  whenever `tag` is used); `order` — `authored_at_desc` (default), `authored_at_asc`,
  `relevance` (best exact matches first; prefer it when hunting for THE
  thread about something). Author-only mode is always newest first.
- **Cost:** 1 (`GET /b2/search`).
- **Returns:** `results[]` — `type`, `id` (the record's own id),
  `title` (its thread), `snippet` (Markdown with `**match**` emphasis,
  ≤ 400 chars), `group` {id, full_name, handle} (`full_name` is
  Loomio's "Parent - Subgroup" form — join to `list_groups` on `id`, not
  the name), `author` {id, name}, `authored_at`, `discussion_key`,
  `poll_key`, `poll_id`, `sequence_id` (the hit's position in its
  thread, as `list_thread_items` numbers it: 0 on a Discussion hit; the
  item's own sequence on a comment or outcome — also in a standalone
  poll's thread, where the hit has a `poll_key` and no `discussion_key`
  — and on a poll or vote inside a discussion; null on a standalone
  poll's own hit and on a vote in a standalone poll's thread), `url`;
  `returned`, `capped`, `mode`, `scope` (`hidden_stance_hits_dropped`).
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
  accepted), `weight` (Loomio 3.10+: the member's vote weight as a
  decimal string, on the connector user's own row and on rows of groups
  it administers), user_email — only when Loomio sent it}, `users[]`
  {id, name, username — never email}, `total` (Loomio's exact roster
  size), `returned`, `scope`.
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
  before `manage_memberships` with `remove_absent`. Paging caveat:
  Loomio's memberships index has no ORDER BY, so successive
  `offset` pages of a roster larger than one page can repeat or skip
  rows; read a large roster with one big `limit` (up to 200) where you
  can.

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
  dry-run and no undo. Loomio compares the listed addresses with the
  members' STORED addresses case-sensitively, so a member listed as
  `Alice@example.org` whose stored address is `alice@example.org` is
  REMOVED; send addresses exactly as `list_memberships` shows them.
  Always call `list_memberships` first, compute the diff explicitly,
  and confirm with a human. See SECURITY.md.
- **What an invitation does (Loomio 3.13):** invitees get a ballot in
  the group's polls asynchronously (Loomio's `PollGroupMembersAddedWorker`
  covers every unclosed poll of the group — scheduled and draft polls
  too — except specified-voters-only ones), so a vote count read right
  after the call may not include them yet. Re-inviting a previously
  removed member restores their thread access and their open-poll votes
  in that group (not the admin role). A group whose subscription is
  inactive answers HTTP 500 rather than a readable 403.

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
  create Comment."` otherwise. With `parent_type: 'Stance'` that 403
  has a second cause on Loomio 3.13+: replies to a VOTE are refused
  while its poll is open and hides results until closing
  (`hide_results: until_closed`); the connector says so — reply to the
  poll (`parent_type: 'Poll'`) or wait for it to close. A 404 means the
  target discussion, comment, poll, stance or outcome does not exist or
  was soft-deleted (Loomio 3.11+ checks that before permissions);
  nothing was created. The body is flat and carries exactly the five
  schema keys: from Loomio 3.12 any other top-level key would be
  rejected with 400.

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

### b3: deactivate_user, reactivate_user, get_user, list_users, list_instance_groups, list_instance_memberships, add_group_members, update_membership_roles, revoke_membership

All nine authenticate with `LOOMIO_B3_API_KEY` — the Loomio SERVER's
own secret (`B3_API_KEY`, ≥ 17 chars), not a user key — and are
registered only when it is set AND the server is not read-only. They
are meant for single-tenant deployments: one organisation owns the
whole Loomio instance. Since Loomio 3.13.0 the secret is checked by
`Api::B3::BaseController` for every b3 route (same rule as before);
a wrong secret is the generic 403, which the connector names as a b3
secret mismatch.

- **`deactivate_user({id})`** — 1 call (`POST /b3/users/{id}/deactivate`,
  the member route; the `?id=` collection route is deprecated).
  Asynchronous on Loomio's side: it enqueues `DeactivateUserWorker` and
  answers `{success: true, user}` at once, so the echoed user can still
  show `active: true` / `deactivated_at: null` — re-read with `get_user`
  to confirm. The worker then stamps `deactivated_at`, revokes the
  user's memberships, mobile devices and pending membership requests,
  and the user's undecided ballots in open polls; votes already CAST in
  open polls are kept (Loomio 3.11+). Loomio records the user as its
  own deactivator, so its history reads as a self-deactivation — only
  the connector's `tool.call` log names the session. Reversible with
  `reactivate_user` while the record persists. 404 if the user is not
  currently active. `destructiveHint: true`.
- **`reactivate_user({id})`** — 1 call, synchronous: clears
  `deactivated_at` AND restores exactly the memberships the deactivation
  revoked (those whose `revoked_at` matches its timestamp) and, on
  Loomio 3.10+, the open-poll ballots revoked at that same moment;
  memberships revoked separately are not touched. Polls opened while
  the user was away give them a ballot shortly after (Loomio enqueues
  that per restored group). Returns `user` already `active: true`. 404
  if the user is not currently deactivated.
- **`get_user({id})` or `get_user({identity_type, uid})`** — 1 call
  (`GET /b3/users/{id}` or `/b3/users/identity/{type}/{uid}`, e.g. the
  SAML / OAuth subject). Returns `user` {id, name, username, EMAIL,
  is_admin, active, deactivated_at, identities[{identity_type, uid,
  email, name}]} for ANY account on the instance, member of the
  connector's groups or not, plus `resolved_by`. A `uid` containing a
  dot (most emails) cannot be resolved — Rails reads the suffix as a
  format; still so on Loomio 3.13.1 — so use the numeric id for those.
  404 when nothing matches.
- **`list_users({is_admin?})`** — 1 call (`GET /b3/users`, unpaginated,
  ordered by id): EVERY account, active and deactivated, in every group
  or none; `is_admin: true` narrows to instance administrators, `false`
  to non-admins. Rows as `get_user`. On a large instance the response is
  big (thousands of rows): prefer `get_user` when you know who you want
  and, for "who is in group X", `list_instance_memberships` (any group,
  Loomio 3.13+) — or `list_memberships`, which needs no b3 secret but
  sees only the connector user's own groups (an EMPTY list elsewhere)
  and is the fallback on older Loomio.
  Use it for "who are the instance admins", "find the account for this
  email", or an audit of deactivated accounts.

The next five need **Loomio 3.13.0 or later** (an older instance
answers 404, which the connector says) and act on ANY group without the
connector's user being a member or admin. Loomio records no actor for
any of them — no inviter, no revoker, no notification actor — so the
connector's `tool.call` log is the only trail. They were verified
against Loomio's source, integration tests and server-API
documentation; no live b3 capture exists. Both lists take `limit`
(1–50, Loomio's b3 maximum; default 50, always sent) and `offset`, and
return `total` (Loomio's `meta.total`), `returned` and `next_offset`
(`offset + returned` while that is below `total`, else null).

- **`list_instance_groups({limit?, offset?})`** — 1 call per page
  (`GET /b3/groups`). Every non-deleted group on the instance, ordered
  by id — secret groups, subgroups and groups with expired
  subscriptions included, whether or not the connector's user belongs
  to them — as `{id, key, name, handle, parent_id, group_privacy}`.
  Use it to find a group id for the membership tools; for the
  connector user's own groups use `list_groups`.
- **`list_instance_memberships({group_id, limit?, offset?})`** — 1 call
  per page (`GET /b3/memberships`). One group's ACTIVE memberships —
  pending invitations included (`pending: true`), revoked ones excluded
  — DIRECT members only (each subgroup has its own roster), ordered by
  id: `{id, group_id, user_id, user_email, user_name, admin, delegate,
  accepted_at, pending}`. Every row carries the member's EMAIL. `id` is
  the MEMBERSHIP id the next two tools take — not a user id. 404 =
  unknown or deleted group.
- **`add_group_members({group_id, emails})`** — 1 call
  (`POST /b3/memberships` with exactly `{group_id, emails}`), 1–50
  addresses (the connector's cap: b3 skips Loomio's per-user invitation
  throttle, so one call's volume stays reviewable). All-or-nothing, in one transaction. Loomio trims,
  lowercases and dedupes the list; an unknown address becomes a new,
  UNVERIFIED account; every added person gets Loomio's invitation
  EMAIL (subject only to its delivery-time spam and suppression
  filters) and stays pending until they accept — except verified
  members of another group of the same organisation, who are accepted
  at once. A previously revoked member is restored (see
  `revoke_membership`); open-poll ballots follow asynchronously.
  Returns `added_emails` (Loomio's list), `unchanged_emails` (the
  normalised input minus `added_emails`: already members),
  `removed_emails` (always `[]`, passed through as received) and a
  note. Additive only: `remove_absent` is never sent and the schema
  rejects it. Loomio compares the members' STORED addresses
  case-sensitively, so a member stored as `Alice@example.org` is
  re-invited (and listed in `added_emails`) when you send
  `alice@example.org` — which is also why the tool is not marked
  idempotent. Errors, all meaning nothing was changed: 400 = an address
  failed Loomio's email check or is over 200 characters; 404 = unknown
  or deleted group (or Loomio < 3.13); 422 = a listed address belongs to
  a DEACTIVATED account — `reactivate_user` first (Loomio never
  reactivates implicitly) — or Loomio refused to create an account for
  a NEW address (`email: no spam`: it matches the instance's
  `SPAM_REGEX`; drop it and retry — b2 drops such an address silently,
  b3 fails the whole call); the error says which; 403 `{error: 403}` =
  the group's subscription is inactive or expired, or the addition
  would pass its member cap. Confirm the address list with the human first.
- **`update_membership_roles({id, admin?, delegate?})`** — 1 call
  (`PATCH /b3/memberships/{id}` with `{membership: {admin?,
  delegate?}}`, only the roles given; at least one is required).
  Returns the updated `membership` row. A role that turns ON notifies
  the member once; repeating the same values changes and notifies
  nothing (idempotent). Nothing on Loomio's side stops demoting a
  group's LAST admin. 404 = unknown or REVOKED membership (re-add the
  person with `add_group_members`); 400 = an invalid role value; 403 =
  inactive subscription.
- **`revoke_membership({id})`** — 1 call (`DELETE /b3/memberships/{id}`).
  Removes the person from the group AND from all of its subgroups,
  revokes their access to those groups' threads, and revokes their
  votes in OPEN polls — cast votes included (only account deactivation
  keeps cast votes). No notification is sent and no revoker is
  recorded. Repeating the call on a revoked membership succeeds
  (idempotent); 404 = unknown membership or a deleted group. **Undo is
  partial:** `add_group_members` with the person's address restores the
  membership in THIS group only, with its thread access and open-poll
  votes there — not the subgroup memberships (separate rows, never
  re-invited), and not the admin role (Loomio resets `admin` on a
  re-invite). The old `delegate` flag survives, and the membership may
  come back PENDING with a fresh invitation email (unless the person is
  a verified member of another group of the organisation). Confirm with
  the human first (`destructiveHint: true`).
