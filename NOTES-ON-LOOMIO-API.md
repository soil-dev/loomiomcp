# Notes on the Loomio public APIs

Empirical / source-verified behaviour that informs the tool schemas.
Update as we learn more.

Unless a section says otherwise, "current" means **Loomio 3.8.1** (tag
`v3.8.1`, 2026-09-18) — the release this connector is verified against
(`TESTED_LOOMIO_VERSION` in `src/version.ts`). Facts are taken from
Loomio's source at that tag: `config/routes.rb`,
`app/controllers/api/b2/*.rb` (`base_controller.rb`,
`response_options.rb`, `threads_controller.rb`, `search_controller.rb`,
`reports_controller.rb`, `groups_controller.rb`, the discussions / polls
/ comments / memberships controllers), `app/controllers/permitted_params.rb`,
`app/controllers/api/b3/users_controller.rb`,
`app/controllers/api/v1/snorlax_base.rb`, `app/serializers/*.rb`,
`app/queries/topic_query.rb`, `app/services/participation_report_service.rb`,
`app/services/thread_markdown_service.rb`, `app/services/poll_service.rb`,
`app/models/ability/*.rb`, `app/models/poll.rb`, `config/poll_types.yml`,
`test/controllers/api/b2/*_test.rb`, and the OpenAPI document at
`docs/user_manual/integrations/api/openapi.yaml`. Where code and docs
disagree, code and tests win. Response **shapes** were additionally
checked against sanitised live captures of every read endpoint from a
3.8.1 instance (2026-09-20) and the write path against a sandbox group
of the same instance (see "Verified live"). Sections marked
**historical** describe older Loomio behaviour and are kept so the
connector's own history stays legible; they are not current guidance.

## Why b2 is the canonical surface

Loomio's `/api/...` namespaces, as of 3.8.1:

- **`b2`** — the *User API*: documented at
  https://www.loomio.com/help/api2 and in Loomio's own OpenAPI document.
  Controllers in `app/controllers/api/b2/` are the implementation;
  authentication is the per-user API key as a bearer token, and every
  request runs with that user's permissions. **All non-admin tools in
  this connector hit `/b2/...`.** (The older `b1` namespace was removed
  in Loomio 3.1.0.)
- **`b3`** — the *Server API*: a different secret (bearer token
  validated with `secure_compare` against `ENV['B3_API_KEY']` on the
  Loomio server, >16 chars). It covers user index / show / update /
  destroy / redact, deactivate / reactivate, and lookup by external
  identity. The connector wraps `deactivate`, `reactivate`, `show` (by
  id or identity) and `index`, behind opt-in `LOOMIO_B3_API_KEY`; the
  rest is deliberately not wrapped (below).
- **`v1`** — Loomio's internal browser API (~37 controllers). It
  authenticates by session cookie (plus Cloudflare Turnstile on login)
  and does **not** read the API key; see DESIGN.md. The connector makes
  exactly one v1 request: the public `GET /api/v1/boot/version`
  (`{ "version": "3.8.1", … }`), read by the key-health probe with no
  credential. The `GET /api/v1/events` reader (`list_events`,
  `get_user_activity` ≤ 0.0.11) and the `GET /api/v1/groups/{id}`
  privacy lookup (`create_discussion` ≤ 0.0.11) are gone.

## Auth

API key passed in an HTTP bearer header:

```text
Authorization: Bearer API_KEY
```

`Api::B2::AuthenticatesApiKey#current_user` is
`User.active.find_by(api_key: bearer_token.presence || request.request_parameters[:api_key])`
— so the key is read from the `Authorization` header, or (undocumented,
POST bodies only) from a body parameter; **never** from the query
string. The connector uses the header for reads and writes alike.

**Changed 2026-07-25 (Loomio 3.1.3).** Previously the key travelled as
`?api_key=…` in the query string. A request carrying it that way is now
treated as unauthenticated and answers
`403 {"error":"You are not authorized to access this page."}` — the same
body as a wrong or rotated key. `tests/loomio-auth.test.ts` pins the
bearer scheme.

**The key rotates.** Loomio regenerates a user's `api_key`:

- whenever that user's password changes
  (`UserService.rotate_credentials_after_password_change`, Loomio ≥ 3.1.0
  — it also rotates `email_api_key`, `secret_token`, `unsubscribe_token`,
  destroys unused login tokens and signs out other sessions);
- once for every user, by migration `RotateExposedUserApiKeys` in Loomio
  3.3.1 (2026-08-24), because group exports had contained keys;
- on account redaction (`RedactUserWorker`).

A deactivated user's key stops authenticating (`User.active`). The
current key is shown on the user's API access page,
`/profile/api_access`; no API returns another user's key (the b3 user
payload does not include it). The connector's key-health probe
(`src/loomio/health.ts`) exists because of this — see DEPLOY.md.

Consequences:

- No credential ever appears in a URL, so nothing to leak via access
  logs. `src/log.ts` still drops query strings as defence in depth, and
  no headers are logged.
- Override base URLs are gated to https / loopback http in
  `src/loomio/client.ts`.
- Every request carries `User-Agent: loomiomcp/<version>`. Not for
  Loomio's sake — for the CDN/WAF that may sit in front of it (Cloudflare
  blocks default library user-agents with a 403 that never reaches
  Loomio; the connector recognises that body).

## Base URL

`https://www.loomio.com/api` — version (`b2` / `b3` / `v1`) is part of
each path so a single client serves all namespaces. The **web** origin
for the canonical links the tools return is the same value with its
trailing `/api` removed (`siteBaseUrl` in `src/loomio/shape.ts`).

## Endpoints wrapped

### b2 (per-user api_key)

Every read below also carries the connector's read profile — an explicit
`exclude_types=…` or `compact=1` (see "Pagination and response options")
— which the table omits for brevity. Writes carry neither.

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `/b2/groups` | `list_groups`, `check_connection`, the key-health probe | `current_user.groups`; no pagination; `meta.total` |
| GET | `/b2/groups/{id\|key\|handle}` | `get_group` | `can?(:show, group)`; hidden → 403 "Not authorized to show Group.", unknown → 404 |
| GET | `/b2/discussions?group_id=…&status=…&limit=…&offset=…` | `list_discussions` | always sends `status` (default `open`); keeps `topics` |
| GET | `/b2/discussions/{id\|key}` | `get_discussion`; the `discussion_id` resolver of the thread tools and `create_poll` (`compact=1`) | |
| POST | `/b2/discussions` | `create_discussion` | NESTED `{"discussion":{…}}` |
| PATCH | `/b2/discussions/{id\|key}` | `update_discussion` | NESTED |
| DELETE | `/b2/discussions/{id\|key}` | `delete_discussion` | soft discard |
| GET | `/b2/polls?group_id=…&status=…&limit=…&offset=…` | `list_polls` | always sends `status` (default `active`); keeps `topics` |
| GET | `/b2/polls/{id\|key}` | `get_poll`; the `poll_id` resolver of the thread tools (`compact=1`) | |
| POST | `/b2/polls` | `create_poll` | NESTED `{"poll":{…}}` + top-level `recipient_*`; `topic_id`, never `discussion_id` |
| PATCH | `/b2/polls/{id\|key}` | `update_poll` | NESTED; `recipient_*` nested only |
| DELETE | `/b2/polls/{id\|key}` | `delete_poll` | soft discard |
| GET | `/b2/threads?limit=…&offset=…` | `list_threads` | `TopicQuery.visible_to(user)`; no group filter; `meta.total` |
| GET | `/b2/threads/{topic_id}` | `create_poll` only, when `topic_id` AND `group_id` are given (`compact=1`): the row's `group_id` is cross-checked before the POST | one TopicSerializer row (`threads` root) + the fronting `discussions` / `polls` record; 404 for invisible; no tool of its own |
| GET | `/b2/threads/{topic_id}/items` | `list_thread_items`, `get_discussion` with `include_items` | UNPAGINATED; `meta.total`; 404 for invisible; `compact=1`, plus `discussion` when the thread's record is already known, minus `reaction` with `include_reactions` |
| GET | `/b2/threads/{topic_id}/markdown` | `get_thread_markdown` | `{markdown}`; 404 for invisible |
| GET | `/b2/search?query=…\|author_id=…&group_id=…&types=…&tag=…&order=…` | `search_content`; `get_user_activity` (author mode) | cap 20; no `meta.total`; `exclude_types` ignored, `compact=1` honoured |
| GET | `/b2/reports?section=users&group_scope=…&group_ids=…&start_month=…&end_month=…[&member_type=delegate]` | `get_participation_report` (one call), `get_user_activity` (one call per group) | plain hash; effective `group_ids` echoed |
| GET | `/b2/memberships?group_id=…&limit=…&offset=…` | `list_memberships` | `compact=1`; non-member → `200 []` |
| POST | `/b2/memberships` | `manage_memberships` | flat `{group_id, emails, remove_absent: 1?}` |
| POST | `/b2/comments` | `create_comment` | FLAT `{discussion_id \| parent_id + parent_type, body, body_format}` |
| PATCH | `/b2/comments/{id}` | `update_comment` | FLAT `{body, body_format}` |
| DELETE | `/b2/comments/{id}` | `delete_comment` | soft discard |

