# Design

Short notes on the load-bearing choices. Loomio facts are stated
against Loomio 3.8.1 (`TESTED_LOOMIO_VERSION` in `src/version.ts`);
NOTES-ON-LOOMIO-API.md has the line-by-line evidence.

## Surface area

All non-admin tools target the **b2** API (`/api/b2/...`), with auth
via `Authorization: Bearer <api_key>`. This is the namespace where
Loomio's controllers live in the open-source repo (the `b1` namespace
was removed in Loomio 3.1.0) and the one Loomio's OpenAPI document
describes. The canonical b2 docs are at https://www.loomio.com/help/api2.
As of 3.8.1 the connector wraps every b2 resource except `/b2/chatbots`
(group-admin webhook configuration whose serializer returns the webhook
URL — nothing an AI caller needs, and a leak surface), `GET
/b2/threads/{id}` alone (its row is what `list_threads` returns and the
items / markdown tools fill the header themselves) and the participation
report's `base` / `countries` sections.

The **b3** namespace uses a separate auth secret — a bearer token
validated against `ENV['B3_API_KEY']` on the Loomio server, >16 chars.
This is a server-instance admin secret, not a per-user key. The
connector wraps four of its routes: the member routes
`POST /b3/users/{id}/deactivate` and `…/reactivate` (Loomio's OpenAPI
marks the older `?id=` collection routes `deprecated: true`), and the
reads `GET /b3/users/{id}` / `GET /b3/users/identity/{type}/{uid}`
(`get_user`) and `GET /b3/users[?is_admin=]` (`list_users`). The reads
return every account's email, so they are gated exactly like the writes
— registered only when `LOOMIO_B3_API_KEY` is set AND the server is not
read-only — and documented as single-tenant only. Update / destroy /
redact are deliberately not wrapped: irreversible, and Loomio records no
actor identity for b3 calls (SECURITY.md).

