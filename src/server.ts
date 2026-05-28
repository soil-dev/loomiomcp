import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasB3ApiKey, isReadOnly } from "./loomio/client.js";
import { ICONS } from "./icon.js";
import { registerTool } from "./server/register-tool.js";

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
    version: "0.1.0",
    description:
      "MCP server for Loomio (loomio.com / self-hosted). Wraps Loomio's b2 public API: read and create discussions, polls, comments, plus list and manage group memberships. Read-only mode supported via LOOMIO_MCP_READONLY=1 (Cloud Run pattern). Optional b3 admin operations (deactivate / reactivate user) when LOOMIO_B3_API_KEY is set — instance operators only. Read tools annotated with readOnlyHint so MCP clients can auto-approve safe calls; destructive writes (manage_memberships with remove_absent, deactivate_user) carry destructiveHint.",
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
    "List discussions in a Loomio group, ordered by latest activity. Required: `group_id`. Optional `status` filter — 'open' (unlocked, default), 'closed' (locked), 'all' (every kept thread); `limit` 1-200 (Loomio default 50); `offset` for pagination. Caller must be a group member. Use to answer 'what's being discussed in group X', 'show me recent threads', or before create_discussion to check for duplicates. For one specific thread, use get_discussion.",
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
    "List polls in a Loomio group, ordered by creation date (newest first). Required: `group_id`. Optional `status` filter — 'active' (default), 'closed', 'all' (every kept poll); `limit` 1-200 (default 50); `offset` for pagination. Caller must be a group member. Use to answer 'what's up for vote in group X', 'show me past poll results', or before create_poll to check what's already proposed. " +
      "FOR PER-USER PARTICIPATION QUESTIONS — 'who voted', 'how often did X vote', 'compare delegates' turnout' — prefer `get_user_activity`. It returns participation directly (via the underlying events stream) and avoids the ambiguity between 'didn't vote' and 'abstained' that you can't tell apart from a `list_polls` response alone.",
    listPollsSchema,
    listPolls,
  );

  if (!readOnly) {
    registerTool(
      server,
      "create_poll",
      "Create a new Loomio poll. Required: `title`, `poll_type` — one of 'proposal' (built-in agree / disagree / abstain), 'poll' (single-choice), 'count' (count signers), 'score' (1-5 rating, configurable via min_score / max_score), 'ranked_choice' (STV), 'meeting' (time poll), 'dot_vote' (point allocation, see dots_per_person). For every type except 'proposal' you MUST supply `options` (array of strings). Either supply `group_id` for a standalone poll or `discussion_id` to attach to an existing thread. Optional: `details` + `details_format`, `closing_at` (ISO-8601), `anonymous`, `hide_results` ('off' / 'until_vote' / 'until_closed'), `specified_voters_only`, `shuffle_options`, `notify_on_closing_soon`, recipient fields. " +
        "KNOWN UPSTREAM LIMITATION: Loomio's b2 `permitted_params` omits `:private`, so the auto-created Topic always defaults to `private: true` and groups with public-discussions-only policy reject the create with a 422 and empty errors hash. See NOTES-ON-LOOMIO-API.md. Workaround at the moment: create polls only in groups that allow private discussions.",
      createPollSchema,
      createPoll,
    );
  }

  // ── Memberships ───────────────────────────────────────────────────────────

  registerTool(
    server,
    "list_memberships",
    "List members of a Loomio group with their email addresses, roles, and join state. Required: `group_id`. Caller MUST be a group admin (non-admins get HTTP 403; the response is server-side scoped to include `include_email: true`). Optional `limit` 1-200 (default 50) and `offset` for pagination. Use to answer 'who's in group X', 'find a member by email', or — critically — BEFORE calling manage_memberships with remove_absent=true, since the diff between current and intended members is what makes that destructive call safe. " +
      "Do NOT use this tool to construct a participation analysis (e.g. 'how active is each member', 'who voted in our polls') by combining its output with `list_polls`. That reconstruction is more expensive in round-trips AND ambiguous about abstain-vs-didn't-vote. Use `get_user_activity` per member instead — it answers participation directly from the event stream.",
    listMembershipsSchema,
    listMemberships,
  );

  registerTool(
    server,
    "list_groups",
    "List groups the connector's api-key user can see, by probing a group_id range. Loomio's API has no native 'list groups' endpoint that honours api-key auth (v1's profile/groups needs a session; the v1 explore endpoint returns only public groups). This tool works around that by issuing one `b2/polls?group_id=N&limit=1&status=all` per id and collecting the group objects from the 200 responses — 404s skipped, 403s treated as soft misses. " +
      "Scope: returns every group the bot is a **member** of (plus their parent groups, which b2/polls embeds in the response). Bot users with `is_admin: true` bypass the membership check and see every group on the instance. " +
      "Optional knobs: `start_id` (default 1), `end_id` (default 200; a single call may scan at most 500 ids), `stop_after_consecutive_misses` (default 50; early-exit on sparse id ranges). " +
      "Caveat: this is the right tool to answer 'what groups can you see' and similar discovery questions, but it costs O(end_id - start_id) outbound calls — typically ~50–200 HTTP requests in 2–5 seconds. The returned group objects are slimmed to `{id, key, handle, name, parent_id, discussion_privacy_options, is_visible_to_public, memberships_count}`; to drill in, use `list_memberships`, `list_discussions`, `list_polls` with the relevant id.",
    listGroupsSchema,
    listGroups,
  );

  // ── Events ────────────────────────────────────────────────────────────────

  registerTool(
    server,
    "list_events",
    "Fetch the full event stream for ONE discussion — every new_comment, poll_created, stance_created, outcome_created, reaction, discussion_moved, etc. — with actor_id, kind, parent_id, created_at, and pointers to the underlying eventable record. Required: `discussion_id`. Optional `limit` (1-200, default 50), `offset` (Loomio's `from` param), and `kinds` (client-side filter to specific event kinds). The response also embeds related `comments`, `users`, and `polls` arrays for in-place resolution. Use this to answer 'show me the reply tree for thread X', 'who participated in discussion Y', or as the building block for cross-discussion aggregations. " +
      "Loomio's v1/events endpoint REQUIRES a discussion_id; there is no instance-wide, per-group, or per-user index. For user-centric questions across many discussions ('how active is X', 'compare delegates'), use `get_user_activity` — do NOT loop `list_events` over every discussion yourself. `get_user_activity` does that fan-out server-side with concurrency control.",
    listEventsSchema,
    listEvents,
  );

  registerTool(
    server,
    "get_user_activity",
    "Aggregate one user's activity across a set of groups. Server-side: fans out across every discussion in the specified groups, fetches its event stream, filters to events authored by the target user, and returns counts (by kind, by group, by month), plus first/last activity timestamps and a sample of recent events. Required: `user_id`, `group_ids` (1-50; pass the result of `list_groups` for instance-wide). Optional `since` / `until` (ISO-8601) bound the time window. " +
      "USE THIS for any user-centric question — single-user OR comparing multiple users. Examples that all map to this tool: 'tell me about user X', 'how active has Y been in Q1', 'compare delegate turnout across the BAC and TAC', 'rank members of group N by participation', 'who's our most engaged contributor since June', 'build participation cards for each delegate'. For an N-delegate comparison, **call this tool N times** (once per user) — that's the intended pattern and is materially cheaper than reconstructing the same data from `list_polls` + `list_memberships`. " +
      "Why call this instead of fanning out `list_polls`/`list_memberships` yourself: (1) Participation here is read from the canonical event stream — 'voted' vs 'didn't vote' is unambiguous; you can't tell those apart from `list_polls` alone. (2) Round-trip count is the same or lower in aggregate, because each user's activity scan reuses the same `list_discussions` fetches in your conversation context. (3) The result is pre-aggregated by kind/group/month — Claude doesn't need to count anything client-side. " +
      "Cost: one outbound HTTP call per discussion in scope (plus one `list_discussions` per group). A single user-activity call on a ~200-discussion instance is ~200 calls in 5-10 seconds, concurrency-capped at 6. That sounds large but is the correct denominator for comparison: building the same answer from `list_polls` requires the same discussion-scan + a separate `list_memberships` per group + client-side cross-referencing. " +
      "For one discussion at a time, use `list_events`. For 'what groups can the user see', use `list_groups` first to scope the call.",
    getUserActivitySchema,
    getUserActivity,
  );

  if (!readOnly) {
    registerTool(
      server,
      "manage_memberships",
      "Invite users to a Loomio group by email and (optionally) REMOVE members not in the supplied list. Required: `group_id` (caller must be a group admin), `emails` (array of email addresses). Default mode is additive: every address in `emails` that isn't already a member is invited / added; no existing member is touched. " +
        "DANGEROUS OPTION — `remove_absent: true`: Loomio REMOVES every existing group member whose email is NOT in `emails`. The zero-or-stale-emails case can wipe the entire group. There is no server-side dry-run and no undo. ALWAYS call list_memberships first, compute the diff explicitly, and confirm with a human before invoking with remove_absent=true. " +
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
      "INSTANCE-ADMIN. Deactivate a Loomio user account instance-wide by user id. Required: `id` (numeric Loomio user id). Authenticates using `LOOMIO_B3_API_KEY` (matched against `ENV['B3_API_KEY']` on the Loomio server; ≥17 chars). This secret authenticates the SERVER, not the calling user — only set LOOMIO_B3_API_KEY if you operate the Loomio instance and have already deployed loomiomcp in a single-tenant context. Schedules an async DeactivateUserWorker that revokes sessions, memberships, and email subscriptions. Reversible via reactivate_user as long as the user record persists. Returns 404 if the user is not currently active.",
      deactivateUserSchema,
      deactivateUser,
    );

    registerTool(
      server,
      "reactivate_user",
      "INSTANCE-ADMIN. Reactivate a previously-deactivated Loomio user by id. Required: `id`. Authenticates with LOOMIO_B3_API_KEY (server-instance admin secret — see deactivate_user). Restores the user's ability to log in, but does NOT restore prior memberships or subscriptions; those must be re-applied separately. Returns 404 if the user is not currently deactivated.",
      reactivateUserSchema,
      reactivateUser,
    );
  }

  return server;
}