### v1 (public, no credential)

| Method | Path | Used by |
|---|---|---|
| GET | `/v1/boot/version` | key-health probe — sent **without** the key; `{version}` |

### b3 (server-instance secret; opt-in via LOOMIO_B3_API_KEY)

| Method | Path | Tool |
|---|---|---|
| POST | `/b3/users/{id}/deactivate` | `deactivate_user` |
| POST | `/b3/users/{id}/reactivate` | `reactivate_user` |
| GET | `/b3/users/{id}` | `get_user` (by id) |
| GET | `/b3/users/identity/{identity_type}/{uid}` | `get_user` (by external identity) |
| GET | `/b3/users[?is_admin=true\|false]` | `list_users` |

The collection routes `POST /b3/users/deactivate?id=` /
`…/reactivate?id=` still exist but are `deprecated: true` in Loomio's
OpenAPI document ("legacy query-ID route"); the connector uses the
member routes.

### Available in Loomio 3.8.1, deliberately not wrapped

| Method | Path | Why not |
|---|---|---|
| PATCH / DELETE | `/b3/users/{id}`, `/b3/users/identity/{type}/{uid}` | update (name, username, email, `is_admin`), hard destroy (`DestroyUserWorker`, cascades) and redact are irreversible, and Loomio records no actor identity for b3 calls — nobody could later tell which agent session did it. Deactivate / reactivate cover the operational need and are reversible. |
| POST | `/b3/users/{id}/redact`, `…/identity/{type}/{uid}/redact` | as above |
| * | `/b2/chatbots`, `POST /b2/chatbots/check` | Group-admin configuration of outgoing webhooks / Matrix bots (`current_user.adminable_groups.find(group_id)` → 404 for anyone else). `ChatbotSerializer` returns `server` — the webhook URL, which for most webhook kinds IS the credential — and `channel` to admins. Nothing an AI caller needs, and a leak surface if it were readable. |
| GET | `/b2/reports?section=base\|countries` | Per-interval instance / group-set totals with tag counts, and per-country totals. Not answerable per member the way `section=users` is, and not what a group's participation page shows members. |
| GET | `/b2/threads/{topic_id}` | The single TopicSerializer row. `list_threads` returns the same rows; `list_thread_items` and `get_thread_markdown` fill the thread header (type, id, key, title, group) from their own responses, so a separate call buys nothing. |

## Request body shape: nested for discussions and polls, flat for comments

**Verified live 2026-09-20 on a Loomio 3.8.1 sandbox, and against the
source.** Two Rails mechanisms meet in
`Api::B2::BaseController#permitted_params`:

1. `permitted_params` uses `params[resource_name]` — the WRAPPED hash
   `{"discussion": {…}}` — when it is present, and otherwise falls back
   to the flat top-level hash minus a few reserved keys (`api_key`,
   `format`, `controller`, `action`, `discussion`, `poll`, `id`).
2. Rails' `wrap_parameters format: [:json]` is on
   (`config/initializers/wrap_parameters.rb`). For a JSON body it builds
   the wrapped hash ITSELF from the top-level keys — but only the keys
   that are COLUMNS of the resource's model (`attribute_names`).

So a **flat JSON** discussion or poll body reaches the controller
already wrapped, containing only column names. `group_id`, `private`,
`recipient_*`, a poll's `options` / `poll_option_names` are not columns
on Discussion / Poll and are **silently dropped**. Observed live:

| Body | Result |
|---|---|
| discussion, flat JSON `{group_id, title, description, description_format}` | **200** with `group_id: null` and `topics[0].group_id: null` — an orphan private thread. Silent misdirect. |
| discussion, nested `{"discussion": {group_id, …}}` | 200, `group_id` and `topic_id` set correctly |
| poll, flat JSON `{group_id, title, poll_type, options, closing_at}` | **200** with `group_id: null` and `poll_option_names: []` — an orphan poll with no options |
| poll, nested `{"poll": {group_id, …, options}}` | 200, group and options correct; standalone thread (`topicable_type: "Poll"`) |
| poll, nested with `topic_id` of a discussion | 200, attached to that thread (`topicable_type: "Discussion"`), `group_id` derived from the thread; option names are re-labelled in the instance's locale ("agree" → "Agree") |
| poll, nested with `discussion_id` | **400** (`PermittedParams#poll_attributes` has `topic_id`, not `discussion_id`) |
| comment, form-encoded `body=…&body_format=md` + `?discussion_id=` | **400** |
| comment, nested `{"comment": {discussion_id, …}}` | **400** — wrapping hides `discussion_id` from the controller |
| comment, flat JSON `{discussion_id, body, body_format}` | 200, `parent_type: "Discussion"`, `parent_id` = the discussion, `topic_id` = its thread |
| PATCH nested (discussions, polls), flat (comments) | 200 (`versions_count` increments) |
| DELETE on all three | 200 with `discarded_at` set and title / body nulled — soft discard |

Hence `nestedBody` (discussions, polls) and `flatBody` (comments) in
`src/loomio/client.ts`, and the post-create guards in
`src/tools/discussions.ts` / `polls.ts`: if Loomio's echo disagrees with
the request on the group or thread, or shows no options although options
were sent, the tool throws **naming the created id** rather than report
success. Comments are flat because `CommentsController#create` reads
`params[:discussion_id]` from the TOP level (not a Comment column, so
wrapping leaves it there) and the permitted `comment` hash is the one
rule 2 builds from `body`, `body_format`, `parent_id`, `parent_type` —
all columns; Loomio's own tests ("create accepts a bearer token with
flat parameters", "update accepts a bearer token with flat parameters",
"destroy soft deletes comment") post exactly that, `as: :json`.

`PollService.invite` reads `recipient_user_ids` / `recipient_emails` /
`recipient_audience` / `notify_recipients` / `recipient_message` from the
RAW `params` (top level) on create, while `create_anonymous_poll_voters`
(for `specified_voters_only` anonymous polls) reads them from the
resource hash — so `create_poll` sends them in BOTH places. On update
`PollService.update` reads them from the resource hash only, so
`update_poll` nests them. `DiscussionService.create` / `update` read
them from the permitted hash, so `create_discussion` / `update_discussion`
nest them.

`action_on_unpermitted_parameters = :raise`: any key `PermittedParams`
does not list answers `400 {"error":400}`. That includes `compact` /
`exclude_types` if they ever reached a write's resource hash — the read
profiles are never spread into a write.