The internal `v1` API (~37 controllers — groups, stances/votes,
reactions, the browser's own search, …) is out of scope. That isn't an
oversight; v1 is fundamentally hostile to programmatic third-party
access on the loomio.com SaaS:

- **Auth wall.** Both session creation (`POST /api/v1/sessions`) and
  the magic-link flow (`POST /api/v1/login_tokens`) require a
  Cloudflare Turnstile token in the request. Turnstile tokens are
  obtained from a browser challenge — they can't be generated
  server-side. So there is no headless login path against the SaaS.
- **CSRF on writes.** v1 controllers inherit `ProtectedFromForgery`
  (b2 explicitly skips it). Even with a hand-pasted session cookie,
  POST/PATCH/DELETE need a CSRF token scraped from a prior GET.
- **Cookie lifecycle.** Sessions expire (Loomio's config: ~2 weeks). A
  connector that needs the user to re-paste cookies on a fortnightly
  cadence is a poor experience.
- **The key is not a v1 credential.** v1 resolves `current_user` from
  the session cookie only, so any v1 read the connector made ran
  anonymously and covered only public content, whatever the key's
  memberships.

The connector now makes exactly one v1 request: the unauthenticated
`GET /api/v1/boot/version` (`{ "version": "3.8.1", … }`), which the
key-health probe reads for the instance's Loomio version with no
credential sent. The two v1 reads earlier releases relied on —
`GET /api/v1/events?discussion_id=` (removed by Loomio 3.4.0 when the
Event model became TopicItem; `list_events` and the old
`get_user_activity` read it) and `GET /api/v1/groups/{id}` (the
`create_discussion` privacy resolver) — are gone with the tools that
used them. Their b2 successors run as the key's user, so the port also
widened what is visible to the private threads the user belongs to.

## Write bodies: nested for discussions and polls, flat for comments

Two Rails mechanisms meet in `Api::B2::BaseController#permitted_params`
(Loomio ≥ 3.1.3): it takes the wrapped resource hash
(`{"discussion": {…}}`) when one is present, and Rails'
`wrap_parameters format: [:json]` builds that hash itself from a flat
JSON body — but only from the keys that are COLUMNS of the model. So a
flat JSON discussion or poll body arrives pre-wrapped with `group_id`,
`private`, `options` and `recipient_*` silently dropped: the record is
created in the wrong place with HTTP 200. Confirmed live on 2026-09-20 —
a flat discussion became a group-less private thread, a flat poll a
group-less poll with no options. The connector therefore sends the
resource **nested** (`nestedBody` in `src/loomio/client.ts`), which makes
the first rule take the hash verbatim and the second never run.

Comments are the exception: `CommentsController#create` reads
`params[:discussion_id]` from the TOP level (not a Comment column, so
wrapping leaves it there) and the permitted `comment` hash is the one
Rails builds from `body`, `body_format`, `parent_id`, `parent_type` —
all columns. A comment body is therefore **flat JSON** (`flatBody`),
exactly as Loomio's own controller tests post it; wrapping it hides
`discussion_id` and answers 400, and the ≤ 3.1.2 form-encoded workaround
400s too. Form encoding is gone from the client.

Because a misdirected write is a 200, the create tools verify Loomio's
echo: `create_discussion` throws if the returned `group_id` differs from
the request, `create_poll` if the thread / group differ or the poll came
back with no options although options were sent — each naming the
created id so the caller can find and discard it. A poll attaches to a
thread by `topic_id` (`PermittedParams#poll_attributes` has no
`discussion_id`; it is 400), so `create_poll` resolves a `discussion_id`
with the same one-call `resolveThread` the thread tools use and, when a
`group_id` was given alongside, refuses a mismatch BEFORE writing.
`PollService.invite` reads the `recipient_*` keys from the raw top-level
params on create, so those travel both nested and top-level there, and
nested only on update.

## Native group index

`GET /b2/groups` (Loomio ≥ 3.1.0) is `current_user.groups`: every group
the key's user holds an un-revoked membership in, pending invitations
included, with the user's own membership rows side-loaded (the `admin`
flag lives there) and each subgroup's parent side-loaded without a
visibility check. `list_groups` is that one call, shaped: member rows
with `member: true` and a `membership` summary, parents appended with
`member: false`, deduped, sorted by `full_name`, Loomio's `meta.total` as
`total`. What it is NOT: a list of everything readable. Loomio ≥ 3.8
lets any authenticated user read a publicly visible group's public
threads without membership, and such a group is absent here yet
readable by id (`get_group`, `list_discussions`, `list_polls`) and
present in `list_threads` / `search_content`. The description says so,
because the model has to know that "not in list_groups" is not "cannot
see".

The same endpoint is the key-health probe (200 for any valid key, even
one with zero groups), and since 0.0.12 the probe keeps its parsed body
beside the verdict (`getCachedGroupsIndex`) so `check_connection` can
answer "does the connector work and what can it see" from one forced
probe — and `cachedOwnUserId` can name the API user (its own membership
rows' `user_id`) for the poll-visibility rule below. The body is stored
next to `LoomioHealth`, never on it: `/health` serialises the verdict and
must not grow a list of the user's groups.

The 0.0.11 id probe — one `GET /b2/polls?group_id=N` per candidate id,
50–500 calls, blind to poll-less groups, and (after 3.8.0) listing
public groups the user had never joined — is gone, and so are its three
inputs: an older client's call still parses because unknown keys are
dropped, and it gets the same one-call result.

## Response shaping: join, slim, truncate, link

Loomio's responses are built for its own browser client: side-loaded
roots joined by id, every user with avatar metadata, every discussion
with its full HTML body, every thread's counters on a `topics[]` row.
Handed to a model verbatim that is mostly irrelevant, large (a 50-row
list is tens of kilobytes of markup) and subtly misleading (the
interesting numbers sit in a root the model must join by hand). Every
read therefore goes through `src/loomio/shape.ts`, in one place so the
rules stay identical across tools:

- **join** — `joinTopics` folds `items_count`, `replies_count`,
  `last_activity_at`, `locked_at`, `pinned_at`, `tags`, `members_count`,
  `seen_by_count`, `active_polls_count`, `closed_polls_count` from the
  `topics[]` row onto the discussion or poll (`discussion.topic_id` →
  `topic.id`); `reader_*` state, `ranges` and internals are dropped. A
  record whose topic Loomio withheld comes back WITHOUT the fields, not
  with zeros — a missing join must look missing.
- **slim** — users become `{id, name, username}` (+ `email` only on the
  b3 tools; a roster's member emails travel as `user_email` on the
  membership row, and the API user's own `users[].email` — the one
  Loomio always adds — is dropped); groups keep
  identity, privacy and counters; attachments become a count; link
  previews, `mentioned_usernames`, chart knobs and cover urls go.
- **truncate** — `truncateField` caps a body at `*_max_chars` and marks
  the record `<field>_truncated: true` with `<field>_chars`; `0` omits
  the field (`<field>_omitted`), `-1` keeps it whole. No ellipsis is
  appended (in a Markdown body it would be indistinguishable from
  content) and cuts never split a surrogate pair. Lists cap by default
  (1500 for descriptions, 4000 for thread-item bodies, 60000 for the
  Markdown rendering, a 120000-character reply budget for thread items
  with `next_offset` to continue); `get_*` return full text.
  `truncateBody` first strips the attributes off an HTML body that
  exceeds its cap (`compactHtml`: Loomio stores `target` / `rel` on
  every link and an `id` on every heading; `href` and `alt` survive) so
  the capped characters carry words; bodies that fit and `get_*` are
  byte-for-byte what Loomio stored.
- **link** — `discussionUrl` & co. build Loomio's own URL formats
  (`/d/{key}[/{slug}]`, `/p/{key}`, `?comment_id=` / `?sequence_id=`
  deep links, `/{handle}` for groups) on the API base minus `/api`, so
  an answer can point a human at the record.

Which side-loads arrive at all is decided upstream by the read profiles
in `src/loomio/client.ts` (`EXCLUDE_TYPES` / `readParams`): lists drop
group / parent / membership / reaction / translation but keep `topics`
(the counters), shows keep the group as well, the groups index keeps the
user's own `memberships`, `list_threads` sends compact minus `tag`,
rosters / search / thread items by bare `topic_id` send `compact=1`, and
thread items for a thread whose record is already known also exclude
`discussion`. `tag` is never excluded where topic rows are read: Loomio
gates the rows' `tags` FIELD on `include_type?('tag')`, not only the
side-loaded root. `compact=1` is never sent where `topics` are needed, because
`topic` is in Loomio's compact list. Writes carry no profile: Loomio's
`:raise` mode would answer 400.

## Poll result visibility is applied client-side

Loomio's rule (`app/models/poll.rb`) has two halves: results are
*available* unless `hide_results = until_closed` and the poll is open,
and *visible* only if additionally `hide_results != until_vote`, or the
poll is closed, or the viewer has voted. `PollSerializer` implements the
first half only and leaves `until_vote` to the browser client — which an
API user that never votes would bypass, seeing every voter's choice on a
poll whose author said "vote first". `src/loomio/visibility.ts` applies
the full predicate with "voted" = the API user's own latest stance is
cast (the `my_stance` side-load on a poll show; in a thread's items the
stance whose `participant_id` is the id the health probe learned),
strips `results` / `stance_counts` / `total_score` / `stv_results` and
other voters' `option_scores` / `reason` when it says no, and always
emits `results_visible` + `results_hidden_reason` so a caller can tell
"hidden" from "zero". With no cached identity the thread tools assume
"not voted", which hides more, never less, and `scope.own_user_known`
says so. `get_thread_markdown` needs no gate: `ThreadMarkdownService`
applies `results_visible?(voted:)` itself. Anonymous polls carry
`participant_id: null` on every stance; nothing here can or should
de-anonymise them, and the server instructions tell the model not to
try.

## Thread addressing

Loomio's thread routes take the THREAD id (`topic_id`), not the
discussion's or poll's own id, and resolve it with
`TopicQuery.visible_to(user).find` — so an unknown id and an invisible
thread both answer 404, never 403. Every thread tool accepts exactly one
of `topic_id` (free), `discussion_id` or `poll_id` (one `compact=1` GET
to read the record's `topic_id`, `resolveThread`), and every record the
connector returns carries its `topic_id` so a caller that already holds
one never pays the extra call. `get_discussion` with `include_items`
uses the `topic_id` already on the record — never two fetches for the
same id in one call.

## Participation from Loomio's report, not from scanning

`GET /b2/reports?section=users` (Loomio ≥ 3.7.0) is the participation
page every member sees: per user, threads / comments / polls / outcomes
authored, reactions given, ballots issued vs cast vs missed, for a group
set and a month window, in one call. `get_participation_report` is that
call for a whole group set (ranking, "a card per member");
`get_user_activity` keeps its 0.0.11 input contract and makes one call
per group (so it can say where the activity was) plus one author-mode
search for linkable recent examples — N + 1 calls, ≤ 4 in flight, where
0.0.11 walked every discussion's event stream (~200 calls) and could not
work at all on Loomio ≥ 3.4. The report's properties are relayed rather
than papered over: whole calendar months (`since` / `until` widen
outward and `since_effective` / `until_effective` say what was counted;
no per-user per-month series exists, so there is no `by_month`),
anonymous polls excluded from the vote columns, a vote attributed to the
month its counted stance row was created (ballot issued at poll open or
when the voter was added; a vote Loomio replaced on change counts in the
month of the change), rows for everyone who ever held a membership. Requested groups the user is not a member of are dropped by
Loomio silently and echoed back as the effective set — the connector
names them in `groups_not_visible` and sets `complete: false`.

## Honest failures over plausible zeros

The 0.0.11 hotfix exists because several tools produced results that
were *technically labelled* but read as facts. The rule, applied
throughout:

- A result that counted **nothing** for a reason unrelated to the data
  is an **error**, not a result. `get_user_activity` throws when every
  report call failed; `list_groups` throws the classified key message on
  a 403 (on that path nothing else produces one); `create_discussion` /
  `create_poll` throw on a misdirected echo instead of reporting the
  wrong record as success.
- A result that is **partial** stays a result, with `scope.*` saying
  what is missing: `groups_not_visible` / `groups_failed` / `complete`
  on the report tools, `capped: true` on search (Loomio's 20-result
  cap), `*_truncated` on capped bodies, `matched` / `returned` against
  `total` on thread items, `page_size` against `returned` on a
  client-side-filtered `list_threads`.
- A result whose emptiness is **ambiguous** carries a note saying what
  it can and cannot mean (`list_memberships` → `scope.note`, a 404 from
  the thread routes → "unknown OR invisible", `check_connection` → "valid
  key but no groups").
- Absent poll counts mean **hidden**, never zero (`results_visible` /
  `results_hidden_reason` on every poll).

Tool descriptions state each limitation plainly, and the server-level
`instructions` repeat the routing-level ones, because the model reading
them is the last line of defence against a confident wrong answer.

## 403 classification

Loomio ≥ 3.1.1 answers 403 with a body that says why (before that, a
bare `{"error":403}` for everything — which is what the connector's
former "probe fence" in `src/loomio/access.ts` worked around, and why it
is gone). `classifyForbidden` in `src/loomio/client.ts` is a pure
function over the body text, unit-tested per shape:

| Body | Meaning | Kind |
|---|---|---|
| non-JSON, or JSON whose `type` URL names cloudflare | a CDN/WAF answered; Loomio never saw the request | `waf` |
| `"You are not authorized to access this page."` | unauthenticated — no active user owns the key (rotated?); on the `b2/discussions` and `b2/polls` `?group_id=` GET lists also "group not visible"; on `/b2/threads…`, `/b2/search`, `/b2/reports` and the `/b2/groups` index (where Loomio filters or 404s instead of refusing) the key and nothing else; on `/b3/` the b3 secret | `unauthenticated` |
| `"Not authorized to <action> <Model>."` | valid key, user lacks permission for that record/action; `show Group` on `GET /b2/groups/:id` = a hidden group (the id is right, the remedy is membership) | `not_authorized` |
| `"User is not an admin"` | `manage_memberships` without the coordinator role on that group | `not_admin` |
| numeric body, or `action: "upgrade"` | subscription / plan cap | `plan_limit` |
| anything else | surfaced verbatim (clipped) | `unknown` |

The classifier is path- and method-aware (only the two visibility-gated
GET lists may hedge towards "group not visible"; a POST to the same paths
is `#create`, whose refusals carry a message; `POST /b2/polls` names the
one bare refusal a valid key can hit there — an anonymous poll with no
future `closing_at`, raised after the poll was saved) and receives the
key-health cache's verdict **only while it is fresh** (younger than the
60 s cache): a fresh `rejected` makes the unauthenticated case
definitive, a fresh `valid` on a gated list points at visibility first,
and a stale verdict is ignored — the startup probe under stdio may be
days old, and a stale `valid` must never make a post-rotation 403 read as
"not a key problem". A 401 is mapped separately and per namespace:
Loomio's b2/b3 API answers its own authentication failures with 403, so
a 401 on a b2/b3 path came from something in front of Loomio; Loomio's
v1 API can itself answer 401 (`require_current_user`) because it is a
session-cookie API. 429 (Rack::Attack, `text/plain`) becomes a clear
retry message with `Retry-After` when present. Every echo of upstream
text is clipped to 200 characters — a CDN's HTML error page must not
land whole in an agent's context.

## Key-health probe

A connector that sees a request every few days can be broken for weeks
before an error-rate alert has enough samples to fire — and a rotated
Loomio key breaks it *silently* (every call is the same 403; the
process is healthy). Loomio rotates a user's key on password change,
rotated every key once in 3.3.1, and publishes no compatibility policy.
So the connector probes actively (`src/loomio/health.ts`):

- `GET /api/b2/groups` with the key (and the groups read profile, so
  the probe does not haul tag / translation side-loads) — 200 for any
  valid key (even with zero groups), 403 with Loomio's unauthenticated
  body for a rejected one; a WAF 403 or any other failure is
  `unreachable`, never a false "rejected". Plus the public
  `GET /api/v1/boot/version` for `loomio_version`, whose failure never
  affects `key_status`.
- Cached 60 s with a shared in-flight promise: `/health`, startup and
  the tools that consult it cost Loomio at most one request pair per
  minute in aggregate. The parsed groups body is kept beside the verdict
  for `check_connection` and for the API user's own id.
- Every `key_status` change emits a **forced** `loomio.auth` event
  (bypassing the verbose gate — the one event an operator must see
  without having anticipated it); a one-time forced
  `loomio.version_drift` fires on a `major.minor` mismatch with
  `TESTED_LOOMIO_VERSION`; `check_connection` repeats the drift warning
  in its `notes`.
- Startup probes but never exits on the verdict: a transient network
  error must not kill the server, and a running process with classified
  403s and a red `/health` is more diagnosable than a crash loop.
- `GET /health` (HTTP) returns `{status, connector_version, key_status,
  loomio_version, checked_at}` — 200 iff valid, else 503, `no-store` —
  so an uptime checker's whole rule is "200 and body contains
  `"key_status":"valid"`". It is unauthenticated (checkers cannot do
  OAuth), per-IP rate-limited, and exposes nothing else.

The cache lives in `src/loomio/health-cache.ts` rather than in
`health.ts` so the HTTP client can *read* the verdict (to make its 403
message definitive) without importing the probe that *uses* the client
— no import cycle.

## API-key injection

Both Loomio public APIs (b2 and b3) take their auth secret in an
`Authorization: Bearer` header — the per-user key for b2, the
server-instance secret for b3. Loomio rejects keys in the query string
(changed July 2026). There is one injection point, `authHeaders()` in
`src/loomio/client.ts`; `buildUrl()` builds a URL that carries no
credential at all, and `loomioGetPublic` sends no credential for the
one public endpoint the probe reads. Every request carries
`User-Agent: loomiomcp/<version>` (`USER_AGENT`), because a CDN/WAF in
front of an instance may block default library user-agents and because
operators should be able to find the connector in Loomio's logs. This
means:

- Keys never leak into structured logs (no headers are logged, and
  `src/log.ts`'s `redactPath` drops query strings — search text, group
  id lists — and collapses ids, keys, handles and identity uids
  besides).
- A base-URL override is validated to be `https://` (or `http://` on
  loopback) — sending the bearer token to an arbitrary http host would
  expose it to anyone on the path.

## Read-only mode

`LOOMIO_MCP_READONLY=1` does two things:

1. Skips registration of every write tool in `src/server.ts` —
   `create_*`, `update_*`, `delete_*`, `manage_memberships` — and of
   every b3 tool, the two b3 reads included (they return emails, so
   they share the writes' gate).
2. Causes `loomioPost` / `loomioPatch` / `loomioDelete` / `loomioPostB3`
   in `src/loomio/client.ts` to throw before issuing the HTTP request;
   `create_poll` checks it before its resolution GET as well, so a
   read-only server spends no call on a poll it will never create.

The first removes them from the catalog (the MCP client can't see
them); the second is the defence in depth. Read-only mode advertises 14
tools; full mode 24; with the b3 secret 28.

## `manage_memberships` safety

`POST /b2/memberships` with `remove_absent` is irreversible, and wider
than it looks: it revokes pending invitees too, cascades to subgroups,
and removes the connector's own user if its email is absent. The tool
description, schema field description, and `destructiveHint: true`
annotation in `src/server/register-tool.ts` all flag it; the default of
`remove_absent: false` keeps the additive case ergonomic. On the wire
the flag is the integer `1` or absent — Loomio reads
`params[:remove_absent].to_i == 1`, and a JSON boolean makes it 500
*after* the invitations went out. `deactivate_user` also carries the
destructive hint, and so do the three `delete_*` tools — Loomio's soft
discard is restorable by an admin in its UI, but not by this connector
— and the three `update_*` tools, because the MCP spec defines
`destructiveHint: false` as "performs only additive updates" and a
PATCH that replaces a body, shortens a `closing_at` or tightens
`hide_results` is not additive (they stay `idempotentHint: true`). The
descriptions say to confirm with the human first. See SECURITY.md.

## Tool annotations and server instructions

`inferAnnotations` in `src/server/register-tool.ts` returns the full
four-flag MCP `ToolAnnotations` set for every tool —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
Per MCP spec, `destructiveHint` defaults to `true` when unset, and
`readOnlyHint` defaults to `false`. A tool that only advertises
`{readOnlyHint: true}` is read by spec-compliant clients as
"read-only, but may also be destructive" — contradictory — and
conservative clients (Claude.ai's auto-approval flow included) fall
back to per-call prompting. Emitting all four flags explicitly removes
the ambiguity and lets the connector's reads auto-approve in Claude.ai.
Reads are recognised by prefix (`get_`, `list_`, `search_`, `check_`
for `check_connection`, …); `update_*` and `delete_*` are idempotent
(the same PATCH twice leaves the same record; discarding a discarded
record changes nothing); `create_*`, `manage_memberships` and
`deactivate_user` are not.

The server also ships a ten-line routing guide as MCP `instructions`
(`SERVER_INSTRUCTIONS` in `src/server.ts`), delivered in the
`initialize` result before the client has read a single description:
which tool answers which KIND of question (check_connection first,
list_threads for "what's new", get_thread_markdown for summaries,
search_content for keywords, get_participation_report for rankings,
get_user_activity per user), and the two things a model must never do
(infer anonymous voters; read absent poll counts as zero). Registration
order — discovery, reading, analysis, writes, admin — is the order
clients list the tools in, so the first tool a model sees is the one
that tells it what the rest can do.

## What we deliberately don't have

- **No data cache layer.** The capsulemcp sibling caches reference-data
  endpoints because LLM chains re-query them. Loomio's surface has no
  equivalent — `list_memberships` IS the authoritative read for any
  membership write, so caching it would mask the very thing the caller
  is checking. The only cache in the codebase is the 60 s key-health
  verdict (with the groups body it came with), which exists to keep
  `/health` from becoming a way to make the connector hammer Loomio.
- **No retry on 429.** Loomio's throttle is per client IP over five
  minutes; a retry loop inside a tool call would only deepen the hole.
  The one remaining fan-out (`get_user_activity`, one report per group,
  four in flight, at most 50 groups) is bounded by its schema; the
  connector maps 429 to a clear message naming it.
- **No client-side search or pagination emulation over Loomio's caps.**
  Search stops at Loomio's 20 results and says `capped: true`; the
  thread items route is fetched whole because Loomio offers no paging
  there. Pretending otherwise would cost calls or hide the limit.
- **No async task store.** Loomio writes are single-request and fast;
  the sibling's task-polling surface adds complexity we don't need.
- **No batch fan-out helper.** A future `batch_manage_memberships`
  across groups would re-introduce this — at that point, the
  capsulemcp shape (concurrency-capped `Promise.allSettled` with
  per-item idempotency and a `batch.complete` event) is the reference;
  `mapWithConcurrency` in `src/tools/reports.ts` is its minimal
  ancestor. Until then, keeping the codebase smaller is the win.
