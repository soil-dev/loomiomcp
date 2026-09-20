import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasB3ApiKey, isReadOnly } from "./loomio/client.js";
import { ICONS } from "./icon.js";
import { registerTool } from "./server/register-tool.js";
import { VERSION } from "./version.js";

import {
  getDiscussionSchema,
  getDiscussion,
  createDiscussionSchema,
  createDiscussion,
  listDiscussionsSchema,
  listDiscussions,
} from "./tools/discussions.js";
import {
  getPollSchema,
  getPoll,
  createPollSchema,
  createPoll,
  listPollsSchema,
  listPolls,
} from "./tools/polls.js";
import {
  listMembershipsSchema,
  listMemberships,
  manageMembershipsSchema,
  manageMemberships,
} from "./tools/memberships.js";
import { listGroupsSchema, listGroups } from "./tools/groups.js";
import {
  listEventsSchema,
  listEvents,
  getUserActivitySchema,
  getUserActivity,
} from "./tools/events.js";
import { createCommentSchema, createComment } from "./tools/comments.js";
import {
  deactivateUserSchema,
  deactivateUser,
  reactivateUserSchema,
  reactivateUser,
} from "./tools/admin.js";

/**
 * Build an `McpServer` configured for one inbound HTTP request (or one
 * stdio session). Reads `isReadOnly()` at construction time so writes
 * are skipped at registration when `LOOMIO_MCP_READONLY` is set. The
 * b3 admin tools are registered only when `LOOMIO_B3_API_KEY` is set
 * (Loomio instance-operator secret).
 */
