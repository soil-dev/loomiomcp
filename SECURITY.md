# Security

## Threat model

loomiomcp is a thin shim. It holds one upstream credential
(`LOOMIO_API_KEY`) — over HTTP also the OAuth signing key — and exposes
a small tool surface — 14 reads, 10 writes, 9 opt-in instance-admin tools
— that calls Loomio's b2 API on behalf of authenticated MCP clients,
plus the optional b3 admin endpoints (gated by a separate,
server-instance secret) when explicitly enabled.

This file was revised for v0.0.17 after a security review of v0.0.16
(23 findings, 22 smaller items); where v0.0.16 behaved differently from what is written
here, the text says so and dates it. Two rules hold throughout: **every
rate, size and quota bound is per connector process** (in-memory state;
N instances allow up to N times the figure, and a cold start resets
it), and **everything Loomio returns is untrusted text** (see "Loomio
content is untrusted input"). What remains open after this release is
listed at the end, under "Accepted risks".

Everything below is stated against Loomio 3.13.1 (`TESTED_LOOMIO_VERSION`
in `src/version.ts`). 3.9 → 3.13.1 changed what this file depends on in
three places, each covered below: the Markdown export stopped applying
"hide results until vote" (3.10), the groups index and thread items
became paged (3.11.1, which changes the upstream cost bounds), and the
b3 secret gained instance-wide group and membership provisioning
(3.13). Loomio publishes no API compatibility policy and changed its
User API permission model between 3.0 and 3.8; re-check this file when
the health probe reports version drift.

## HTTP / multi-user posture (public deployments)

A public, open-DCR deployment runs in a specific shape that defines its
blast radius. Understand this before exposing the connector publicly:

- **Open DCR.** Anyone who can reach the URL can register an OAuth
  client and connect (`MCP_OAUTH_INSECURE_AUTO_APPROVE=1`). The OAuth
  layer is therefore **not** an authentication boundary here — it gates
  protocol conformance, not identity.
- **One shared upstream identity.** Every caller acts as the same
  Loomio user — the account behind `LOOMIO_API_KEY`. There is no
  per-user upstream auth (Loomio's per-user v1 API is Turnstile-walled).
  `check_connection` tells every caller who that account is (id, name,
  username) and which groups it is in.
- **The access boundary is the connector user's memberships PLUS the
  instance's publicly visible content.** A caller reads exactly what
  that user can read. Since Loomio 3.8 that is more than its groups:
  any authenticated API-key user can read **public groups' public
  threads** without being a member (`can?(:show, group)` plus per-topic
  visibility; a group whose `is_visible_to_public` is true passes for
  everyone). Four tools reach that content directly — `get_group`,
  `list_discussions` / `list_polls` by id, `list_threads` (every visible
  thread on the instance, newest first, one call) and `search_content`
  (full-text over every visible thread, comment, poll, vote reason and
  outcome). Confidentiality is not widened beyond what Loomio's anonymous
  web UI already shows — but through an open-DCR connector an anonymous
  caller can **enumerate and search every public group's public content
  on the instance** with two cheap calls. Private groups and private
  topics still follow membership. Scope the deployment by scoping the
  user: add it only to groups whose data may be public. Adding it to a
  new group widens what every anonymous caller sees. Instance `is_admin`
  on the connector's user does **not** widen the User API on Loomio ≥ 3.8
  (Loomio removed it from every b2 authorization check) — do not grant
  it regardless.
- **Group coordinators change that boundary; `LOOMIO_MCP_GROUP_IDS`
  takes it back.** Any coordinator can add the connector's user to a
  group (even as a pending invitation), promote it, or start a private
  thread in one of its groups — and every caller then sees the result,
  with no operator involved. Set `LOOMIO_MCP_GROUP_IDS` (comma-separated
  group ids; v0.0.17) to serve ONLY the listed groups: a tool naming
  another group refuses before any upstream call; a record read
  (discussion, poll, thread, group by key) checks the record's group and
  refuses one outside the list or in no group at all (direct threads);
  `list_groups`, `check_connection`, `list_threads`, `search_content`,
  the participation reports and `get_user_activity`'s samples are
  filtered to it, silently (no count of what was removed —
  `list_threads` walks Loomio's index itself, so its `total`, paging and
  `since` figures count listed-group threads only; round 2 found the
  first cut relaying Loomio's unfiltered total and page length, and a
  `limit: 1` walk marking each withheld thread's position); writes
  addressed by record are checked with one read first, and comment edits
  or replies whose group no b2 read can name are refused. The list never
  widens anything; the b3 tools (an operator's own instance-wide tools)
  are not affected. Independently, the health probe compares what it
  sees with its previous probe in the same process and logs a FORCED
  `loomio.groups_changed` event (ids and counts only) when the member
  group set, an own admin flag or a group's privacy changes —
  `check_connection` says so too, without ids — so an operator can alert
  on exposure changes instead of learning of them by chance.
- **Per-member participation counts are exposed for member groups.**
  `get_participation_report` and `get_user_activity` read Loomio's
  participation report (`GET /b2/reports?section=users`): for every
  group the connector's user is a member of, a row per person who ever
  held a membership there — name, delegate flag, threads / comments /
  polls / votes cast vs issued vs missed / outcomes / reactions in a
  month window. This is the same data Loomio shows every member on the
  group's participation page (no admin role is involved, and Loomio
  drops groups the user is not in), but through a public connector it is
  available to anyone. Anonymous polls are excluded from the vote
  columns and nothing in the report names how anyone voted. If
  per-member activity of a group must not be public, the connector's
  user must not be a member of that group.
- **Writes are off.** `LOOMIO_MCP_READONLY=1` removes all write tools,
  so the shared identity is read-only. Dropping readonly would turn open
  DCR into anonymous public *write* — don't.
- **Member rosters are visible; member emails are withheld on read-only
  deployments.** On Loomio ≥ 3.8 `list_memberships` returns the roster
  of every group the connector's user is a member of — user ids, names,
  usernames, `admin` / `delegate` flags, `title`, join state, inviter.
  Loomio adds `user_email` to a membership row when the connector's user
  administers the group OR invited that member itself
  (`membership_serializer.rb` `include_user_email?`). v0.0.16 relayed it
  wherever Loomio sent it, so one coordinator action (promoting the bot)
  or one historical invitation sent as the bot turned a roster into an
  anonymously readable e-mail list. Since v0.0.17 the connector drops
  `user_email` from **every** row in read-only mode (the only legitimate
  consumer, `manage_memberships` with `remove_absent`, is not registered
  there) and from the connector account's **own** row always;
  `check_connection` adds a note, and the health probe logs a FORCED
  `loomio.admin_scope` event, whenever the connector's user holds a
  group-admin membership. A WRITABLE deployment whose user administers a
  group still relays that group's member emails — keep the user a plain
  member unless it must manage memberships. Loomio ALSO puts the
  connector account's own email on its `users[]` row for every group it
  belongs to (`AuthorSerializer#include_email?` is true for
  `current_user_id`) — the operator's service-account mailbox, not
  roster data — so the connector drops `users[].email` entirely (on this
  endpoint it can be nothing else).
- **One poll-visibility rule everywhere, search included.** Loomio
  indexes every cast vote's reason (with the voter's name) for search
  EXCEPT those of open `until_closed` polls; open `until_vote` polls are
  indexed, and Loomio's own web search shows a logged-in member those
  hits. Its thread view does not (a member who has not voted sees the
  voter but not the choice), and neither does this connector's
  `list_thread_items`. `search_content` — and `get_user_activity`'s
  `sample_events`, which reuse its shaping — apply the same
  `results_visible?(voted:)` rule from the response's own `polls` root.
  A withheld snippet alone would not close the gap in a `query` search:
  the hit's EXISTENCE says the query term occurs in that voter's hidden
  reason, and with `types: ['Stance']`, `author_id` and prefix matching
  that is a word-by-word oracle over exactly the text `list_thread_items`
  strips (Loomio's own web search has the same property — it shows the
  member the full reason). So in `query` mode `search_content` **drops**
  such hits — silently: v0.0.16 counted them in
  `scope.hidden_stance_hits_dropped` and computed `capped` before the
  drop, and either number answered the same yes/no per prefix (the
  review recovered a hidden reason's first word in 74 calls without
  seeing a snippet). Since v0.0.17 there is no counter and `capped` is
  computed from the rows returned; and because Loomio returns at most
  20 hits, a query search returns at most 19, so a single dropped hit
  cannot be told from a 20th visible one either (otherwise 20 visible
  matches read 20 / `capped: true` and 19 visible + 1 withheld read 19 /
  `capped: false`). What remains is narrow and listed under "Accepted
  risks": two or more withheld hits inside Loomio's first 20 shorten the
  page, which a caller who can see 20+ other matches of the same terms
  can notice; and `capped` can read false while Loomio had more. In
  author-only mode (no term to probe with) the hit stays with its author
  and `snippet: null` + `snippet_hidden_reason`, as `get_user_activity`'s
  `sample_events` do. Nothing is widened beyond Loomio's web UI either
  way; the point is that a caller cannot use one tool to read — or to
  confirm word by word — what another withholds. For a group the user is
  not a member of, Loomio answers `200` with an **empty list**, not 403;
  the connector annotates that with `scope.note`.
- **Loomio's own exports ignore `until_vote`, so `get_thread_markdown`
  refuses.** Since Loomio 3.10 (df28cf845) `ThreadMarkdownService`
  decides poll visibility by `results_available?` alone: an OPEN poll
  with `hide_results: until_vote` has its votes and results table
  rendered into the Markdown for a reader who has not voted — exactly
  what `get_poll`, `list_polls`, `list_thread_items` and
  `search_content` withhold. Redacting Loomio's localised document is
  not attempted. Instead `get_thread_markdown` reads the thread first
  (one call on any reference, which it needed anyway for the header) and
  throws a `VisibilityRefusalError` naming the poll(s) — without
  fetching the document — when the thread holds an open until_vote poll
  the connector's user has not voted in. What the export prints is
  decided by the thread's ITEMS — every poll whose `poll_created` item
  sits in the thread — so the guard checks the items, never a counter:
  a poll it read (a standalone poll's own, or the one a `poll_id`
  named) that hides its results refuses at once; a thread holding only
  its opening item (`items_count` ≤ 1) adds nothing (2 calls in all);
  any other thread's items are scanned, 1 call per 500 items, at most
  10, stopping at the first page that shows a hidden poll — and a scan
  the cap stops refuses ("could not verify"), failing closed. A vote
  whose poll arrived on no items page cannot be judged, so it refuses
  too (v0.0.17; stock Loomio side-loads the poll with every vote, so this
  fires only on an upstream serializer change — exactly when the guard
  must not fail open). An unknown own user id counts as "not voted", and
  a poll whose `hide_results` is missing (Loomio hides the field only on
  a discarded poll) counts as hiding its results while open. Why not
  `active_polls_count` (which would spare most threads the scan): it
  follows `polls.topic_id`, and a topic or group admin can change that
  with `PATCH /b2/polls/{id}` (or a stale browser tab after a move)
  without moving the poll's items — the old thread then reads 0 while
  its export still prints the poll and every vote. The item rule also
  covers polls MOVED into a thread, a standalone poll's included: Loomio
  forbids creating a second poll there, but v1 `topics#move_comments`
  can move polls into any topic its actor administers, the thread read
  never shows such a poll, and the move raises `items_count`, so the
  scan finds it. This was live from Loomio 3.10 until 0.0.16
  on any deployment, read-only ones included. On Loomio 3.8 / 3.9 the
  export still applied the rule per reader (`results_visible?(voted:)`,
  thread_markdown_service.rb:168-172 before df28cf845), so the guard is
  skipped there — but only on a version a health probe reported within
  the last minute; an older probe is re-run first, and an unknown
  version or 3.10+ keeps the guard (fail closed: an instance upgraded
  since the last probe is never exported unguarded).
- **Group billing metadata is dropped.** Loomio's GroupSerializer adds a
  `subscription` block (plan, state, active, seat caps, renewal and
  expiry dates) to every group record whenever the API user holds an
  active membership in the group's organisation — a serializer
  attribute, so no `exclude_types` profile removes it — and through an
  open-DCR connector every anonymous caller would learn the
  organisation's Loomio plan for every member group. `get_group` drops
  `subscription` (with `new_host` and `discarded_by`); `enabled` still
  says whether the subscription is active, which is all a caller needs.
  `list_groups` never carried it (it picks fields). Since v0.0.17 the
  group, discussion and poll shows are ALLOW-lists of the fields their
  3.13.1 serializers send (minus the drops above): an attribute a later
  Loomio adds stays out until it is reviewed and listed, instead of
  reaching every caller by default.
- **Hidden and missing look the same in open-DCR mode.** Loomio answers
  an unknown group, discussion or poll id with 404 and an existing but
  hidden one with 403, and v0.0.16 explained the difference — over
  sequential ids, a map of which private records exist. Since v0.0.17 an
  open-DCR deployment answers both (and an allow-list refusal of a
  record) with one message; a static-client deployment keeps the
  precise diagnostics. The thread tools follow the same rule for every
  reference kind: an unknown `topic_id` and one in an unlisted group or
  a direct thread read alike, and a `discussion_id` / `poll_id` refusal
  names the id the caller passed — never the record's `topic_id`. So do
  the group-keyed lists: `list_discussions` and `list_polls` (Loomio
  answers an unknown group 404 and a hidden one its GENERIC 403) word
  both "not visible" — unless the key-health probe says the key itself
  is rejected, which reads the same for every id — and
  `list_memberships` (404 for an unknown group, an empty 200 for a
  hidden one) answers an unknown group with the hidden group's empty
  roster.
- **Abuse is bounded per source IP — per process.** The `/mcp`,
  `/health`, `/register`, `/authorize` and `/token` rate limiters key on
  the client IP (IPv6 /56) — **not** the OAuth client_id, because under
  open DCR a caller can mint unlimited client_ids and a client-keyed
  limit would be trivially bypassable. Each runs before anything else on
  its route (authentication, body parsing), so 401s and malformed bodies
  are counted too. The client IP is the TCP peer unless
  `MCP_HTTP_TRUST_PROXY` names the appending proxies in front (Cloud Run:
  `1`); a forwarded value that is not an address is ignored. All limits
  are per connector process (in-memory stores): with N instances the
  effective per-source ceiling is up to N times the configured value, and
  it resets on every cold start. The limiter bounds request **rate**, not
  data **volume**: in open-DCR mode the daily per-source quotas
  (`MCP_DAILY_TOOL_CALLS`, `MCP_DAILY_RESULT_BYTES`, also per process)
  cap what one source takes home per UTC day. Upstream cost is bounded
  per request too (below). **"One source" is one address, not one
  user:** every hosted-Claude connection (claude.ai, Desktop, mobile —
  and Messages-API MCP-connector calls, whose tool calls the API caller
  scripts) reaches the connector from Anthropic's published egress range
  (`160.79.104.0/21`). Without further configuration those users share
  every per-address bucket, and it is CHEAP to spend: measured on a
  10-group allow-list with `MCP_HTTP_UPSTREAM_PER_5MIN=300`, about 14
  `get_user_activity` calls used the address's 5-minute upstream share
  (repeatable every 5 minutes), and 5 000 tool calls — ~17 minutes at
  the rate limit — locked the address out of the daily quota until
  00:00 UTC. **List such ranges in `MCP_SHARED_EGRESS_CIDRS`:** an
  address inside one is keyed per client as well (`address|client-id
  tag`) — each client gets its own daily quotas and a quarter of the
  address's upstream share, while the address as a whole stays capped
  (20× the daily quotas, one source's half of the upstream window), and
  its clients are served round-robin in the upstream queue. Locking the
  address out then takes several client_ids — each a `/register` from
  the attacker's own address, 20 per hour — and, for the day-long
  lockout, 20 of them spending a full quota (~100 000 tool calls). The
  `/mcp` request-rate limiter stays per address (it runs before the
  bearer check, so it cannot know the client). Claude Code and other
  local clients connect from their own addresses.
- **No logs from anonymous input.** Malformed or oversized bodies on any
  route are answered with a fixed JSON code (`bad_request`,
  `payload_too_large`, `unsupported_media_type`) and logged nowhere;
  server errors log their class and status only. Client ids appear in
  log events as a 16-character SHA-256 tag, never the registrant-chosen
  blob. `MCP_HTTP_DEBUG=1` adds an internal error's message to its
  stderr line — one line, credentials scrubbed, clipped to 200
  characters — and is a **local diagnosis knob only**: never set it on a
  shared deployment, where that message can quote upstream text into the
  operator's logs.
- **Slow and oversized requests are cut.** Request headers must arrive
  within 10 s and the whole request within 30 s (v0.0.16 kept Node's
  60 s / 300 s, so a trickled body held a slot for five minutes); a
  `POST /mcp` body is capped at `MCP_HTTP_JSON_LIMIT` (default 256 KB,
  was 1 MB), the same cap the SDK transport enforces; an over-cap body
  is answered 413 in JSON-RPC shape so the client can say why. Every
  read tool's input is a few KB; the largest legal WRITE input, a
  100 000-character body, is up to ~300 KB of UTF-8 in CJK text (~600
  KB when a client \u-escapes it), so a write-enabled deployment with
  such users sets `MCP_HTTP_JSON_LIMIT=1mb`. The deadlines bound
  receiving a request, not a long tool call answering it.
- **A local server stays local.** A loopback `PUBLIC_BASE_URL` makes
  the server listen on that loopback address only; with `MCP_HTTP_BIND`
  pointing beyond loopback the open-DCR acknowledgement is required and
  the b3 secret is refused, exactly as for a public URL.
- **`/health` exposes only health fields.** See below.

For a deployment whose upstream identity sees confidential data, use
static-client mode instead (see DEPLOY.md) — the client_secret then
gates who can connect.

## Loomio content is untrusted input

Everything the tools return — thread titles and bodies, comments, vote
reasons, outcome statements, poll options, group descriptions, people's
names — is text that Loomio users wrote, and on an instance with public
groups or open sign-up, anyone can write some of it. An MCP client puts
that text into the model's context. A comment saying "ignore your
instructions and …" is a prompt-injection attempt, and the connector
cannot detect or neutralise it: it relays content, it does not
interpret it, and rewriting people's words would corrupt the very data
the tools exist to read. What bounds the damage:

- The server's MCP `instructions` (rule 11 of `SERVER_INSTRUCTIONS`)
  tell the model that Loomio text is untrusted data, never instructions.
  That is advice to the model, not enforcement.
- Nothing read from Loomio reaches tool metadata: descriptions and
  instructions are static strings, so content cannot rewrite what a tool
  claims to do. Every `url` a tool returns is built by the connector
  from record ids; links INSIDE bodies are content like the rest.
- The reads carry `readOnlyHint` and change nothing on Loomio, so a
  client may auto-approve them — which is exactly how injected text
  arrives unreviewed. The writes carry `destructiveHint` where they
  overwrite or discard, and `LOOMIO_MCP_READONLY=1` removes them: on a
  read-only deployment an injected instruction can make the model say
  something wrong, not make it post, edit or delete as the shared user.
  On a writable deployment the human approving each write call is the
  control; do not auto-approve writes.
- Injected text can also try to steer the model into OTHER tools of the
  same session (another connector that sends mail, say). That is the
  client's per-tool approval to enforce; this connector cannot see it.

## API key handling

Two distinct secrets:

- **`LOOMIO_API_KEY`** — per-user, sent as `Authorization: Bearer …` on
  every b2 request. Copy it from the user's API access page in Loomio
  (`/profile/api_access`).
- **`LOOMIO_B3_API_KEY`** (optional) — server-instance admin secret,
  sent as `Authorization: Bearer …` on b3 requests. Equal to
  `ENV['B3_API_KEY']` on the Loomio server. Only set this if you run the
  Loomio instance.

Both travel in the `Authorization` header, never in the URL. Loomio
rejects keys passed in the query string (removed July 2026) precisely
because URLs land in proxy access logs. Consequences:

- Keys MUST NOT be embedded in client-facing URLs. The connector
  injects them server-side, in `src/loomio/client.ts`. They are never
  forwarded to the MCP client and never appear in the
  `tool.call` / `loomio.request` / `loomio.auth` events emitted by
  `src/log.ts` (no headers are ever logged, and paths are run through
  `redactPath()`, which also drops the query string — search text, group
  id lists — and collapses record ids, string keys, group handles and
  b3 identity uids to placeholders).
- `LOOMIO_API_BASE_URL` overrides are validated at request time in
  `baseUrl()` (`src/loomio/client.ts`): the override MUST be either
  `https://`, or `http://` pointed at loopback (`localhost`,
  `127.0.0.1`, `[::1]`), and MUST NOT carry userinfo. A typo'd
  `http://` override to a public host would hand the API key to anyone
  on the network path; the validation refuses to start the request in
  that case. Userinfo is refused before undici sees the URL because
  undici's own rejection quotes the entire URL, password included, and
  that text would otherwise reach the startup warning. None of the
  validation messages echo the configured value (the scheme error names
  `protocol//host` only). The same validated value, minus `/api`, is the
  base of every `url` the tools return — so a bad override cannot
  produce links to an unexpected host either.
- Both keys are validated before use, at startup AND on every read
  (v0.0.17): one trailing newline is dropped (the harmless shape of
  `echo key > file`), and what remains must be printable ASCII without
  spaces. Anything else — a CRLF paste, a two-line secret file, a
  non-ASCII character — stops both entry points with a fixed message
  that never quotes the value. v0.0.16 only checked presence; undici then
  refused the header with `Headers.append: "Bearer <the whole value>" is
  an invalid header value`, and that text reached every tool error (any
  open-DCR caller), the startup log and the probe's `detail`, while
  /health called it a transient `network_error`. Two further layers
  stand behind the check: every fetch failure below HTTP (DNS, TLS,
  reset, an unbuildable request) becomes a fixed "transport error while
  calling Loomio (<class> <code>)" — the original message, which may
  quote a header or the host, reaches neither the caller nor a log — and
  every tool error, the probe's `detail` and `get_user_activity`'s
  relayed search error pass through `scrubSecrets()`, which replaces
  either configured value (or one line of a multi-line value) with
  `[redacted]`. An unbuildable request is classified `config_error`, not
  `network_error`.
- Every request also carries `User-Agent: loomiomcp/<version>`. That is
  not a secret; it exists so a WAF in front of Loomio can allow the
  connector explicitly and so instance operators can find it in logs.

**Key lifecycle.** The b2 key is not permanent: Loomio regenerates a
user's key whenever that user's password changes (Loomio ≥ 3.1.0), did
so for every user once in Loomio 3.3.1, and on account redaction; a
deactivated user's key stops authenticating. A rotated key makes every
call answer the generic 403 while the process looks healthy. The
connector therefore probes the key at startup and on `GET /health`,
classifies the 403 as "key rejected — rotated?", and emits a **forced**
`loomio.auth` event on every status change. None of those paths log or
return the key: the probe result carries `key_status`, `loomio_version`,
a closed-vocabulary `reason` and an operator-facing `detail`; the log
event carries `reason` and never `detail` (which may quote an upstream
body fragment or error message — the "no bodies in logs" invariant
holds for the forced events too); `/health`, `check_connection` and
every other tool result omit `detail` as well, so it reaches only the
startup stderr warning. The probe also keeps the parsed groups body it
received (the user's groups and own membership rows) in process memory
beside the verdict, for `check_connection` and for recognising the
user's own votes; it is never serialised by `/health` and never logged.
The runbook is in DEPLOY.md.

**What a leaked `LOOMIO_API_KEY` gives away, and when to rotate it.**
Loomio issues one key per user, carrying that user's full rights — there
are no scoped or read-only keys. Every protection in this file
(read-only mode, poll-visibility gating, the Markdown guard, e-mail and
billing redaction, the group allow-list, the budgets and quotas) lives
in the connector: it protects the connector's callers, not a holder of
the key. Whoever holds the key can, straight against Loomio and without
the connector, read everything the user can read UNREDACTED (hidden
`until_vote` results and reasons, member e-mails of every group it
administers or invited into), and write as the user wherever its role
allows — comment, start threads and polls, edit or discard what its
role permits, invite members where it is an admin or where a group lets
members add members. Loomio keeps no API-key usage log, and `/health`
notices only a key that STOPPED working, so a leaked key that keeps
working is invisible. Therefore:

- keep the user a plain member, never a group admin, and out of groups
  where members may add members (limits what a leak can write);
- rotate the key — change the Loomio user's password, which regenerates
  it, then update the deployment secret (DEPLOY.md runbook) — whenever
  it may have leaked (a log, a screenshot, a chat or AI transcript, a
  shell history, a CI log, a ticket, an editor's or agent's permission
  allow-list — `.claude/settings*.json` — or a shared or synced copy of
  an MCP host's config; the host's own private MCP config `env` block is
  the normal home of a stdio key), after any incident on a machine or
  account that held it, when
  someone with access to it leaves, and on a schedule;
- after a suspected leak, read what the user authored recently
  (`search_content` with `author_id` = the user's id from
  `check_connection` lists its 20 newest items): on a read-only
  deployment any of it is foreign. **With `LOOMIO_MCP_GROUP_IDS` set the
  connector hides items in unlisted groups and in direct threads** —
  exactly where a leaked key can post unseen — so run that search
  against Loomio itself instead (`GET /api/b2/search?author_id=<id>`
  with the key's `Authorization: Bearer` header read from a 0600 file,
  never typed on a command line), or through a local connector started
  without the allow-list.

The same holds, instance-wide, for the b3 secret (below), and the OAuth
signing key mints any token or client registration for this connector:
rotating `MCP_OAUTH_SIGNING_KEY` invalidates all of them (DEPLOY.md).

**Scope of the b3 secret.** The b3 Server API covers far more than the
operations this connector wraps: user update (including `is_admin`),
hard destroy and redact, in addition to deactivate / reactivate / show /
index and lookup by external identity. Since Loomio 3.13 the same
secret can also:

- create accounts (`POST /b3/users`), instance admins included
  (`is_admin` is a permitted field);
- enumerate every group on the instance, secret ones included;
- read every group's roster with every member's email;
- invite any syntactically valid address into any group — accounts are
  created on the spot, and invitation emails go out subject only to
  Loomio's delivery-time spam and suppression filters: no admin check,
  no per-actor rate limit. The instance's `SPAM_REGEX` still applies to
  NEW accounts, as the User model's validation: a matching address fails
  the whole call (422 "no spam") instead of being dropped silently as on
  b2;
- sync-remove a whole group's membership across its subgroups
  (`remove_absent`);
- grant or revoke the group admin role anywhere.

The secret authenticates the *server*, not a user, and Loomio applies
no per-user authorization to it. **Attribution:** the b3 membership
writes record no actor at all (no inviter, no revoker, no notification
actor; the role update's PaperTrail `whodunnit` is nil), and a b3
deactivation is recorded as the user deactivating themself. The
connector's `tool.call` log line (tool name, a 16-character tag of the
OAuth client_id — stable per registration —, argument NAMES, time) is
the only trail of who asked. The connector calls only
the routes listed under "b3 admin tools" below, but the *credential*
unlocks all of it on the Loomio side — one more reason it must never
sit on a shared deployment.

## Read-only mode

`LOOMIO_MCP_READONLY=1` skips registration of every write tool at MCP
server-init time — `create_discussion`, `update_discussion`,
`delete_discussion`, `create_poll`, `update_poll`, `delete_poll`,
`create_comment`, `update_comment`, `delete_comment`,
`manage_memberships` — and of every b3 tool, `get_user`, `list_users`,
`list_instance_groups` and `list_instance_memberships` included (they
return instance-wide data with emails, so they share the writes'
gate).
Belt-and-braces: even if a misbehaving MCP client asked for one, the
tool isn't in the catalog. The client-layer guard in
`src/loomio/client.ts` (`isReadOnly()` → throw before any request in
`loomioPost`, `loomioPatch`, `loomioDelete` and the b3 writes
`loomioPostB3` / `loomioPatchB3` / `loomioDeleteB3`, which share one
write path) is the second line of defence; `create_poll` checks it before its thread
resolution GET as well. `tests/readonly.test.ts` pins the advertised set
per mode by name.

## `manage_memberships` and `remove_absent`

`POST /b2/memberships` requires the connector's user to be an **admin
(coordinator) of that group** — Loomio answers
`403 {"error":"User is not an admin"}` otherwise; parent-group admin and
instance admin do not count.

With `remove_absent` set, Loomio REMOVES every existing group member
whose email is NOT in the supplied list. Per Loomio's controller that
includes **pending invitees** (not-yet-accepted memberships are still
"active"), the **connector's own user** if its email is absent (locking
the connector out of the group), and the same users' memberships in
every **subgroup** (`MembershipService.revoke` cascades). Loomio has no
server-side dry-run; the call is destructive on submit. The empty-list
(zero remaining emails after dedupe) case removes the entire group.

On the wire the connector sends `remove_absent: 1` (integer) when the
flag is true and omits the key otherwise: Loomio reads
`params[:remove_absent].to_i == 1`, and a JSON boolean would raise
`NoMethodError` → HTTP 500 *after* the invitations had already been
sent. The tool's own input stays a boolean.

**Case-sensitivity risk.** Loomio computes the members to remove as
`current_emails - params_emails` over the members' STORED addresses,
case-sensitively and without normalising the list. A member stored as
`alice@example.org` and listed as `Alice@example.org` is therefore
REMOVED even though the caller meant to keep them. Send the addresses
exactly as `list_memberships` returns them.

The `manage_memberships` tool:

- Defaults `remove_absent` to `false` (additive only).
- Carries the warning text in its tool description so MCP clients can
  surface it before invocation.
- Carries a `destructiveHint: true` annotation (set in
  `src/server/register-tool.ts`) so MCP clients that honour it (e.g.
  Claude Desktop) prompt before invoking.
- Should be called ONLY after reading `list_memberships` and confirming
  the diff with a human.

In multi-user / shared-key HTTP deployments, set `LOOMIO_MCP_READONLY=1`
to remove this tool from the catalog entirely.

## Soft deletes and replacing updates

`delete_discussion` / `delete_poll` / `delete_comment` call Loomio's b2
`destroy` actions, which are **soft discards**: `discarded_at` is
stamped, the title / body is nulled, the record leaves every list, and
an admin can restore it in Loomio's UI. Nothing is permanently erased
and the connector has no undo. They carry `destructiveHint: true`, their
descriptions say to confirm with the human first, and their results
carry `discarded: true` plus a note. `update_*` REPLACE the text passed
(no append) — the descriptions say to read first and send the whole new
body — and are idempotent; they carry `destructiveHint: true` as well,
because the MCP spec defines `false` as "performs only additive
updates" and an overwrite (or a shortened `closing_at`, a tightened
`hide_results`, a flipped `private`) is not additive. `update_poll`'s
`options` needs one more word: on the wire Loomio's `Poll#options=`
REPLACES the option set and hard-deletes every unlisted option together
with the votes cast on it, so the connector reads the poll's stored
`poll_option_names` first and PATCHes the union — the tool never removes
an option it SAW, at the cost of one extra call, and removal is not
offered. What the pre-read cannot close is the window between it and
the PATCH: an option another editor adds in that instant is absent from
the union and Loomio destroys it (with any votes already cast on it) on
200 with no signal — b2 has no atomic add-option primitive, no version
check (`versions_count` does not move on an option-only change) and the
echo reflects the post-destruction state. The window is one sequential
round-trip (Loomio's own web client submits the complete set the same
way over a minutes-long form); the tool and field descriptions name it
and tell the caller to avoid concurrent edits of one poll's options.
Authorization is Loomio's per-record rule
(author, thread admin, or a member where the group allows it); a refusal
is `403 "Not authorized to <action> <Model>."`, surfaced verbatim.

## b3 admin tools

Nine tools, all opt-in (registered only when `LOOMIO_B3_API_KEY` is set
and the server is not read-only). The four user tools —
`deactivate_user`, `reactivate_user`, `get_user` and `list_users` —
work on every supported Loomio; the five provisioning tools need
Loomio 3.13+ and were verified only against Loomio's source, tests and
documentation.

The user tools call the member routes
`POST /api/b3/users/{id}/deactivate` and `…/{id}/reactivate` (the
`?id=` collection routes are deprecated in Loomio's OpenAPI document),
`GET /api/b3/users/{id}`, `GET /api/b3/users/identity/{type}/{uid}` and
`GET /api/b3/users[?is_admin=]`, and affect or reveal users
instance-wide:

- `deactivate_user` carries the `destructiveHint: true` annotation.
  Loomio enqueues a `DeactivateUserWorker` and answers
  `{ success: true, user }` **immediately** — the echoed user may still
  show `active: true`. The worker then stamps `deactivated_at`, revokes
  the user's memberships, mobile devices and pending membership
  requests, and their undecided open-poll ballots (votes already cast
  are kept since Loomio 3.11). Loomio records the user as its own
  deactivator. There is no soft confirmation step.
- `reactivate_user` is synchronous: it clears `deactivated_at` and
  **restores the memberships and open-poll ballots the deactivation
  revoked**. It is the inverse of the above and isn't marked
  destructive.
- `get_user` and `list_users` return every account's **email address**
  (plus `is_admin`, `active`, `deactivated_at` and linked external
  identities) for any user on the instance, member of the connector's
  groups or not; `list_users` is the whole user table in one
  unpaginated response. That is why they are gated like the writes and
  documented as **single-tenant deployments only** — one organisation
  per Loomio instance. On a shared or hosted instance leave
  `LOOMIO_B3_API_KEY` unset.

The provisioning tools (`GET /api/b3/groups`, `GET /api/b3/memberships`,
`POST /api/b3/memberships`, `PATCH` / `DELETE /api/b3/memberships/{id}`):

- `list_instance_groups` lists every group on the instance, secret ones
  included; `list_instance_memberships` lists any group's roster with
  every member's email, whoever the connector's user is. Gated like the
  writes for that reason.
- `add_group_members` (`destructiveHint: false`, `idempotentHint:
  false`) invites up to 50 addresses per call into any group: unknown
  addresses become new unverified accounts and everyone added gets
  Loomio's invitation email. Its body is built field by field —
  exactly `{group_id, emails}` — under a strict schema, so
  **`remove_absent` is never sent** and cannot be smuggled in. The
  50-address cap is the connector's: b3 skips Loomio's per-actor
  invitation throttle (new accounts still pass the User model's
  `SPAM_REGEX` validation, which fails the whole call rather than
  dropping the address). A 422 is either a deactivated account or an
  address Loomio refuses to create; the error says which.
- `update_membership_roles` (`destructiveHint: true`) grants or removes
  `admin` / `delegate` on any membership; nothing stops demoting a
  group's last admin.
- `revoke_membership` (`destructiveHint: true`, idempotent) removes a
  person from a group AND its subgroups and threads and revokes their
  open-poll votes, cast ones included, without notification. A re-add
  restores the target group only, without the admin role.

**Never sent:** `remove_absent` on the b3 sync, `POST /b3/users`, the
user `PATCH` / `DELETE` / redact routes and their identity variants,
and the `PUT` aliases (README "Deliberately not exposed").

Never set `LOOMIO_B3_API_KEY` on a shared deployment or on any open-DCR
deployment (where anyone who completes the OAuth dance is a caller).
The HTTP entry enforces the open-DCR half: in `MCP_OAUTH_INSECURE_AUTO_APPROVE`
mode on a non-localhost `PUBLIC_BASE_URL` — or a loopback one with a
non-loopback `MCP_HTTP_BIND` (v0.0.17; v0.0.16 listened on every
interface while waiving the refusal for a loopback URL, so a "local"
server served the b3 tools to the LAN) — it refuses to start while the
secret is set and read-only mode is off (`b3ExposureError`,
src/http/config.ts; no override — use static-client mode), and on a
local-only server it logs a warning naming the nine tools. A shared deployment
in static-client mode cannot be detected and stays the operator's call.
The b3 secret authenticates the *server* as a Loomio instance operator,
not the calling user — any client that can reach the MCP server can
deactivate any user, read every email and roster, and invite or remove
members anywhere (and, see "Scope of the b3 secret" above, the same
credential does much more on the Loomio side).

## Upstream cost bounds

Every read is one upstream call unless stated (README.md has the table).
Since Loomio 3.11.1 pages the groups index and thread items (at most
500 rows per request), the connector follows those pages within fixed
per-call caps and flags a walk the cap stopped. The exact fan-out, for
abuse sizing:

- `get_user_activity` makes one `GET /b2/reports` per requested group
  (schema cap 50, at most 4 in flight) plus one search — N + 1 calls
  per invocation. The 0.0.11 per-discussion fan-out (~200 calls) and the
  `list_groups` id probe (50–500 calls) are gone.
- `list_groups`: 1 call per 500 member groups, at most 20.
- `check_connection`: the health probe's two requests, and no extra
  call up to 50 member groups; beyond that 1 per further 500, at most
  20.
- `list_thread_items`: at most 2 item requests without `kinds` (one per
  500 items of the window, `limit` ≤ 1000), at most 10 with `kinds`
  (the thread from its start, 5 000 items), +1 by `discussion_id` /
  `poll_id`.
- `get_discussion` with `include_items`: 2, +1 per further 500 embedded
  items — at most 3 (`items_limit` ≤ 1000).
- `get_thread_markdown`: 2, +1 per 500 items (at most 10) when the
  vote-visibility guard scans the thread's items — any thread holding
  more than its opening item, unless the guard's read already refuses;
  a refusal skips the document. On Loomio 3.8 / 3.9 (guard skipped): 2,
  or 4 when the health probe behind that decision has to be re-run
  (at most once a minute).
- b3: `list_instance_groups` / `list_instance_memberships` 1 per page
  of ≤ 50; each write 1.
- On Loomio before 3.11.1 every one of these paged reads is a single
  request (Loomio returns the whole collection; the connector detects
  it and stops), so its SIZE scales with the thread or group count;
  `body_max_chars` and the `max_total_chars` reply budget (default
  120000 shaped characters) bound what is returned to the client, not
  what Loomio sends.
- `search_content` is capped by Loomio at 20 results (a query search
  shows at most 19, above); `list_threads` at
  100 per page (under `LOOMIO_MCP_GROUP_IDS` it walks at most 10 pages
  of 100 to fill one window: ≤ 10 calls); the list tools at 200 per page.
- **Absolute ceilings** (v0.0.17): one upstream response body at most
  64 MB (a declared larger `Content-Length` is refused unread, a stream
  is cut when it passes the limit) and one tool reply at most 4 MB of
  serialised JSON — the per-tool caps can be lifted by the caller
  (`limit: 1000, body_max_chars: -1, max_total_chars: -1`), and the
  review read two 50 MB pages into a ~100 MB reply. Every free-text
  input is length-capped too (keys and handles 128 characters, `query`
  512, tags 128, `kinds` 32 × 64, titles 500, bodies Loomio's default
  `max_message_length` of 100 000), so an oversized argument is refused
  by the schema instead of costing an upstream request. A `Retry-After`
  header is echoed in a 429 message only when it is delta-seconds (≤ 6
  digits) or an HTTP-date.
- **Per HTTP request**, whatever it contains: one `POST /mcp` may start
  at most `MCP_HTTP_UPSTREAM_BUDGET` (default 120) Loomio requests. The
  figures above are per tool CALL, and before v0.0.17 a JSON-RPC batch
  of up to 100 calls in one POST multiplied them (100 ×
  `get_user_activity` over 50 groups = 5,100 upstream requests, 500 in
  flight, for one limiter token). A batch now shares one budget, and a
  client declaring MCP 2025-06-18 or later — the revision that dropped
  batching — gets a 400 for an array. Every `tool.chain` event records
  the batch size.
- **Cancellation.** When the HTTP client disconnects (closes the
  response), the connector aborts that request's in-flight Loomio
  requests and sends no further one; before v0.0.17 a disconnected
  request ran to completion. A `notifications/cancelled` aborts a call
  on **stdio** (one long-lived server) and within one pre-2025-06-18
  batch; over stateless HTTP it arrives in a later POST, which a fresh
  server instance answers without knowing the running call, so the call
  runs on — bounded by the budget, the timeout and the limits below
  ("Accepted risks").
- **Per process, concurrency**: at most `MCP_HTTP_UPSTREAM_CONCURRENCY`
  (default 16) Loomio requests in flight, with a bounded wait queue (32
  per slot) that fails fast when full. The queue is **fair across source
  addresses**: served round-robin over sources, one source may hold at
  most three quarters of the slots and queue at most 8 calls per slot.
  With one shared FIFO (the first v0.0.17 cut) a handful of POSTs from
  one address, far under its rate limit, kept every other caller waiting
  ~26 s per call or failing busy.
- **Per process, rate**: at most `MCP_HTTP_UPSTREAM_PER_5MIN` (default
  900) Loomio requests in any 5 minutes, one source at most half of
  them; past it a call fails fast and is never sent. A concurrency cap
  is not a rate (16 slots at 300 ms are ~50 calls a second), and Loomio
  itself throttles 900 requests per 5 minutes per client IP
  (Rack::Attack, `text/plain` 429) for EVERY request from that address:
  without this bound one caller inside every other limit (300 POSTs of
  `get_user_activity` reached 771 Loomio calls in 0.3 s in the review)
  made Loomio answer every caller 429 for up to 5 minutes and turned
  `/health` red. Several instances that reach Loomio through ONE egress
  address share its 900: set the knob to 900 ÷ max instances there.
- **The health probe** is exempt from the budget, cancellation, the
  queue and the rate refusal (it is counted in the rate window) — a
  probe failing for somebody else's request would cache `unreachable`
  and turn `/health` red for everyone. It is bounded on its own: at most
  one request pair per minute from `/health` and the tools, at most one
  per 10 s however often `check_connection` is called (below), never
  more than one in flight per process.
- A caller could still invoke any of these repeatedly; the `/mcp` rate
  limiter (keyed on source IP) bounds invocation rate, the upstream rate
  window bounds what reaches Loomio, and in open-DCR mode the daily
  quotas bound volume. Size `MCP_HTTP_RATE_LIMIT_MAX` accordingly —
  remembering that every limit and quota is per connector process (N
  instances: up to N times). A Loomio 429 is mapped to a clear error
  rather than retried.

## Key-health probe and `/health`

`src/loomio/health.ts` issues an authenticated `GET /api/b2/groups` (200
→ `valid`; 403 with Loomio's unauthenticated body → `rejected`; anything
else → `unreachable`) and the public, credential-free
`GET /api/v1/boot/version`. The result is cached 60 s and shared between
concurrent callers, so neither `/health` nor the tools that consult the
cached verdict can be used to make the connector hammer Loomio.
`check_connection` is the deliberate exception: it wants a probe at most
10 s old (its job is a verdict after a 403 or an empty list, where a
minute-old "valid" would mislead), so it re-probes when the cached one
is older — one request pair per 10 s per process at most, however often
it is called; concurrent callers share one in-flight probe. Before
review round 1 it forced a fresh pair on EVERY call, uncharged to the
per-request budget.

`GET /health` (HTTP transport, `src/http/health.ts`) is unauthenticated
by design — uptime checkers cannot do OAuth — and returns exactly
`{status, connector_version, key_status, loomio_version, checked_at}`
with `Cache-Control: no-store`, HTTP 200 iff `key_status === "valid"`,
else 503. It never includes the key, the probe's `detail` text (which
may quote the configured base URL), the Loomio hostname, or the groups
body the probe keeps in memory. It sits behind the same per-IP rate
limiter as `/mcp` (separate bucket). The connector's own version is
disclosed; that is deliberate (it is public on npm) and lets an operator
confirm what is deployed. So is `loomio_version`: Loomio serves the same
string to anyone, without a credential, at `GET /api/v1/boot/version`
(the probe's own request), so the page adds nothing a caller who knows
the instance cannot fetch — and the hostname that would identify the
instance is never shown. Like every limiter, the page's is per process.

## OAuth

The HTTP transport's access and refresh tokens (under `src/auth/`) are
HMAC-signed and stateless — and so are open-DCR **client registrations**
(the `client_id` is a signed blob, `StatelessClientsStore`) and, since
v0.0.17, **authorization codes**. Nothing OAuth-related needs shared
storage: a registered client survives restarts, scale-to-zero, redeploys
and multi-instance routing, and the `/authorize` (browser) and `/token`
(MCP client backend) legs may reach different instances. Rotate
`MCP_OAUTH_SIGNING_KEY` (≥ 32 characters) to invalidate every token,
registered client and pending code at once. A 16–31-character key —
v0.0.16's floor — still starts, with a startup WARNING, until
2027-01-31 00:00 UTC (refusing it on upgrade would have logged every
user out), and is refused at the first start after that: rotate it
before then.

- **Domain separation.** Each artefact kind is MACed with its own
  HKDF-SHA256 sub-key of the signing key (`loomiomcp/v2/access`,
  `…/refresh`, `…/client`, `…/code`; client secrets `…/client-secret`),
  carries a `v2.` version tag inside the MAC, a random nonce, and is
  parsed with a strict schema — a refresh token, client_id or code never
  verifies as anything else. Artefacts issued by v0.0.16 (one raw-key
  HMAC for everything) are still accepted until 2027-01-31 00:00 UTC so
  nobody is forced to re-authenticate by the upgrade, then refused.
- **Codes.** PKCE S256 only, challenge exactly 43 base64url characters,
  verifier 43–128 unreserved characters; a code is bound to the client,
  challenge, redirect_uri and resource and lives 5 minutes. Single use is
  enforced per instance (a used-nonce set); a replay that reaches another
  instance inside the TTL needs the same client credentials and verifier,
  so it only re-issues tokens to their holder. Any `/token` request that
  presents a code and gets past the per-IP limiter but does not end in a
  200 — wrong verifier, client, client secret or redirect_uri, a missing
  or malformed field — burns the code, and every rejected code reads the
  same (`invalid_grant`, "invalid
  authorization code"), so a code's liveness or owner is not disclosed.
  `redirect_uri` is required at `/token` whenever the authorization
  request carried it.
- **Refresh.** Refresh tokens are not rotated on use and cannot be
  revoked one by one (that needs a shared reuse store); each chain
  carries the time the user last completed `/authorize` and ends 90 days
  later. In static-client mode every refresh also needs the current
  `MCP_OAUTH_CLIENT_SECRET`, so rotating it cuts all callers off at once.
- **Redirects (open DCR).** A self-registered client may redirect only to
  Anthropic's callback URIs (claude.ai's, and the announced
  `https://claude.com/api/mcp/auth_callback`, exactly), loopback http(s)
  on any port and path (RFC 8252 §7.3), private-use app schemes (RFC 8252
  §7.1) and https hosts the operator lists in `MCP_OAUTH_REDIRECT_HOSTS`.
  App schemes exclude a deny-list: script and local-document schemes
  (`javascript:`, `data:`, `file:`, `blob:`, `about:`, `view-source:` …),
  other network protocols (`ftp:`, `ws:`, `smb:`, `ldap:`, `ssh:` …),
  messaging (`mailto:`, `tel:`, `sms:` …), browser-internal pages, and
  the OS / browser protocol handlers that are launchers rather than app
  callbacks — every `ms-*` (`ms-excel:ofe|u|https://…` opens a remote
  workbook), `search-ms:`, `shell:`, `itms-services:`, `intent:`,
  `web+*` and the like, so the connector's origin cannot 302 a browser
  into "open this app on that remote file". A deny-list is never
  complete — an unknown launcher scheme still passes (accepted risk);
  no fragment, no userinfo, ≤ 10 URIs of ≤ 512 characters. The policy is
  re-checked whenever a client_id is used, so a registration signed
  before it existed cannot keep redirecting elsewhere. Before v0.0.17 the
  connector's origin was an open redirect for any registrant; setting
  `MCP_OAUTH_REDIRECT_HOSTS=*` makes it one again for https targets.
- **Registration and `/token` bounds.** `client_name` and `scope` ≤ 256
  characters and a signed client_id ≤ 2 KB, refused with
  `invalid_client_metadata`. `/token` sub-paths answer 404, and a per-IP
  limiter (50 per 15 minutes, per process) runs before client
  authentication, so failed secrets are counted.

In open-DCR mode the OAuth dance proves protocol conformance, not
identity (see the multi-user posture section above); the `/mcp` rate
limiter is keyed on source IP precisely because client ids are
caller-mintable in that mode. See DEPLOY.md.

## Supply chain

What a release is made of, and how to check it (v0.0.17):

- **npm package.** Published only by `.github/workflows/publish.yml`
  on a GitHub release, through npm trusted publishing (OIDC — no npm
  token exists to steal) with a provenance attestation: `npm audit
  signatures`, or the package page on npmjs.com, ties each version to
  the exact commit and workflow run that built it. The job runs every
  CI gate plus `npm audit` on the release commit, installs dependencies
  with `--ignore-scripts`, and publishes the `dist/` it just tested. A
  CycloneDX SBOM generated from the lockfile is attached to the GitHub
  release. The tarball holds `dist/`, `README.md`, `LICENSE` and
  `package.json` only (no sources, tests or source maps).
- **Dependencies.** `package-lock.json` (v3, integrity hashes on every
  package) is the only install source; Dependabot proposes npm, GitHub
  Actions and Docker updates weekly, minor and patch grouped, each new
  version held back a week first.
- **CI.** Third-party GitHub Actions are pinned by commit SHA, not tag;
  workflows run with `contents: read` unless a job needs more (the
  publish job: `id-token: write`; the SBOM upload: `contents: write`,
  running no dependency code).
- **Container image.** The `Dockerfile` pins its `node:22-slim` base by
  digest, installs with `--ignore-scripts`, ships production
  dependencies only, runs as `USER node` with `NODE_ENV=production`, and
  `.dockerignore` keeps `.env*`, `.npmrc`, `*.local.*`, the local
  live-test scripts, tests and git metadata out of the build context.
  Pass `--build-arg VCS_REF=$(git rev-parse HEAD)` to label the image
  with its commit. This repository publishes no image: whoever builds
  and deploys one owns pinning the DEPLOYED digest in reviewed
  configuration, signing it, and recording which commit it came from.

## Accepted risks

What this release does not close, deliberately or for want of a
mechanism — each with its bound:

- **Open DCR is not an identity boundary.** Anyone who reaches an
  open-DCR URL is a caller; the OAuth dance proves protocol conformance
  only. Use static-client mode where callers must be known.
- **The connector user's groups are public through it.** Rosters (ids,
  names, roles, join state), per-member participation counts (former
  members included) and every thread of every member group reach every
  open-DCR caller. Narrow it with `LOOMIO_MCP_GROUP_IDS` or with the
  user's memberships; nothing narrows it further.
- **Coordinators still change exposure.** Without
  `LOOMIO_MCP_GROUP_IDS` any coordinator can widen what the connector
  serves; with it, a coordinator of a LISTED group can still start a
  private thread there or promote the user. `loomio.groups_changed` and
  `loomio.admin_scope` report membership, admin and privacy changes —
  after the fact, per process, compared with that process's previous
  probe and over the first 50 groups of the index (beyond them, only a
  changed total). A change made while no instance runs (scale to zero)
  becomes the next process's baseline and is not reported; a new
  private thread is never reported.
- **Every limit and quota is per process, and per source address.**
  Rate limits, daily quotas, the concurrency cap and the used-code set
  live in memory: N instances allow up to N times each figure, a cold
  start resets them, and a caller with many addresses multiplies them
  again. No shared store ships. The `RateLimit` response headers tell a
  caller its remaining budget; that helps well-behaved clients back off
  and tells an abuser nothing it could not measure. Conversely, many
  users behind ONE address share a bucket: every hosted-Claude user
  arrives from Anthropic's egress range. Without
  `MCP_SHARED_EGRESS_CIDRS` one of them can spend the daily quotas
  (5 000 calls, ~17 minutes) or the upstream rate share (~14
  `get_user_activity` calls on a 10-group allow-list at a window of 300)
  for all the others on that address and instance, until 00:00 UTC for
  the quotas. With it, those buckets are per client under an address
  aggregate — a cost increase (client_ids are free, if rate-limited, to
  mint), not identity — and the `/mcp` request-rate limiter (one
  minute) remains shared per address.
- **The upstream rate is shared by every caller.** All traffic reaches
  Loomio as one user from the connector's egress. The per-process rate
  window (`MCP_HTTP_UPSTREAM_PER_5MIN`, default 900 = Loomio's own
  per-address throttle) keeps one process under Loomio's limit and one
  source to half of it, so the probe and `/health` stay green — but
  callers that together reach the window are refused until it slides
  (at most 5 minutes), and several instances behind ONE egress address
  exceed Loomio's 900 unless the knob is divided by their number.
- **Codes are single-use per instance.** A code replayed to ANOTHER
  instance within its 5 minutes is accepted once more there — only from
  someone holding the same client credentials and PKCE verifier, so it
  re-issues tokens to their holder.
- **Refresh tokens are not rotated and not revocable one by one.** A
  stolen refresh token works until its chain's 90-day horizon; the
  remedies are global (rotate `MCP_OAUTH_SIGNING_KEY`; in static-client
  mode also `MCP_OAUTH_CLIENT_SECRET`). v0.0.16 tokens and client
  registrations stay valid, under v0.0.16's single-key construction,
  until 2027-01-31 00:00 UTC; a v0.0.16 refresh chain's horizon counts
  from that token's issue.
- **Native redirects stay open by design.** Loopback and private-use
  scheme redirects (RFC 8252) are allowed for desktop and mobile
  clients, and any app on a device can claim a custom scheme; the code
  such a redirect carries is useless without the client's PKCE
  verifier. `MCP_OAUTH_REDIRECT_HOSTS=*` re-opens the https open
  redirect for whoever sets it.
- **Hidden and missing differ for static clients.** Only open-DCR mode
  merges the 403 / 404 wording; a static-client deployment keeps the
  precise diagnostics for its known callers.
- **`search_content` at Loomio's 20-result cap.** A query search shows
  at most 19 rows so that ONE withheld hit (a hidden vote reason, or a
  hit outside the allow-list) cannot be told from a 20th visible one;
  two or more withheld hits in Loomio's first 20 still shorten the page,
  which a caller who can see 20+ other matches of the same terms can
  notice (on a writable deployment it can create them) — it learns that
  withheld items match, never which or what. `capped` can read false
  when Loomio had more behind such hits.
- **`notifications/cancelled` does not reach a running HTTP call.** The
  stateless HTTP transport serves every POST with a fresh server, and a
  cancel arrives in a later POST, so only a disconnect stops the work;
  a cancelled call runs on within the per-request budget, the 60 s
  deadline and the process limits. A cancel cannot be used to gain
  anything; honouring it would need a process-wide map of running calls
  keyed by client and JSON-RPC id.
- **The redirect deny-list is a list.** App-scheme redirects are allowed
  by default and the launcher schemes refused are the known families;
  an OS or browser handler the list does not name would still receive
  the 302 (behind the browser's own "open this app?" prompt).
- **`/health` names both versions.** `connector_version` (public on
  npm) and `loomio_version` (public at Loomio's `/api/v1/boot/version`)
  are disclosed without a credential; the Loomio hostname is not.
- **`MCP_HTTP_DEBUG` is a local knob.** Set on a shared deployment it
  writes clipped upstream text into the operator's logs.
- **Writable deployments relay member e-mails** of groups the user
  administers (`manage_memberships`' `remove_absent` needs them), and
  the b3 secret in static-client mode on a public URL is allowed — the
  client secret is the gate there, and no startup warning fires.
- **The Loomio key is unscoped and its misuse is invisible** (API key
  handling, above); **Loomio content can carry prompt injections**
  (above). Neither can be fixed in the connector.
- **The deployment is the operator's.** Which image digest runs, who can
  build or deploy it, how secrets reach it, what the runtime identity
  may do, and how long platform request logs (caller IP, user agent) are
  kept are decided outside this repository.

## Reporting

Open an issue or contact the maintainer directly.
