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
    "List polls in a Loomio group, ordered by creation date (newest first). Required: `group_id`. Optional `status` filter — 'active' (default), 'closed', 'all' (every kept poll); `limit` 1-200 (default 50); `offset` for pagination. Caller must be a group member. Use to answer 'what's up for vote in group X', 'show me past poll results', or before create_poll to check what's already proposed.",
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
    "List members of a Loomio group with their email addresses, roles, and join state. Required: `group_id`. Caller MUST be a group admin (non-admins get HTTP 403; the response is server-side scoped to include `include_email: true`). Optional `limit` 1-200 (default 50) and `offset` for pagination. Use to answer 'who's in group X', 'find a member by email', or — critically — BEFORE calling manage_memberships with remove_absent=true, since the diff between current and intended members is what makes that destructive call safe.",
    listMembershipsSchema,
    listMemberships,
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