export function createLoomioMcpServer(): McpServer {
  const readOnly = isReadOnly();
  const b3Enabled = hasB3ApiKey();

  const server = new McpServer({
    name: "loomiomcp",
    // Single source of truth in src/version.ts; tests/version.test.ts
    // pins it to package.json so the two can no longer drift.
    version: VERSION,
    description:
      "MCP server for Loomio (loomio.com / self-hosted). Wraps Loomio's b2 public API: read and create discussions, polls, and comments; list and manage group memberships; read per-discussion event streams; and aggregate a user's participation across groups. Read-only mode supported via LOOMIO_MCP_READONLY=1 (Cloud Run pattern). Optional b3 admin operations (deactivate / reactivate user) when LOOMIO_B3_API_KEY is set — instance operators only. Read tools annotated with readOnlyHint so MCP clients can auto-approve safe calls; destructive writes (manage_memberships with remove_absent, deactivate_user) carry destructiveHint.",
    websiteUrl: "https://github.com/soil-dev/loomiomcp",
    icons: ICONS,
  });

  // ── Discussions ───────────────────────────────────────────────────────────

  registerTool(
    server,
    "get_discussion",
    "Fetch a single Loomio discussion (thread) by id or short string key. Returns the full record — title, description, group, author, ranges/last-activity timestamps, and embedded users — in one round-trip. Use for 'show me discussion X', 'what's in thread Y', or to resolve an id_or_key referenced by another tool's output. To enumerate a group's discussions instead of fetching one, use list_discussions.",
    getDiscussionSchema,
    getDiscussion,
  );

  registerTool(
    server,
    "list_discussions",
    "List discussions in a Loomio group, ordered by latest activity. Required: `group_id`. Optional `status` filter — 'open' (unlocked; the connector's DEFAULT, sent explicitly because Loomio's own default when the parameter is absent is every kept thread including locked ones), 'closed' (locked), 'all' (every kept thread, locked or not); `limit` 1-200 (Loomio default 50); `offset` for pagination. The connector's user must be able to see the group (member, or the group is publicly visible). Use to answer 'what's being discussed in group X', 'show me recent threads', or before create_discussion to check for duplicates. For one specific thread, use get_discussion.",
    listDiscussionsSchema,
    listDiscussions,
  );

  if (!readOnly) {
    registerTool(
      server,
      "create_discussion",
      "Create a new Loomio discussion (thread) in a group. Required: `title`, `group_id`. The `private` field is auto-resolved from the group's `discussion_privacy_options` when omitted (matches Loomio's web UI default — public_only → false, anything else → true); pass it explicitly to override. Optional `description` + `description_format` ('md' / 'html') set the body. Notification recipients can be specified via `recipient_audience: 'group'` (notify all members), `recipient_user_ids` (explicit user ids), or `recipient_emails` (invite new people), optionally with a `recipient_message`. Caller must be allowed to start discussions in the group.",
      createDiscussionSchema,
      createDiscussion,
    );
  }

  // ── Polls ─────────────────────────────────────────────────────────────────

  registerTool(
    server,
    "get_poll",
    "Fetch a single Loomio poll (proposal / vote / multi-choice / score / ranked_choice / meeting / dot_vote) by id or short string key. Returns the poll record — title, type, options, closing state, voter visibility settings, and embedded author. Use for 'show me poll X', 'what's the result of Y', or to follow up on a poll id referenced elsewhere. To enumerate a group's polls, use list_polls.",
    getPollSchema,
    getPoll,
  );

  registerTool(
    server,
    "list_polls",
    "List polls in a Loomio group, ordered by creation date (newest first). Required: `group_id`. Optional `status` filter — 'active' (default), 'closed', 'all' (every kept poll); `limit` 1-200 (default 50); `offset` for pagination. The connector's user must be able to see the group (member, or the group is publicly visible — Loomio ≥ 3.8 lets any authenticated user read public groups' public polls); otherwise Loomio answers the generic 403. Use to answer 'what's up for vote in group X', 'show me past poll results', or before create_poll to check what's already proposed. " +
      "FOR PER-USER PARTICIPATION QUESTIONS — 'who voted', 'how often did X vote', 'compare members' turnout' — prefer `get_user_activity`. It returns participation directly (via the underlying events stream) and avoids the ambiguity between 'didn't vote' and 'abstained' that you can't tell apart from a `list_polls` response alone. (Caveat: `get_user_activity` currently fails against Loomio ≥ 3.4.0 — see its description; on such instances `list_polls` + `get_poll` is what is available.)",
    listPollsSchema,
    listPolls,
  );

  if (!readOnly) {
    registerTool(
      server,
      "create_poll",
      "Create a new Loomio poll. Required: `title`, `poll_type` — one of 'proposal' (built-in agree / disagree / abstain), 'poll' (single-choice), 'count' (count signers), 'score' (1-5 rating, configurable via min_score / max_score), 'ranked_choice' (STV), 'meeting' (time poll), 'dot_vote' (point allocation, see dots_per_person). For every type except 'proposal' you MUST supply `options` (array of strings). Either supply `group_id` for a standalone poll or `discussion_id` to attach to an existing thread. Optional: `details` + `details_format`, `closing_at` (ISO-8601), `anonymous`, `hide_results` ('off' / 'until_vote' / 'until_closed'), `specified_voters_only`, `shuffle_options`, `notify_on_closing_soon`, recipient fields. " +
        "NOTE: on Loomio ≤ 3.0.x this call 422'd with an empty errors hash in groups configured public-discussions-only (the poll's auto-created Topic defaulted to `private: true`). Loomio ≥ 3.1.0 derives the topic's privacy from the group's policy when `private` is omitted (`TopicService.private_default`), so it should work in every group; not yet re-verified live (0.0.12). See NOTES-ON-LOOMIO-API.md, Gotcha 3.",
      createPollSchema,
      createPoll,
    );
  }

  // ── Memberships ───────────────────────────────────────────────────────────

  registerTool(
    server,
    "list_memberships",
    "List the members of a Loomio group: user ids, names, usernames, roles (`admin` / `delegate` flags, `title`) and join state (`accepted_at`; null = invited but not yet accepted). Required: `group_id`. ANY member of the group can list its roster — no admin role is needed. Email addresses (`user_email`) are included only for groups where the connector's user is an admin (coordinator), and for members it invited itself; for other groups the roster comes back without emails, silently. If the connector's user is NOT a member of the group (or the group is hidden from it), Loomio answers 200 with an EMPTY list rather than 403 — the connector then adds `scope.note` saying so. Never report an empty list as 'the group has no members'. Optional `limit` 1-200 (default 50) and `offset` for pagination. Use to answer 'who's in group X', 'who are the coordinators', 'find a member by email' (admin groups only), or — critically — BEFORE calling manage_memberships with remove_absent=true, since the diff between current and intended members is what makes that destructive call safe. " +
      "Do NOT use this tool to construct a participation analysis (e.g. 'how active is each member', 'who voted in our polls') by combining its output with `list_polls`. That reconstruction is more expensive in round-trips AND ambiguous about abstain-vs-didn't-vote. Use `get_user_activity` per member instead — it answers participation directly from the event stream (where the Loomio version still supports it; see that tool's description).",
    listMembershipsSchema,
    listMemberships,
  );

  registerTool(
    server,
    "list_groups",
    "List groups visible to the connector's api-key user, by probing a group_id range: one `b2/polls?group_id=N&limit=1&status=all` per id, collecting the group objects side-loaded in the 200 responses — 404 (no such group) skipped, 403 (not visible) treated as a soft miss. Loomio 3.8 does have a native GET /api/b2/groups; this connector adopts it in v0.0.12. " +
      "Scope: every group the connector's user is a **member** of, plus publicly visible groups (Loomio ≥ 3.8 lets any authenticated user read public groups), plus subgroups visible to parent-group members. Parent groups are NOT discovered through their subgroups: Loomio side-loads a subgroup's parent under `parent_groups` (with no visibility check on it), which this probe does not read, so a parent is found only when its own id is probed (and it has polls); the subgroup's `parent_id` is returned for navigating up. Instance `is_admin` does NOT widen the scope — Loomio's User API ignores it; an instance admin sees exactly the groups it belongs to. " +
      "CAVEAT — groups with NO polls are not discovered: the group object reaches the response only as a side-load of the polls that reference it, so a poll-less group looks like a miss even when the user can read it. A group missing from this list is therefore NOT proof the user cannot see it. " +
      "Empty result: if the scan finds nothing and the connector's key-health probe reports the API key rejected (rotated), the tool THROWS instead of returning `groups: []`; otherwise an empty result carries `scanned.note` explaining what it can and cannot mean. " +
      "Optional knobs: `start_id` (default 1), `end_id` (default 200; a single call may scan at most 500 ids), `stop_after_consecutive_misses` (default 50; early-exit on sparse id ranges). " +
      "Cost: this is the right tool to answer 'what groups can you see' and similar discovery questions, but it costs O(end_id - start_id) outbound calls — typically ~50–200 HTTP requests in 2–5 seconds. The returned group objects are slimmed to `{id, key, handle, name, parent_id, discussion_privacy_options, is_visible_to_public, memberships_count}`; to drill in, use `list_memberships`, `list_discussions`, `list_polls` with the relevant id.",
    listGroupsSchema,
    listGroups,
  );

  // ── Events ────────────────────────────────────────────────────────────────

  registerTool(
    server,
    "list_events",
    "KNOWN LIMITATION: Loomio ≥ 3.4.0 (August 2026) REMOVED the v1/events endpoint this tool reads (the Event model became TopicItem). Against such an instance — including the current Loomio release — this tool fails with a clear error instead of returning an empty stream; the port to GET /api/b2/threads/{topic_id}/items is planned for v0.0.12. Check the error text before concluding a discussion has no activity. On a Loomio older than 3.4.0 it works as described: " +
      "Fetch the event stream for ONE discussion — new_comment, poll_created, stance_created, outcome_created, reaction, discussion_moved, etc. — with actor_id, kind, parent_id, created_at, and pointers to the underlying eventable record. Required: `discussion_id`. By default the connector paginates Loomio's v1/events endpoint up to a bounded cap and returns `scope.complete`; if you pass `limit` and/or `offset`, it returns exactly that one page. Optional `kinds` filters client-side after fetch. The response also embeds related `comments`, `users`, and `polls` arrays for in-place resolution. Use this to answer 'show me the reply tree for thread X', 'who participated in discussion Y', or as the building block for cross-discussion aggregations. " +
      "Loomio's v1/events endpoint REQUIRES a discussion_id; there is no instance-wide, per-group, or per-user index. For user-centric questions across many discussions ('how active is X', 'compare members across groups'), use `get_user_activity` — do NOT loop `list_events` over every discussion yourself. `get_user_activity` does that fan-out server-side with concurrency control.",
    listEventsSchema,
    listEvents,
  );

  registerTool(
    server,
    "get_user_activity",
    "KNOWN LIMITATION: Loomio ≥ 3.4.0 (August 2026) REMOVED the v1/events endpoint this tool aggregates from (Event → TopicItem). Against such an instance — including the current Loomio release — the call fails with a clear error on the first discussion probed, and NEVER returns zero counts as if the user had been inactive; the port to GET /api/b2/threads/{topic_id}/items is planned for v0.0.12. Report that error as 'not available on this Loomio version', not as 'no activity'. On a Loomio older than 3.4.0 it works as described: " +
      "Aggregate one user's activity across a set of groups. Server-side: fans out across every discussion in the specified groups, fetches its event stream, filters to events authored by the target user, and returns counts (by kind, by group, by month), plus first/last activity timestamps and a sample of recent events. Required: `user_id`, `group_ids` (1-50; pass the result of `list_groups` for instance-wide). Optional `since` / `until` (ISO-8601) bound the time window; `until` must be later than `since` when both are supplied. " +
      "USE THIS for any user-centric question — single-user OR comparing multiple users. Examples that all map to this tool: 'tell me about user X', 'how active has Y been in Q1', 'compare participation across two groups (e.g. two teams or committees)', 'rank members of group N by participation', 'who's the most engaged contributor since June', 'build a participation card for each member'. For an N-user comparison, **call this tool N times** (once per user) — that's the intended pattern and is materially cheaper than reconstructing the same data from `list_polls` + `list_memberships`. " +
      "Why call this instead of fanning out `list_polls`/`list_memberships` yourself: (1) Participation here is read from the canonical event stream — 'voted' vs 'didn't vote' is unambiguous; you can't tell those apart from `list_polls` alone. (2) Round-trip count is the same or lower in aggregate, because each user's activity scan reuses the same `list_discussions` fetches in your conversation context. (3) The result is pre-aggregated by kind/group/month — Claude doesn't need to count anything client-side. " +
      "Cost: one outbound HTTP call per discussion in scope (plus one `list_discussions` per group). A single user-activity call on a ~200-discussion instance is ~200 calls in 5-10 seconds, concurrency-capped at 6. That sounds large but is the correct denominator for comparison: building the same answer from `list_polls` requires the same discussion-scan + a separate `list_memberships` per group + client-side cross-referencing. The fan-out is bounded by a global cap, so a single call can't run away. " +
      "COMPLETENESS: check `scope.complete`. When it's false the counts are a LOWER BOUND — inspect `scope.groups_failed` (groups the connector's user couldn't read, e.g. it isn't a member), `scope.groups_truncated` (a group's discussion listing hit the page cap), `scope.discussions_failed`, `scope.discussions_truncated` (very long threads), and `scope.discussions_capped` (scan hit the global ceiling). Report partial results as partial; don't present them as the whole picture. A TOTAL failure (every group listing failed, or every event stream failed) is thrown as an error rather than returned as zeros. " +
      "For one discussion at a time, use `list_events`. For 'what groups can the user see', use `list_groups` first to scope the call.",
    getUserActivitySchema,
    getUserActivity,
  );

  if (!readOnly) {
    registerTool(
      server,
      "manage_memberships",
      "Invite users to a Loomio group by email and (optionally) REMOVE members not in the supplied list. Required: `group_id`, `emails` (array of email addresses). REQUIRES the group admin (coordinator) role on THAT group for the connector's user — Loomio answers 403 \"User is not an admin\" otherwise; being an admin of the parent group or an instance admin does not count. Default mode is additive: every address in `emails` that isn't already a member is invited / added; no existing member is touched. " +
        "DANGEROUS OPTION — `remove_absent: true`: Loomio REMOVES every existing group member whose email is NOT in `emails` — that includes pending invitees, it cascades to the group's subgroups, and it removes the connector's OWN user if its email is absent (locking the connector out of the group). The zero-or-stale-emails case can wipe the entire group. There is no server-side dry-run and no undo. ALWAYS call list_memberships first, compute the diff explicitly, and confirm with a human before invoking with remove_absent=true. " +
        "Returns `{added_emails: [...], removed_emails: [...]}` listing exactly what changed.",
      manageMembershipsSchema,
      manageMemberships,
    );
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  if (!readOnly) {
    registerTool(
      server,
      "create_comment",
      "Post a comment (reply) on an existing Loomio discussion. Required: `discussion_id`, `body`. Optional `body_format` ('md' or 'html'; defaults to the group's setting). Caller must be permitted to post in the discussion's group. Use for 'reply to thread X', 'add a follow-up to discussion Y', or to chain a series of automated updates. For starting a new thread instead, use create_discussion.",
      createCommentSchema,
      createComment,
    );
  }

  // ── b3 admin (opt-in via LOOMIO_B3_API_KEY) ───────────────────────────────

  if (b3Enabled && !readOnly) {
    registerTool(
      server,
      "deactivate_user",
      "INSTANCE-ADMIN. Deactivate a Loomio user account instance-wide by user id. Required: `id` (numeric Loomio user id). Authenticates using `LOOMIO_B3_API_KEY` (matched against `ENV['B3_API_KEY']` on the Loomio server; ≥17 chars). This secret authenticates the SERVER, not the calling user — only set LOOMIO_B3_API_KEY if you operate the Loomio instance and have already deployed loomiomcp in a single-tenant context. Runs ASYNCHRONOUSLY server-side: Loomio enqueues DeactivateUserWorker and answers `{ success: true, user }` immediately, so the echoed user may still show `active: true` / `deactivated_at: null` — re-read later to confirm. The worker then stamps deactivated_at, revokes the user's memberships, mobile devices and pending membership requests. Uses the member route POST /api/b3/users/{id}/deactivate (the `?id=` collection route is deprecated in Loomio's OpenAPI). Reversible via reactivate_user as long as the user record persists. Returns 404 if the user is not currently active.",
      deactivateUserSchema,
      deactivateUser,
    );

    registerTool(
      server,
      "reactivate_user",
      "INSTANCE-ADMIN. Reactivate a previously-deactivated Loomio user by id. Required: `id`. Authenticates with LOOMIO_B3_API_KEY (server-instance admin secret — see deactivate_user). Synchronous: clears deactivated_at AND restores the memberships that the deactivation revoked (those whose revoked_at matches the deactivation timestamp) — memberships revoked separately, before or after, are not touched. Answers `{ success: true, user }` with the user already `active: true`. Uses the member route POST /api/b3/users/{id}/reactivate. Returns 404 if the user is not currently deactivated.",
      reactivateUserSchema,
      reactivateUser,
    );
  }

  return server;
}
