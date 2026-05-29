# Changelog

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