**Format fields default to `md`, not to anything of the group's.**
`discussions.description_format`, `polls.details_format` and
`comments.body_format` are all `default: "md", null: false` in
db/schema.rb (3.8.1); no service on the b2 write path assigns them
(`PollService` touches `user.default_format` only for a stance's
`reason_format`), and `Group#description_format` is the group's OWN
description, not a default for its threads. An HTML body sent without
its format is stored as Markdown: the Vue client renders it anyway
(marked passes raw HTML through), but every server-side rendering —
notification emails, chatbot posts, exports, `*_visible_text` — goes
through `MarkdownService.render_html` (Redcarpet, `filter_html: true`)
and strips the tags. The connector's create schemas refuse a body that
starts with a block-level tag unless the format is sent; the update
schemas say an omitted format keeps the stored one (0.0.11's "defaults
to Loomio's group default" described a setting that does not exist).

**`notify_on_open` (polls).** A Poll column, `default: true, null:
false`, in `PermittedParams#poll_attributes`. `PollService.build` sets
`opened_at = Time.now` when `closing_at` is present (and `opening_at`
blank or past); `PollService.create` then runs
`create_anyone_can_vote_stances` (one stance per human group member
unless `specified_voters_only`) and `announce_poll_opened(poll) if
poll.opened_at && poll.notify_on_open` — a `poll_announced`
notification (`NotificationService.create!`) to every latest stance's
participant except the author: in-app for all, email / push per each
member's volume (`NotificationDeliveryRouters::PollEvent`). On update,
`open_poll_if_ready` announces the same way when a `closing_at` first
opens a draft. `test/services/poll_service_test.rb` asserts the
notification with `notify_on_open: true` and its absence with `false`.
So the connector's common `create_poll` (title + options + closing_at)
notifies the whole group unless `notify_on_open: false` is sent — a
different switch from `notify_recipients`, which `PollService.invite`
reads to gate only the `recipient_*`-based announcement. Without
`closing_at` nothing opens: the poll is a draft (`opened_at` null,
`Poll.active` — the list default — omits it, `can :vote_in` requires
`active?`), answered 200; the connector reports `opened: false` with a
warning.

**Poll-setting defaults the API does NOT apply.** `config/poll_types.yml`
carries a `defaults:` block per type, but only
`PollTemplateService.build_templates_from` reads it — for poll
templates, i.e. the web form. `PollService.build` is `Poll.new` +
`assign_attributes_and_files`. The model's readers DO fall back to the
YAML for the ballot bounds (`poll.rb`: `min_score`, `max_score`,
`dots_per_person`, `minimum_stance_choices`, `maximum_stance_choices`
read `self[field] || AppConfig.poll_types.dig(poll_type, 'defaults',
field)`), so those need no client-side default. Three do not:
`notify_on_closing_soon` is a plain enum with column default 0 =
`nobody` (no closing-soon reminder at all; the form pre-selects
`undecided_voters`; anonymous polls are forced to it),
`meeting_duration` is a bare `custom_fields` reader (nil unless sent;
`calendar_invite.rb` interpolates it into the ICS duration), and
`can_respond_maybe` is hard-coded `fetch('can_respond_maybe', false)`.
The field descriptions say so.

**What the update routes drop silently** (`DiscussionService.update`,
`PollService.update`): `group_id` and `tags` are pulled out and
discarded, `poll_type` is excluded — a discussion cannot be moved and a
poll's type cannot change through b2. Neither tool offers those fields.

**What `PATCH /b2/polls/{id}` does with `options`** (3.8.1
`app/models/poll.rb`): `Poll#options=` is an alias of
`poll_option_names=`, which reads the array as the COMPLETE option set —
`existing = poll_options.pluck(:name)`, `find_or_initialize_by(name:)`
for each given name (common keys re-labelled in the instance's locale,
"agree" → "Agree"), then `removed = existing - names` and
`mark_for_destruction` on every existing option not in the list.
`has_many :poll_options, dependent: :destroy, autosave: true` +
`accepts_nested_attributes_for :poll_options, allow_destroy: true`
saves the destruction, and `PollOption has_many :stance_choices,
dependent: :destroy` deletes the votes cast on those options. Nothing
validates against it on an open non-anonymous poll (only detached
anonymous ballots are `restrict_with_error`); Loomio answers 200, and
its model tests pin the semantics ("meeting derives required choice
bounds when dates are removed", "orders by priority when non-meeting
poll"). `update_poll` therefore GETs the poll (`compact=1`) first and
PATCHes `stored names ∪ new names`, so its `options` ADDS; a name that
differs from the stored spelling only in case would be initialised as
a second option, hence the tool asks for `poll_option_names` spelling.
The two calls are not atomic: an option another editor adds between
them is absent from the union and destroyed on the PATCH (200, no
signal — `versions_count` does not move on an option-only change,
`has_paper_trail only:` filters on columns, and `removed_poll_option_ids`
is a serializer method that is not in the attribute list). Loomio's Vue
client (`poll_model.js` `removeOrphanOptions`) submits the complete set
the same way; b2 has no add-option primitive.

**Historical (Loomio ≤ 3.1.2).** The base controller *deleted* the
incoming `:discussion` / `:poll` keys before re-wrapping, so a wrapped
body became `{discussion: {}}` — an empty record with no validation
error — and flat was the only working shape. That is why the connector
was flat-bodied through 0.0.11, and why 0.0.11 misdirected writes on
3.8.1.

## Pagination and response options

b2 list endpoints (`discussions`, `polls`, `memberships`, `threads`)
accept `limit` (default 50) and `offset` (default 0); SnorlaxBase also
accepts `per` / `from` as aliases. We expose `limit` / `offset` only.
`GET /b2/groups` and `GET /b2/threads/{id}/items` read NO paging
parameters (the whole set, every call); `GET /b2/search` reads none and
is capped at 20.

Collection reads that set `collection_count` carry an exact
pre-pagination **`meta.total`**: the groups index, discussions, polls,
memberships, threads and thread items. It is **omitted**, not null,
where no total is defined (`Api::B2::ResponseOptions#response_meta`):
every show, and search. Every collection tool surfaces it as `total`.

All b2 reads accept a space-separated, singular-name **`exclude_types`**
and **`compact=1`**, which is sugar for
`exclude_types += topic group parent membership reaction tag translation`
(`Api::B2::ResponseOptions::COMPACT_EXCLUDE_TYPES`). Excluding a type
removes the side-loaded root AND the association's `_id(s)` keys from the
primary records (`parent_id`, `current_user_membership_id`, `tag_ids`
vanish from a compact group) — AND, because active_model_serializers 0.8
applies `include_<name>?` to attributes as well as associations, any
ATTRIBUTE whose guard is `include_type?`. The one that matters:
`ApplicationSerializer#include_tags?` is `include_type?('tag')`, and
`TopicSerializer` (and `SearchResultSerializer`) declare `tags` as an
attribute, so `exclude_types=… tag …` or `compact=1` removes the `tags`
FIELD from every topic / thread / search row (live 3.8.1: the
unprofiled discussions list had `tags` on its topics; the same request
with `tag` excluded did not). Three consequences drive the profiles in
`src/loomio/client.ts` (`EXCLUDE_TYPES` / `readParams`):

- `topic` is IN the compact list, and the `topics[]` root is where a
  thread's counters live (next section) — so a discussions or polls read
  must never send `compact`. Lists send
  `exclude_types=group parent membership reaction translation` (the
  caller passed the group id) and shows
  `exclude_types=parent membership reaction translation` (keeping the
  group for its name and privacy). Neither excludes `tag`; the `tags`
  root the show then gains (GroupSerializer `has_many :tags`, the
  group's tag definitions) is not relayed, and a list — with `group`
  excluded — has no serializer left with a tags association.
- `membership` is in the list too, and on the groups index the
  `memberships[]` root is the API user's own rows — the only place the
  `admin` / `accepted_at` flags per group live — so the groups index and
  show send `exclude_types=tag translation` (no topic row is involved
  there, so `tag` is safe to drop).
- `GET /b2/threads` sends compact minus `tag`
  (`topic group parent membership reaction translation`) so its rows
  keep `tags`. Rosters, search and `GET /b2/threads/{id}/items` by a
  bare `topic_id` send `compact=1` (nothing they emit carries a `tags`
  field; search's rows lose theirs, and the tool does not pretend
  otherwise); the items route for a thread whose record is already in
  hand sends compact plus `discussion`, which stops
  `TopicItemSerializer#include_itemable?` from serialising the opening
  post — full body — a second time under `discussions`; with
  `include_reactions` it sends the explicit list minus `reaction` and
  still INCLUDING `discussion` (the opening post's reactions arrive only
  through `DiscussionSerializer has_many :reactions`), and still
  excluding `parent`, which would otherwise side-load every item's
  parent again under `parent_topic_items`.
- `users` is never droppable and arrives everywhere; the tools slim it
  client-side.

## Topic side-load (Loomio ≥ 3.1)

Threading state lives on a `Topic` record. `DiscussionSerializer` /
`PollSerializer` carry `topic_id`; `TopicSerializer` (root `topics` on
discussion / poll reads, `threads` on `GET /b2/threads`) carries
`items_count`, `replies_count` (= items_count − 1), `last_activity_at`,
`locked_at`, `pinned_at`, `tags`, `members_count`, `seen_by_count`,
`active_polls_count`, `closed_polls_count`, `anonymous_polls_count`,
`topicable_type` / `topicable_id` (the Discussion or Poll it fronts),
`group_id`, plus the API user's own reading state (`reader_*`), `ranges`
and `max_depth`. `joinTopics` in `src/loomio/shape.ts` folds the first
group onto the record (`TOPIC_JOIN_FIELDS`) and drops the rest. A
record whose topic Loomio withheld comes back without those fields —
never with zeros.

## Status filters

| Endpoint | Values | Loomio's fall-through when absent |
|---|---|---|
| `list_discussions` | `open` (`unlocked`) → `is_unlocked`; `closed` (`locked`) → `is_locked`; `all` → `kept` | **`kept` — every kept thread, locked ones included** (changed from `is_open` in 3.1.0). The connector therefore always sends `status`, default `open`. |
| `list_polls` | `active` (default) → `Poll.active` (kept, opened, not closed); `closed` → `Poll.closed` (closed_at set); `all` → `kept` | `active` (sent explicitly anyway) |

## Poll types and rules

`Poll` validates `poll_type` against the keys of `config/poll_types.yml`:
`proposal`, `poll`, `count`, `score`, `ranked_choice`, `meeting`,
`dot_vote`, `check`, `question`, `stv`. The model validates **none** of
the per-type rules the web client enforces, so the connector does
(`POLL_TYPE_RULES` in `src/tools/_common.ts`, transcribed from the
YAML):

- **There are no default options through the API.** A `proposal` posted
  without `options` is saved with zero options — an unusable poll. The
  agree / abstain / disagree / block defaults come from the web client's
  templates. `options` is therefore required for every type except
  `question` (free-text answers, `has_options: false`); `ranked_choice`
  and `stv` need at least 2. Names in a type's `common_poll_options`
  (proposal: agree, abstain, disagree, block, consent, objection, …;
  check: looks_good, not_sure, concerned; count: accept, decline) get
  Loomio's icon, meaning and prompt and are re-labelled in the
  instance's locale.
- `prevent_anonymous`: `count`, `question` and `meeting` cannot be
  anonymous.
- **Anonymous polls** (`anonymous: true`): `PollService.build` forces
  `voting_system: anonymous_ballot` and `hide_results: until_closed`;
  `PollService.invite` then raises a bare `CanCan::AccessDenied` for an
  anonymous poll that is not active — no future `closing_at` — AFTER
  `create` saved it (the one bare 403 a valid key can hit on a write;
  the classifier names it). The schema requires `closing_at` when
  `anonymous`, and refuses `hide_results` other than `until_closed`.
  Anonymity cannot be switched later; an anonymous poll's configuration
  is frozen once a ballot exists (422).
- `closing_at` is rounded DOWN to the hour and must be in the future;
  without it the poll never opens for voting on its own.
- `hide_results` may be tightened on update but `until_closed` can never
  be relaxed ("cannot reveal results early").

## Poll result visibility

`app/models/poll.rb`:

```text
results_available?       = hide_results != 'until_closed' || closed_at.present?
results_visible?(voted:) = results_available? &&
                           (hide_results != 'until_vote' || closed_at.present? || voted)
```

`PollSerializer#results_visible?` is `poll.results_available?` ALONE, so
`results`, `stance_counts`, `total_score` and `stv_results` are serialised
for every open `until_vote` poll; `StanceSerializer#include_results?`
likewise emits every voter's `option_scores` / `reason` once
`results_available?` holds. The browser client applies the `until_vote`
half; an API user that never votes would bypass it. `src/loomio/visibility.ts`
applies the full predicate with "voted" = the API user's own latest
stance is cast and not revoked (the `stances` root on a poll show holds
ONLY `my_stance` rows; in a thread's items it holds every voter's, so
the user is picked by the id the health probe learned), strips the four
poll fields and the other voters' stance fields when it says no, and
emits `results_visible` / `results_hidden_reason` (`until_closed` |
`until_vote`) either way. `ThreadMarkdownService` applies
`results_visible?(voted:)` itself ("_Hidden until the poll closes._" /
"_Hidden until the viewer votes._"), so `get_thread_markdown` needs no
client-side gate. **Search** does: `Stance.pg_search_insert_statement`
indexes every cast, unredacted stance (reason + voter name) except those
of an OPEN `until_closed` poll (`AND NOT (polls.hide_results = 2 AND
polls.closed_at IS NULL)`; they are indexed once the poll closes via
`ReindexPollWorker`), so open `until_vote` stances are searchable and
Loomio's own web search shows them to any member. `search_content`
applies the same predicate from the response's `polls` root
(`SearchResultSerializer has_one :poll`, so every Stance row's poll is
there) and `my_stance`; in author-only mode it withholds the snippet
(`snippet_hidden_reason`) — the author stays, as in Loomio's thread view
— and in `query` mode it drops the hit altogether, because its presence
would confirm the query term occurs in the hidden reason (see "Search").
Anonymous polls carry `participant_id: null` on every stance and no
`my_stance`; nothing can or should de-anonymise them.

## Groups

`GroupSerializer` (3.8.1) emits a `subscription` attribute — `{plan,
state, active, max_members, max_threads, allow_subgroups, renews_at,
expires_at, members_count}` — whenever `include_subscription?` holds:
`scope[:current_user_id]` set (every b2 read sets it) AND the user is an
instance admin or holds an active membership in
`parent_or_self.id_and_subgroup_ids`. A serializer attribute, so no
`exclude_types` / `compact` drops it; live capture of a member group's
show confirms it, along with `new_host` (a migration hint from `info`)
and `discarded_by`. Non-member public groups come without it. `get_group`
drops all three (`GROUP_SHOW_DROP`); `enabled` (kept) is
`subscription_active?`.

`GET /b2/groups` (`GroupsController#index`) is `current_user.groups`:
`has_many :groups, through: :memberships` over the ACTIVE membership
scope (`revoked_at IS NULL`, kept groups). So the list is exactly the
groups the key's user holds an un-revoked membership in — **including
invitations not yet accepted** (`accepted_at: null`) — and nothing else:
a publicly visible group the user has not joined is NOT listed (although
readable by id), instance `is_admin` widens nothing, there is no
pagination or filter, `meta.total` is the count. `authenticate_api_key!`
is the only guard: a 403 here means the key. Side-loads
(`GroupSerializer`): `parent_groups` (each subgroup's parent, serialised
WITHOUT a visibility check on it), `memberships` (the user's OWN rows via
`current_user_membership` — `admin`, `delegate`, `title`, `accepted_at`),
`users` (the user and its inviters), `tags`. The connector's `list_groups`
appends the parents flagged `member: false`; `check_connection` reads the
user's identity off the membership rows' `user_id`.

`GET /b2/groups/{id|key|handle}` → `load_and_authorize(:group)`:
`ModelLocator` tries the numeric id, then the short key, then the handle;
`can?(:show, group)` (`app/models/ability/group.rb`) admits a kept group
that is visible to the public, OR the user is a member of, OR is shown
to parent-group members and the user is one. Refusal is
`403 {"error":"Not authorized to show Group."}` — the group exists and
is hidden; an unknown identifier is 404. The show side-loads the same
roots as the index (memberships only when the user has a row).

## Threads (`Api::B2::ThreadsController`)

```text
GET /b2/threads                        TopicQuery.visible_to(user), order last_activity_at desc,
                                       offset(params[:offset]) limit(params[:limit] || 50),
                                       collection_count → meta.total. No group / status / since filter;
                                       last_activity_at is nullable and Postgres DESC puts NULLs FIRST,
                                       so a page can open with undated rows. list_threads' `since` is a
                                       client-side cutoff over the page (undated rows dropped + counted,
                                       `exhausted` when the last dated row predates the cutoff).
GET /b2/threads/{topic_id}             one TopicSerializer row (root `threads`)
GET /b2/threads/{topic_id}/items       thread.items.order(:sequence_id) — EVERY item, no paging; meta.total
GET /b2/threads/{topic_id}/markdown    {markdown: ThreadMarkdownService.render(topic:, user:)}
```

- `{topic_id}` is the THREAD id (`discussion.topic_id` / `poll.topic_id`,
  `id` on a `threads[]` row), not the discussion's or poll's own id.
- The thread is resolved with `TopicQuery.visible_to(user).find(id)`, so
  an unknown id and a thread the user may not see both answer **404**
  (Loomio's own test "does not expose an inaccessible thread"). Never
  403 for visibility; the connector's 404 message says both readings.
- `TopicQuery.visible_to` = every PUBLIC topic on the instance ∪ topics
  of the user's member groups ∪ subgroups visible to parent members ∪
  threads the user was invited to as a guest. That is why `list_threads`
  is "everything I can see" and why `total` is instance-wide.
- Items (`TopicItemSerializer`): `id`, `sequence_id` (the opening item is
  0), `position`, `position_key`, `depth`, `child_count`, `kind`,
  `topic_id`, `actor_id` (null → anonymous), `created_at`, `parent_id`,
  `itemable_type` / `itemable_id`, `itemable {type, id}`, `pinned`,
  `pinned_title`. Each item's record is side-loaded into the root for its
  type (`discussions`, `polls`, `comments`, `stances`, `outcomes`) and its
  actor into `users`; polls bring `poll_options`, their current outcome and
  the API user's `my_stance` (into the same `stances` root). `compact=1`
  drops `topics`, `groups`, `parent_topic_items`, `memberships`,
  `reactions`, `tags` and `translations`; adding `discussion` to
  `exclude_types` (b2 merges the caller's list with the compact list)
  drops the `new_discussion` item's itemable — `TopicItemSerializer#
  include_itemable?` is `!(kind == "new_discussion" &&
  exclude_type?('discussion'))` — which the connector does whenever it
  already holds the discussion record. `poll_option` is in no exclusion
  list, so `poll_options` always arrives; a stance's `option_scores` is
  keyed by poll_option id (`Stance#build_option_scores`), which is why
  `list_thread_items` emits each poll's `poll_options[]`. `meta.total`
  counts every row and can exceed the topic's `items_count` (which
  counts non-null sequence ids).
- `kind` is the TopicItem subclass name underscored
  (`app/models/topic_items/*.rb`) or set by the creating service. Written
  by 3.8.1: `new_discussion`, `new_comment`, `poll_created`,
  `stance_created`, `stance_updated` (StanceService, no subclass),
  `outcome_created`, `poll_closed_by_user`, `poll_edited`,
  `poll_reopened`, `discussion_edited`, `discussion_title_edited`,
  `discussion_description_edited`, `discussion_closed`,
  `discussion_reopened`, `discussion_moved`. Rows migrated from the old
  Event model may carry other strings; the connector's `kinds` filter
  passes them under `other`.
- Markdown (`ThreadMarkdownService`): YAML front matter (group, created,
  last_activity, tags), `# Discussion|Poll: <title> · <author> <date>`,
  the body, then `## Comment · <author> <ts>` / `## Reply to <name> · …`,
  polls with `- **Status:**`, `- **Options:**`, a `### Current results`
  table or a hidden-until line, `## Vote:` and `## Outcome` sections,
  reaction lines. Labels are in the API user's locale; discarded items
  and blank comments are omitted; the document is unbounded (the
  connector caps it at `max_chars`, default 60000, from the END).

## Search (`Api::B2::SearchController` < `Api::V1::SearchController`)

The b2 controller adds API-key auth and widens the group scope from the
user's member groups to `GroupQuery.visible_to(user, show_public: true)`
— member groups AND publicly visible groups — after which the correlated
`TopicQuery.visible_to` removes every private topic the user may not
read (test "searches public content without group membership and
excludes private content"). Instance `is_admin` widens nothing.
Visibility is a filter: a private group's id yields `200 []`, never 403.

Parameters: `query` (PgSearch multisearch: prefix matching, `!term`
negation, no phrase quoting; exact matches first, then — for queries
with no `! " ( )` and ≤ 8 terms — trigram "did you mean" alternatives
from the instance's `pg_search_words` table, so typo tolerance is only
as good as that table's last rebuild), `author_id` (alone: the author's
20 newest visible items, no full-text, `order(authored_at: :desc)`;
`highlight` is then a plain html-escaped 240-character excerpt),
`group_id`, `org_id` (a group and its subgroups; not exposed), `type` or
`types` (comma-separated `SEARCHABLE_TYPES`: Discussion, Comment, Poll,
Stance, Outcome; unknown names dropped), `tag`, `order`
(`authored_at_desc` / `authored_at_asc` reorder exact AND fuzzy matches
by date; anything else = relevance). **Hard limits**:
`SearchQuery::RESULT_LIMIT = 20`, no offset, no `meta.total` (test
"omits an undefined total"). The controller overrides `exclude_types`
with its own fixed list, so a caller's `exclude_types` is a no-op; but
`compact=1` still applies through `ResponseOptions` and is sent.

Response: `search_results[]` (`SearchResultSerializer`): `id` is the
pg_search ROW id (unstable across reindex — the connector returns
`searchable_id` as `id`), `searchable_type` / `searchable_id`,
`discussion_key` / `discussion_title`, `poll_key` / `poll_title` /
`poll_id`, `group_id` / `group_key` / `group_handle` / `group_name`
(the controller fills it from `group.full_name` — "Parent - Subgroup"
for a subgroup, so the connector calls it `group.full_name`; join on
`group_id`), `author_id` / `author_name`, `authored_at`, `sequence_id`
(items inside a thread; comments get none), `tags` (declared, but gated
on `include_type?('tag')` and therefore ABSENT under `compact=1`, which
is sent), `highlight` (HTML with `<b>…</b>` around matches: `ts_headline`
with `StartSel = "<b>", StopSel = "</b>"`). Side-loads: `users`
(authors), `polls` + `poll_options` for poll-related hits (every Stance /
Outcome row's poll included: `has_one :poll` is `Poll.find_by(id:
poll_id)`), and `my_stance` under `stances` when the API user voted.
The connector reads the polls root only to gate Stance hits (see
"Poll result visibility") and never relays it — `get_poll` is the place
for gated results. Note that gating the SNIPPET is not enough when a
`query` is present: `SearchController#index` filters by topic
visibility only, `Stance.pg_search_insert_statement` indexes
`stances.reason` + the voter's name for every cast stance except those
of an open `until_closed` poll, and `config/initializers/pg_search.rb`
sets `prefix: true, negation: true` — so a hit's presence confirms that
the term occurs in the withheld reason, prefix by prefix. Loomio's own
web search shows the member the full reason, so the connector widens
nothing, but it drops such hits from `query` searches (kept in
author-only mode, where there is no term to probe) and counts them.

## Participation report (`GET /b2/reports`, Loomio ≥ 3.7.0)

`Api::B2::ReportsController#index` is one line:
`ParticipationReportService.fetch(actor: current_user, params:,
instance_admin_access: false)` — the service behind the participation
page every member sees. What it reads, and what happens when it is
wrong:

| Param | Values | Wrong value |
|---|---|---|
| `section` | `base` (per-interval totals + tag counts), `users` (per-member table), `countries` | falls back to `base` |
| `group_scope` | `custom` (default; reads `group_ids`), `my` (member groups + subgroups it can see), `all` (needs instance admin access, which b2 switches OFF → read as `my`) | read as `custom` |
| `group_ids` | a COMMA-SEPARATED STRING (`"7,12"`; `.split(',')` — an array is silently ignored), INTERSECTED with `actor.group_ids` (un-revoked memberships, pending included). Non-member ids are dropped WITHOUT error; when nothing is left the report runs on group −1 and `users` is empty. The response's `group_ids` echoes what survived — the built-in fence, and the only way to know a group was dropped (test "does not report a group the API user cannot access"). `is_admin` changes nothing. | — |
| `start_month`, `end_month` | `YYYY-MM`; window = [start-01, end-01 + 1 month) — the end month is included whole. Defaults: 12 months ago / the current month. | `Date.parse(value + "-01")` raises → **HTTP 500** |
| `interval` | `day` / `week` / `month` (default) / `year` — shapes ONLY the `base` section's series; `users_data` never consults it, so there is **no per-user per-month breakdown** | **500** |
| `member_type` | absent, or `delegate` (only users with an active delegate membership) | **500** |

`section=users` returns a plain hash (no `meta`; `compact` /
`exclude_types` have no effect): `first_year`, `all_groups[{id,name}]`,
`group_ids` (effective), `group_scope`, `current_user_is_admin: false`,
`users[]` rows — `id`, `name`, `country`, `delegate`, `threads`,
`comments`, `polls`, `votes`, `votes_cast`, `votes_issued`,
`votes_missed`, `all_votes_cast`, `outcomes`, `reactions` — and the same
numbers as `*_per_user` maps keyed by user-id STRINGS. Semantics
(ReportService, scoped to topics of the effective groups and `created_at`
inside the window): `threads` / `comments` / `polls` / `outcomes`
authored; `reactions` given; `votes` = `votes_cast` = latest stances with
`cast_at` set on polls with `anonymous = false`; `votes_issued` = latest
stances with a participant on those polls (Loomio creates one stance per
invited voter when a poll opens, so this is "ballots handed to the
user"); `votes_missed` = issued − cast; `all_votes_cast` = issued > 0 and
every one cast. So **anonymous polls contribute nothing to the vote
columns**, and a vote is attributed to the month the COUNTED stance
ROW was created — the ballot issued when the poll opened or the voter
was added later (`PollService.create_stances`, also from
`group_members_added`), or, for a vote Loomio replaced on change, the
change: `StanceService.update` builds a new row with `cast_at = now`
and flips the old one to `latest: false` when the position changed
after a reply or more than 15 minutes later (`creates_replacement`),
and `uncast` does the same — so the original month loses the vote and
the month of the change gains it. Not necessarily the month the vote
was first cast. The row
set is `Membership.where(group_id: ids).pluck(:user_id)` — no `.active`
— so everyone who EVER held a membership in the groups gets a row,
revoked and deactivated accounts included; content authored by
non-member guests is not counted. Authorization is
`authenticate_api_key!` only: a 403 here is the key.

The connector validates months with `/^\d{4}-(0[1-9]|1[0-2])$/` before
sending, never sends `interval`, and sends `start_month=2000-01` when a
caller asks for all history (Loomio's own default would silently narrow
"ever" to twelve months; the users section builds no per-interval
series, so a wide window costs nothing extra).

## Memberships

Loomio 3.8.1, `Api::B2::MembershipsController`, `MembershipQuery`,
`MembershipSerializer`, and `test/controllers/api/b2/memberships_controller_test.rb`.

**Reading (`GET /b2/memberships?group_id=`).**

- `accessible_records` is `MembershipQuery.visible_to(user:
  current_user).where(group_id:)`: **any member** of the group sees its
  roster — user id, name, username, `admin` / `delegate`, `title`,
  `accepted_at` (null = invited, not yet accepted), inviter — and so do
  admins of the parent group for subgroups visible to parent members.
  No admin role is needed (test: "group member can list names and roles
  without other members' email addresses").
- `user_email` is serialized only when the group is in the caller's
  `adminable_group_ids` (the controller passes them as
  `membership_email_group_ids`) or the caller invited that member
  (`MembershipSerializer#include_user_email?`). A plain member gets the
  roster **without** emails — silently, no error (test: "group admin can
  list member email addresses").
- A **non-member is not refused**: the query scopes to the caller's own
  groups, finds nothing, and the controller answers `200` with
  `memberships: []` (tests: "non-member cannot list a private group's
  memberships" and "instance admin not in group cannot list memberships
  or email addresses" both assert `:success` + empty). Instance
  `is_admin` does not widen this. That is why the connector adds
  `scope.note` to an empty roster.
- Unknown **or missing** `group_id` → 404 (`Group.find`, which raises
  `RecordNotFound` for a nil id as well; Loomio's own test "missing group
  id" asserts 404). There is no 400 path: the route is flat, nothing
  `require`s `group_id`.
- No `ORDER BY`, so paging with `offset` is not guaranteed stable across
  calls.
- `compact=1` drops the group, parent, reaction, tag and translation
  side-loads; `users` still arrives (verified on a live capture: roots
  `memberships`, `users`, `meta`). `user_email` is a serializer scope
  decision, not a side-load, and is unaffected.
- The `users[]` root never carries a MEMBER's email (Loomio's test
  "group admin can list member email addresses" asserts
  `refute serialized_user.key?("email")`; the entitlement lives on
  `memberships[].user_email`). It does carry the API user's OWN email:
  `AuthorSerializer#include_email?` is `scope[:current_user_id] ==
  object.id || …`, and every b2 index sets `current_user_id`
  (`SnorlaxBase#default_scope`; the memberships controller merges its
  own keys into that scope without removing it) — confirmed on the live
  groups-index capture, where only the own row has `email`. The
  connector drops `users[].email` on this endpoint for that reason.

**Writing (`POST /b2/memberships`).**

- `authorize_manage_group!`: the caller must be in the group's
  `adminable_group_ids`, else `raise CanCan::AccessDenied, "User is not
  an admin"` → `403 {"error":"User is not an admin"}`. Parent-group
  admin and instance admin do **not** count (tests: "instance admin not
  in group cannot add members" / "… remove members").
- Always additive for `emails` not already present
  (`GroupService.invite`).
- `remove_absent` is read as **`params[:remove_absent].to_i == 1`**
  (since Loomio 2.24.0; the OpenAPI document says "Pass `1`"). A JSON
  `true` has no `#to_i` in Ruby → `NoMethodError` → HTTP 500, **after**
  the invitations were sent. The connector sends the integer `1` or
  omits the key.
- When set, every current member (`User.active` with a membership in
  `group.memberships` — the *active* scope, which still contains
  pending invitees) whose email is not in the list is revoked via
  `MembershipService.revoke`, which cascades to the same user's
  memberships in subgroups. The caller's own membership is revoked if
  its email is absent. Empty `emails` → empty group. No server-side
  dry-run.
- Response: `{added_emails: [...], removed_emails: [...]}`.

## b3 admin (opt-in)

`Api::B3::UsersController` — bearer token `secure_compare`d against
`ENV['B3_API_KEY']` (must be >16 chars); a wrong or missing secret, *or
a server with no `B3_API_KEY` set*, answers the generic 403 body. No
per-user authorization is applied — the secret authenticates the server.
The connector's 403 classifier therefore names `LOOMIO_B3_API_KEY` on
`/b3/` paths — never the per-user key, `/profile/api_access` or the
`/health` verdict, which probes the b2 key.

- `POST /b3/users/{id}/deactivate`: finds the user in `User.active`
  (else 404), enqueues `DeactivateUserWorker` and answers
  `{ success: true, user: {…} }` **at once**; the echoed user can still
  show `active: true` / `deactivated_at: null`. The worker stamps
  `deactivated_at`, revokes active memberships (with that timestamp),
  revokes mobile devices and drops pending membership requests.
- `POST /b3/users/{id}/reactivate`: finds the user in `User.deactivated`
  (else 404), runs `UserService.reactivate` synchronously — clears
  `deactivated_at` and **restores the memberships whose `revoked_at`
  equals the deactivation timestamp** — and answers the same shape with
  `active: true`.
- `GET /b3/users/{id}` and `GET /b3/users/identity/{identity_type}/{uid}`
  (`Identity.with_user.find_by!(identity_type:, uid:)`) answer
  `{ user }`; `GET /b3/users[?is_admin=true|false]` answers `{ users }`
  — every account on the instance, active or not, ordered by id,
  **unpaginated** (tests "index returns users with identities", "index
  filters users by admin status", "show returns a user", "show by
  identity returns a user").
- `user` fields (`user_json`): `id, name, username, email, is_admin,
  active, deactivated_at, identities[{id, identity_type, uid, email,
  name}]`. No `api_key`. Every row carries the email, which is why the
  two reads are gated like the writes and documented single-tenant only.
- Identity route caveat: Rails' default segment pattern excludes `.`, so
  a `uid` containing a dot (most email addresses) is split into uid +
  format and answers 404 in 3.8.1. Address such users by numeric id.

## Canonical URLs

From `config/routes.rb` (`d/:key(/:slug)(/:sequence_id)`,
`p/:key(/:slug)(/:sequence_id)`, `g/:key(/:slug)`, `get ":id" =>
'groups#show'` for handles), `app/helpers/pretty_url_helper.rb`
(`comment_url` → `?comment_id=`, `no_slug_topic_url_options` →
`?sequence_id=`) and `vue/src/routes.js`:

| Record | URL |
|---|---|
| discussion | `/d/{key}[/{slug}]` — the slug is `title.parameterize` and cosmetic; any value or none resolves |
| poll | `/p/{key}[/{slug}]` |
| comment / item in a thread | `/d/{key}?comment_id={id}` or `/d/{key}?sequence_id={n}` (`/p/…` on a standalone poll's thread) |
| group | `/{handle}` when the group has a handle, else `/g/{key}[/{slug}]` |

`src/loomio/shape.ts` builds them on `siteBaseUrl()` (the API base minus
`/api`) with a `String#parameterize`-alike slug; a title with no ASCII
form yields no slug.

## Error shapes

All Loomio API errors are JSON (`render json:` in `Api::V1::SnorlaxBase`).
`src/loomio/client.ts` reads the body as text once and dispatches:

| Status | Body | Source | Connector |
|---|---|---|---|
| 400 | `{"error":400}` | `ActionController::UnpermittedParameters` / `ParameterMissing` — a key `PermittedParams` does not list (`discussion_id` on a poll, a nested `comment` hash, `compact` on a write) | `LoomioApiError` |
| 403 | `{"error":"You are not authorized to access this page."}` | CanCan's default message for a bare `raise CanCan::AccessDenied` (Loomio's `server.en.yml` defines no `unauthorized.default`). Raised by `authenticate_api_key!` (no active user owns the key) on every b2 path; by `records_visible_in_group` — called **only** from `DiscussionsController#index` and `PollsController#index` (the GET index, not `#create` on the same paths) — when the group is not visible to the caller; by `PollService.invite` on `POST /b2/polls` for an anonymous poll that is not active (no future `closing_at`), **after** the poll was saved; and by `Api::B3::UsersController#authenticate_api_key!` on every b3 path when the bearer does not `secure_compare` to the server's `ENV['B3_API_KEY']` or that variable is unset / ≤ 16 chars. **Never** for visibility on `/b2/groups` (index), `/b2/threads…`, `/b2/search` or `/b2/reports` — those filter or 404 instead — so there the body means the key and nothing else. `MembershipsController#index` never raises it (a non-member gets `200 []`), `show` actions use `load_and_authorize` (the message-bearing body below). | `LoomioAuthError` kind `unauthenticated`; the message hedges towards visibility only on the two gated lists **and only on GET**, names the poll exception on `POST /b2/polls`, says "key, nothing else" on the filter-only paths, is definitive ("key rejected") when a **fresh** (< 60 s) health verdict says so, and on `/b3/` paths names the b3 secret and ignores the health verdict |
| 403 | `{"error":"Not authorized to <action> <Model>."}` | CanCan `authorize!` with a message (`unauthorized.manage.all`) — per-record permission. `Not authorized to show Group.` on `GET /b2/groups/:id` = the group exists and is hidden from the user | kind `not_authorized`, message verbatim; the group-show case is explained as *hidden group, remedy is membership* |
| 403 | `{"error":"User is not an admin"}` | `memberships#create` `authorize_manage_group!` | kind `not_admin` |
| 403 | `{"error":403}` | `respond_with_standard_error` for `Subscription::MaxMembersExceeded` | kind `plan_limit` |
| 403 | `{"error":"…thread limit…","action":"upgrade"}` | `respond_with_thread_limit_reached` (`Subscription::MaxThreadsExceeded`) | kind `plan_limit` |
| 403 | non-JSON, or JSON whose `type` URL names cloudflare (e.g. title "Error 1010: Access denied") | **not Loomio** — a CDN/WAF in front | kind `waf` |
| 404 | `{"error":404}` | `ActiveRecord::RecordNotFound` — an unknown id, **or** on `/b2/threads/{id}…` a thread the user may not see (`TopicQuery.visible_to(user).find`); also a plain routing miss for a removed route | `LoomioApiError`; the thread tools say both readings, `get_group` says "wrong identifier, not restricted" |
| 422 | `{"errors":{"field":["message", …]}}` | `ActiveRecord::RecordInvalid` (a discussion's `private` against the group's policy, a poll's `closing_at` in the past, a frozen anonymous poll) | `LoomioApiError` with fields joined |
| 429 | `text/plain` "Retry later" (+ `Retry-After` only if the instance enables it) | Rack::Attack `throttle('req/ip', limit: 900 * RATE_MULTIPLIER, period: 5.minutes)`, keyed on client IP (`CF-Connecting-IP` when behind Cloudflare) | `LoomioApiError` with a retry message naming the remaining fan-out (`get_user_activity`, one report per group) |
| 429 | `{"flash":{"error":"Daily invitation limit reached…"}}` | `ThrottleService::LimitReached` (invitations) | `LoomioApiError` with Loomio's message |
| 500 | HTML / empty | `ParticipationReportService` on a malformed `start_month` / `end_month`, an unknown `interval` or `member_type`; `CommentsController#create` with a `parent_id` that does not exist | `LoomioApiError`; the connector validates months / member_type client-side so it never sends the malformed forms |
| 401 | anything, on a `/b2/` or `/b3/` path | **not Loomio's b2/b3** — both raise `CanCan::AccessDenied` for every authentication failure, rendered 403 by `SnorlaxBase`; a 401 here is a proxy / CDN / basic-auth gate in front | `LoomioAuthError` (status 401, no `kind`), explained as such |
| 401 | `{"error":"you gotta be signed in"}`, on a `/v1/` path | **Loomio itself**: `Api::V1::RestfulController#require_current_user` renders 401; v1 resolves its user from the session cookie only, so the API key is not a v1 credential. The connector's one v1 call (`boot#version`) carries no such guard | `LoomioAuthError` (status 401), message names both Loomio's session 401 and a possible proxy |

Loomio's error bodies since 3.1.1 also increment a Sentry
`http.forbidden` metric with the CanCan action, which is why they carry
the message.

## Loomio 3.1 → 3.8 changes that matter (written 2026-09-20)

Dates are commit dates from Loomio's repository; "release" is the
first tag containing the commit. Loomio publishes **no** API
deprecation or compatibility policy — its product changelog
(`docs/user_manual/changelog/`) mentioned the b3 bearer change and the
3.3.1 key rotation, and the only machine-readable markers are
`deprecated: true` flags in its OpenAPI document.

| Landed | Release | Change | Effect on the connector | Status |
|---|---|---|---|---|
| 2026-02-19 → 05-27 | 3.1.0 | **Topic model.** Threading state moved from Discussion/Poll to a `Topic` record. `DiscussionSerializer` gained `topic_id` + `has_one :topic` (root `topics`) and lost `items_count`, `last_activity_at`, `ranges`, `closed_at`/`locked_at`, `pinned_at`, `private`, `seen_by_count`, `members_count`, `max_depth`; `group_id` is now derived via the topic. `compact=1` (3.8.0) drops the `topics[]` side-load. | A thread's counters are in `topics[]`, joined by `topic_id`. | **Done 0.0.12**: `joinTopics`; reads never send `compact` where topics are needed |
| 2026-02-24 | 3.1.0 | `comment_attributes` drop `:discussion_id` (the controller reads it top-level); `poll_attributes` `:discussion_id` → `:topic_id`. | A poll attaches to a thread by `topic_id`; `discussion_id` is 400. | **Done 0.0.12**: `create_poll` resolves `discussion_id` → `topic_id` |
| 2026-05-21 | 3.1.0 | b2 discussions default `status` fall-through `is_open` → `kept` (locked included); `open`/`closed` aliases kept. | Omitting `status` silently widened the list. | **Done 0.0.11**: always sent, default `open` |
| 2026-05-28 / 07-19 | 3.1.0 | `DiscussionService.build` / `PollService.build` derive topic `private` from the group when omitted (`TopicService.private_default`). | Gotcha 3 (`create_poll` 422 on public-only groups) is fixed upstream; `create_discussion`'s privacy resolver is redundant. | **Done 0.0.12**: resolver removed; `private` sent only when the caller sets it |
| 2026-06-12 | 3.1.0 | Rails sessions replace Devise; **password change rotates `api_key`** (`UserService.rotate_credentials_after_password_change`). | The connector's key dies whenever its user changes password. | **Done 0.0.11**: health probe, classified 403, runbook |
| 2026-06-23 | 3.1.0 | b2 `update` + `destroy` on discussions, polls, comments. | update_/delete_ tools. | **Done 0.0.12**: six tools |
| 2026-06-23 / 07-06 | 3.1.0 | b3 reshaped: member routes `/b3/users/{id}/deactivate\|reactivate\|redact`, identity routes, index/show/update/destroy; response `{success: true, user}`; `b1` namespace removed. | Admin tools use member routes; index/show wrapped as reads. | **Done 0.0.11** (routes) / **0.0.12** (`get_user`, `list_users`) |
| 2026-06-30 | 3.1.0 | **`GET /api/b2/groups`** (`current_user.groups`, exact `meta.total`) and `GET /api/b2/groups/{id_or_key_or_handle}`. | Native replacement for the `list_groups` probe; 200 for any valid key → ideal key-health probe. | Probe **done 0.0.11**; `list_groups` / `get_group` / `check_connection` **done 0.0.12** |
| 2026-07-12 | 3.1.0 | Agent API: `GET /api/b2/threads`, `/threads/{id}`, `/threads/{id}/items` (ordered `TopicItem`s), `/threads/{id}/markdown`. | Successor to `v1/events`. | **Done 0.0.12**: `list_threads`, `list_thread_items`, `get_thread_markdown` |
| 2026-07-24 | 3.1.1 | **403 bodies carry the CanCan message** (`respond_with_access_denied` renders `{"error": e.message}`; before: `{"error":403}` for everything). | A 403 can be diagnosed from its body; the membership "fence" is obsolete. | **Done 0.0.11**: `classifyForbidden`; fence removed; **0.0.12** adds the filter-only paths and the group-show case |
| 2026-07-24 | 3.1.2 | `MembershipSerializer#include_user_email?` gated on `membership_email_group_ids` (caller's adminable groups) or inviter. | Emails are admin/inviter-only, silently. | **Done 0.0.11** |
| 2026-07-25 | 3.1.3 | **Bearer-only b2 auth**: query-string `api_key` rejected; `permitted_params` **prefers the wrapped resource hash** when present; comments controller override removed. | Query keys → generic 403. Flat JSON discussion / poll bodies lose their non-column keys (confirmed live 2026-09-20); form-encoded comments 400. | Auth **done 0.0.9**; write bodies **done 0.0.12** (nested / flat JSON, post-create guards) |
| 2026-07-31 | 3.1.5 | b3 bearer-only (body/query `b3_api_key` rejected). | — | **Done 0.0.9** |
| 2026-08-24 | 3.3.1 | **Every user's `api_key` rotated** (migration `RotateExposedUserApiKeys`); exports exclude keys. | Every deployed connector's key died on the instance's upgrade day. | **Done 0.0.11**: detection + runbook |
| 2026-08-23 | 3.4.0 | **Event → TopicItem.** `/api/v1/events` (controller + route) removed; `eventable_*` → `itemable_*`, `discussion_id` → `topic_id`. | `list_events` / the old `get_user_activity` cannot work. | **Done 0.0.12**: `list_events` removed, `list_thread_items` added, `get_user_activity` rewritten on the report |
| 2026-09-16 | 3.7.0 | `GET /api/b2/reports` — participation report per group set (delegates, votes issued/missed). | One call replaces the per-discussion fan-out. | **Done 0.0.12**: `get_participation_report`, `get_user_activity` |
| 2026-09-17 | 3.8.0 | **Public visibility honoured in User API lists**: `records_visible_in_group` = `can?(:show, group)` + `TopicQuery.visible_to`; non-members read public groups' public topics. | Access boundary = memberships **plus** public content (SECURITY.md). | **Done 0.0.11** (docs) / **0.0.12** (`get_group`, `list_threads`, `search_content` reach it) |
| 2026-09-17 | 3.8.0 | **Memberships**: any member lists the roster; emails admin/inviter only; **non-member → 200 empty**; `create` gated by `authorize_manage_group!` → `"User is not an admin"`. | `list_memberships` no longer 403s for role reasons; empty means "not a member". | **Done 0.0.11**: `scope.note`, descriptions |
| 2026-09-17 | 3.8.0 | **Instance `is_admin` removed from every b2 authorization check.** | The "an `is_admin` user sees every group" claim is false. | **Done 0.0.11**: claim removed |
| 2026-09-17 | 3.8.0 | `compact=1`, documented `exclude_types`, exact `meta.total` (omitted when undefined); `GET /api/b2/search` (typo-tolerant since 3.8.1); `/api/b2/chatbots`; OpenAPI 3.1 document in the repo. | Payload trimming; search tool. | **Done 0.0.12**: read profiles, `search_content`, `total` on every collection; chatbots deliberately not wrapped |

## Verified live (2026-09-20, Loomio 3.8.1)

Reads were captured with a non-admin key (roots and `meta.total`
presence are what `tests/fixtures.ts` follows, anonymised); writes ran
in a private sandbox group where the key's user is a plain member and
every record was discarded afterwards.

| Call | Result |
|---|---|
| `GET /b2/groups` (+ `exclude_types=tag translation`, + `compact=1`) | 200; roots `groups`, `memberships`, `parent_groups`, `users`, `meta.total`; compact drops `memberships` / `parent_groups` and the `_id` keys |
| `GET /b2/groups/{id}` member group | 200; roots as the index plus `tags` |
| `GET /b2/groups/{id}` hidden group | `403 {"error":"Not authorized to show Group."}` |
| `GET /b2/discussions?group_id=&limit=` (+ list profile) | 200; `topics[]` carries the counters; the profile drops `groups`, `memberships`, `parent_groups`, `reactions`, `tags` |
| `GET /b2/discussions/{id}` | 200; `discussions`, `groups`, `topics`, `users` |
| `GET /b2/polls?group_id=&status=all` | 200; `polls`, `topics`, `poll_options`, `outcomes`, `users`, `meta.total` |
| `GET /b2/threads?limit=&compact=1` | 200; `threads` + `discussions` / `polls` (+ `poll_options`, `outcomes`) + `users`, `meta.total` |
| `GET /b2/threads/{topic_id}` | 200; `threads`, `discussions`, `users` |
| `GET /b2/threads/{topic_id}/items?compact=1` | 200; `items`, `comments`, `discussions`, `users`, `meta.total` |
| `GET /b2/threads/{topic_id}/markdown` | 200; `{markdown}` |
| `GET /b2/memberships?group_id=&compact=1` as a member | 200; `memberships`, `users`, `meta.total` |
| `GET /b2/memberships?group_id=` as a non-member | `200 {"memberships":[],"meta":{…}}` |
| `GET /b2/search?query=&compact=1` | 200; `search_results`, `users`, `polls`, `poll_options`; no `meta.total` |
| `GET /b2/search?author_id=&compact=1` | 200; author mode |
| `GET /b2/reports?section=users&group_ids=` (one and two groups, with `start_month`/`end_month`) | 200; plain hash, effective `group_ids` echoed |
| `GET /b2/reports?section=base&group_scope=my` | 200 (not wrapped) |
| `GET /v1/boot/version` (no credential) | 200; `{version, release, …}` |
| `POST /b2/discussions` nested / flat | 200 correct / **200 orphan** (see "Request body shape") |
| `POST /b2/comments` flat JSON / form / nested | 200 / **400** / **400** |
| `POST /b2/polls` nested (`group_id`; `topic_id`) / flat / nested `discussion_id` | 200 / **200 orphan, no options** / **400** |
| `PATCH /b2/discussions/{id}`, `/b2/polls/{id}` nested; `/b2/comments/{id}` flat | 200 |
| `DELETE /b2/{discussions,polls,comments}/{id}` | 200, `discarded_at` set, title / body nulled |

Not run live (source and upstream tests only): `recipient_*` /
`notify_recipients` variants, `specified_voters_only` and anonymous
polls, replies via `parent_id` + `parent_type` (any parent type — the
live comment probes all used a top-level `discussion_id`; Loomio's own
b2 comments controller test posts no `parent_id` either, so replies are
verified from `permitted_params.rb` / `comments_controller.rb` / the
Comment model alone), `update_poll`'s `options` (its replacement
semantics come from `poll.rb` / `poll_option.rb` and Loomio's model
tests), `GET /b2/threads/{topic_id}` on its own (`create_poll`'s
`topic_id` + `group_id` cross-check; its row shape is the one
`GET /b2/threads` returns per row), creates in a `public_only` group,
every b3 route.

## Historical: Gotcha 1 — the `create_discussion` privacy resolver (removed in 0.0.12)

Every group has `discussion_privacy_options ∈ {public_only,
private_only, public_or_private}` and the Topic validator rejects a
mismatch (422 "must be public" / "must be private"). Topic's column
default is `private: true`, so on Loomio ≤ 3.0.x an omitted `private`
failed on every public-only group; the connector fetched
`GET /api/v1/groups/{id}` (an ANONYMOUS read — v1 ignores the key) and
picked `false` only for `public_only`. Loomio 3.1.0's
`TopicService.private_default` derives the value from the group when
`private` is omitted, so the lookup was redundant on current Loomio and
was one v1 call per create. 0.0.12 sends `private` only when the caller
sets it and makes no lookup. The 422 still applies when a caller sets
`private` against the group's policy; the schema description says so.

## Historical: Gotcha 2 — form-encoded `create_comment` (removed in 0.0.12)

On Loomio ≤ 3.1.2 the b2 base controller stripped `:discussion` / `:poll`
/ `:discussion_id` / `:api_key` / `:format` before re-wrapping but not
the auto-wrapped `:comment` key, so a JSON body `{body, body_format}`
became `{comment: {comment: {…}, …}}` and strict mode raised 400. Form
bodies are not subject to `wrap_parameters`, so the connector posted
`application/x-www-form-urlencoded` with `discussion_id` in the query.
Loomio 3.1.3 removed the override and reads a top-level `discussion_id`;
on 3.8.1 the form path answers **400** (verified live) and flat JSON is
the tested shape. The form encoding option is gone from the client.

## Historical: Gotcha 3 — `create_poll` on public-only groups (fixed upstream in 3.1.0)

`PermittedParams#poll_attributes` did not include `:private` while
`PollService.build` extracted it, so a new poll's Topic always carried
`private: true` and any group with `public_discussions_only?` 422'd with
an empty `{"errors":{}}`. Loomio 3.1.0's `TopicService.private_default`
fixed it. Not re-verified live on a public-only group (the 2026-09-20
sandbox was `private_only`); per source it works.

## Historical: Gotcha 4 — enumerating groups by probe (removed in 0.0.12)

Before Loomio 3.1.0 b2 had no `groups` resource, so `list_groups` probed
a `group_id` range with `GET /b2/polls?group_id=N&limit=1&status=all`
and collected the groups side-loaded in 200 responses: 50–500 calls per
invocation, blind to groups without polls (the group only reached the
response as a side-load of its polls), unable to tell "hidden group"
from "rejected key" per probe, and — once 3.8.0 let any user read public
groups — listing public groups the user had never joined. Replaced by
the native index; the three probe inputs survive as ignored no-ops so an
older client's call still parses.

## Historical: Gotcha 5 — `{"error":403}` and "the fence" (Loomio ≤ 3.1.0)

On Loomio ≤ 3.1.0 every refusal answered the byte-identical
`{"error":403}`: a bogus key, a valid key whose user was not a member,
and (when `b2/memberships` was admin-only) a member without the admin
role. Because the body carried no information, 0.0.4 introduced an
"access fence" (`src/loomio/access.ts`) that probed a member-gated
endpoint with the same key to tell the cases apart. Loomio 3.1.1 made
the 403 body say why and 3.8.0 made `list_memberships` readable by any
member (a non-member gets an empty 200); the fence was removed in
0.0.11 and `classifyForbidden` replaces it.

## Historical: verified live 2026-05-27 (self-hosted Loomio 3.0.24)

Kept for the record; superseded by the 2026-09-20 table. `get_discussion`,
`list_discussions`, `get_poll`, `list_polls`, `list_memberships` (as an
admin), `list_groups` (probe), `create_discussion` (with the privacy
resolver), `create_comment` (form-encoded) and `manage_memberships`
(additive; `remove_absent` was a boolean, which 500s) passed;
`create_poll` failed on Gotcha 3.

## Things we don't know yet

- Whether the CanCan `authorize!` message casing is exactly
  `Not authorized to <action> <Model>.` on every path — the connector
  matches `/^not authorized to /i`, case-insensitively, for that reason.
- Whether any instance enables Rack::Attack's `Retry-After` header; the
  connector includes it when present and says so when not.
- How `pg_search_words` (the "did you mean" vocabulary) is refreshed on a
  given instance — typo tolerance in `search_content` depends on it.
- Whether `GET /b2/threads/{id}/items` will grow pagination; until it
  does, a huge thread costs one full fetch per call.
