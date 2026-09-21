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
  updateDiscussionSchema,
  updateDiscussion,
  deleteDiscussionSchema,
  deleteDiscussion,
  listDiscussionsSchema,
  listDiscussions,
} from "./tools/discussions.js";
import {
  getPollSchema,
  getPoll,
  createPollSchema,
  createPoll,
  updatePollSchema,
  updatePoll,
  deletePollSchema,
  deletePoll,
  listPollsSchema,
  listPolls,
} from "./tools/polls.js";
import {
  listMembershipsSchema,
  listMemberships,
  manageMembershipsSchema,
  manageMemberships,
} from "./tools/memberships.js";
import {
  checkConnectionSchema,
  checkConnection,
  getGroupSchema,
  getGroup,
  listGroupsSchema,
  listGroups,
} from "./tools/groups.js";
import {
  getParticipationReportSchema,
  getParticipationReport,
  getUserActivitySchema,
  getUserActivity,
} from "./tools/reports.js";
import {
  getThreadMarkdownSchema,
  getThreadMarkdown,
  listThreadItemsSchema,
  listThreadItems,
  listThreadsSchema,
  listThreads,
} from "./tools/threads.js";
import { searchContentSchema, searchContent } from "./tools/search.js";
import {
  createCommentSchema,
  createComment,
  updateCommentSchema,
  updateComment,
  deleteCommentSchema,
  deleteComment,
} from "./tools/comments.js";
import {
  deactivateUserSchema,
  deactivateUser,
  reactivateUserSchema,
  reactivateUser,
  getUserSchema,
  getUser,
  listUsersSchema,
  listUsers,
} from "./tools/admin.js";

/**
 * Server-level `instructions` — delivered to the client in the
 * `initialize` result, before it has read a single tool description.
 * Claude.ai and Claude Code put this text in the model's context, so it
 * is the one place to say which tool answers which KIND of question
 * without the model having to compare two dozen descriptions.
 *
 * Budget: <= 1800 chars, ten numbered lines, one routing decision each.
 * Together with the tool descriptions (<= 700 chars each, <= 350 for
 * delete_* / update_comment; most are far shorter) this is a per-session
 * fixed cost paid before the first question — the first 0.0.12 draft
 * spent ~83 KB (~20k tokens) on the catalogue alone, and
 * scripts/catalog-size.mjs measures it from the built server. The
 * long-form guidance those texts used to carry (field lists, permission
 * rules, Loomio's counting rules) lives in HOWTO.md under "Tool
 * reference"; here only what changes WHICH tool is called, or how a
 * result must be read, survives.
 */
export const SERVER_INSTRUCTIONS = [
  "loomiomcp routing:",
  "1. Unsure what works or is visible? Call check_connection first: key status, own user, groups (member / pending / parent), readonly / b3 flags.",
  "2. Groups: list_groups (member groups, 1 call); get_group reads ONE group by id, key or handle, even a public one it omits.",
  "3. 'What's new': list_threads (1 call, every visible group, newest first). For a date window pass `since` and page with offset until scope.exhausted. ONE group: list_discussions / list_polls.",
  "4. 'Summarise / read this thread': get_thread_markdown (topic_id). Structured items, votes, replies: list_thread_items.",
  "5. Keywords or 'what did X post': search_content (`query` and/or `author_id`). Hard cap 20 results, no paging: narrow the search.",
  "6. 'Who is most engaged / rank the members': get_participation_report (1 call). One person: get_user_activity (month granularity, 1 call per group + 1).",
  "7. Ids: discussions and polls take a numeric id or short key; thread tools take `topic_id` (on every thread row); user_id comes from list_memberships, a participation row or check_connection. Nothing searches people by name.",
  "8. Roster: list_memberships. An EMPTY roster means the connector's user is not a member, not an empty group.",
  "9. Poll results: trust results_visible / results_hidden_reason; absent counts mean hidden, not zero. Never infer who voted what on an anonymous poll.",
  "10. Writes (when registered): pass plain fields; the connector nests them. update_* REPLACES the text sent; delete_* soft-discards; `*_format: 'html'` for HTML bodies; create_poll needs `closing_at` to open and announces unless `notify_on_open: false`; to end voting set `closing_at` to the next full hour (no close route). Confirm update_*, delete_*, remove_absent with the human.",
].join("\n");

/**
 * Build an `McpServer` configured for one inbound HTTP request (or one
 * stdio session). Reads `isReadOnly()` at construction time so writes
 * are skipped at registration when `LOOMIO_MCP_READONLY` is set. The
 * b3 admin tools are registered only when `LOOMIO_B3_API_KEY` is set
 * (Loomio instance-operator secret).
 *
 * Registration order is the order clients list the tools in, so it
 * runs discovery → reading → analysis → writes → admin: the first tool
 * a model sees is the one that tells it what the rest can do.
 *
 * Description shape (tests/server.test.ts pins a byte ceiling on the
 * whole catalogue, measured with scripts/catalog-size.mjs): sentence 1
 * = what it returns + the upstream cost, sentence 2 = when to use it vs
 * its nearest sibling, sentence 3 = the one caveat that changes
 * behaviour. Field-by-field output listings, permission matrices and
 * Loomio internals belong in HOWTO.md "Tool reference".
 */
export function createLoomioMcpServer(): McpServer {
  const readOnly = isReadOnly();
  const b3Enabled = hasB3ApiKey();

  const server = new McpServer(
    {
      name: "loomiomcp",
      // Single source of truth in src/version.ts; tests/version.test.ts
      // pins it to package.json so the two can no longer drift.
      version: VERSION,
      description:
        "MCP server for Loomio (loomio.com or self-hosted). Reads: connection check, groups, discussions and polls, threads across every visible group, one thread's items or server-rendered Markdown, full-text search, Loomio's participation report, group rosters. Writes (absent under LOOMIO_MCP_READONLY=1): create / update / soft-delete discussions, polls and comments; invite or remove members. Opt-in instance-operator tools when LOOMIO_B3_API_KEY is set. One upstream call per read wherever Loomio offers an aggregate; every collection carries Loomio's exact `total` and a `scope` note; full MCP ToolAnnotations on every tool.",
      websiteUrl: "https://github.com/soil-dev/loomiomcp",
      icons: ICONS,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ── Discovery ─────────────────────────────────────────────────────────────

  registerTool(
    server,
    "check_connection",
    "Call FIRST when unsure whether the connector works or what it can see: 1 health probe, no input. Returns `key_status` ('valid' | 'rejected' | 'unreachable'), the key's `user`, its `groups[]` with `member_state`, `readonly`, `b3_enabled` and `notes[]`.",
    checkConnectionSchema,
    checkConnection,
  );

  registerTool(
    server,
    "list_groups",
    "The connector user's groups, pending invitations included: 1 call, no input. Subgroup parents are appended with `member: false`. get_group reads one record, even a public group this list omits.",
    listGroupsSchema,
    listGroups,
  );

  registerTool(
    server,
    "get_group",
    "One group by numeric id, short key or URL handle: 1 call; works for public groups the user has not joined. Returns the full record (`members_can_*` flags included, billing `subscription` dropped) plus `member`, `membership`, `parent`, `url`. 403 'Not authorized to show Group.' = hidden from this user; unknown = 404.",
    getGroupSchema,
    getGroup,
  );

  // ── Discussions ───────────────────────────────────────────────────────────

  registerTool(
    server,
    "get_discussion",
    "One discussion by numeric id or short key: 1 call (2 with `include_items`). Returns the full body, `topic_id`, counters, `url`; `include_items: true` embeds list_thread_items as `thread_items` (`items_limit`; `next_offset` says when to page on). Prose: get_thread_markdown; a group's threads: list_discussions.",
    getDiscussionSchema,
    getDiscussion,
  );

  registerTool(
    server,
    "list_discussions",
    "One group's discussions, newest activity first: 1 call. `status` defaults to 'open'; `description_max_chars` (default 1500) caps bodies, `description_truncated: true` marking a cut; `strip_html` (default true) gives plain text. Every visible group: list_threads; keywords: search_content. Subgroups are excluded.",
    listDiscussionsSchema,
    listDiscussions,
  );

  if (!readOnly) {
    registerTool(
      server,
      "create_discussion",
      "Start a discussion in a group: 1 call. Required `title`, `group_id`; optional `description` (+ `description_format`: 'html' for HTML), `private` (omit for the group's default), `tags`, recipients. Returns `id`, `key`, `url`, `topic_id`. Check list_discussions for duplicates first; to add to a thread use create_comment.",
      createDiscussionSchema,
      createDiscussion,
    );

    registerTool(
      server,
      "update_discussion",
      "Edit a discussion by `id_or_key`: 1 call. Pass only what changes: `title`, `description` (REPLACES the body: read it first, send the whole text), `private`, `allow_*` flags, recipients to add. Cannot move a thread or change its tags; a discarded thread cannot be edited.",
      updateDiscussionSchema,
      updateDiscussion,
    );

    registerTool(
      server,
      "delete_discussion",
      "Discard a discussion by `id_or_key`: 1 call. Loomio's SOFT delete: it leaves every list and its text is blanked, but nothing is permanently erased (a group admin can restore it). For a text mistake prefer update_discussion.",
      deleteDiscussionSchema,
      deleteDiscussion,
    );
  }

  // ── Polls ─────────────────────────────────────────────────────────────────

  registerTool(
    server,
    "get_poll",
    "One poll by numeric id or short key: 1 call. Returns `poll` (full details, `topic_id`), `poll_options[]`, `current_outcome`, `my_stance`, `url`; votes as items: list_thread_items with its `topic_id`. Results gate: `results_visible` / `results_hidden_reason` say whether tallies are present; absent counts mean HIDDEN, never zero.",
    getPollSchema,
    getPoll,
  );

  registerTool(
    server,
    "list_polls",
    "One group's polls, newest first: 1 call. `status` defaults to 'active' ('closed', 'all'); `description_max_chars` caps `details`; `strip_html` (default true). Slim rows with `poll_options[]` and `stance_counts` when visible (trust `results_visible`). For member activity use get_participation_report, not this plus list_memberships.",
    listPollsSchema,
    listPolls,
  );

  if (!readOnly) {
    registerTool(
      server,
      "create_poll",
      "Create a poll: 1 call (2 with `discussion_id`). Required `title`, `poll_type`, `options` (NO default options; only 'question' takes none) and `group_id` (standalone) or `discussion_id` / `topic_id` (inside a thread). `closing_at` (ISO-8601, future) is effectively REQUIRED: without it Loomio saves the poll UNOPENED and the result carries `opened: false` and a `warning`. An opening poll is announced because `notify_on_open` defaults to TRUE; pass `notify_on_open: false` for a quiet create.",
      createPollSchema,
      createPoll,
    );

    registerTool(
      server,
      "update_poll",
      "Edit an OPEN poll by `id_or_key`: 1 call (2 with `options`). Pass only what changes: `title`, `details` (REPLACES the text), `closing_at` (future; opening a draft announces unless `notify_on_open` is false), `options` (names to ADD: merged with the current list, so it never removes an option it saw; not atomic), settings. Cannot change `poll_type`, `anonymous`, group or tags; a closed poll answers 403.",
      updatePollSchema,
      updatePoll,
    );

    registerTool(
      server,
      "delete_poll",
      "Discard a poll by `id_or_key`: 1 call. Loomio's SOFT delete: the poll and its votes leave the thread view, but nothing is permanently erased (a group admin can restore it). To end voting set `closing_at` to the next full hour with update_poll; no immediate close exists.",
      deletePollSchema,
      deletePoll,
    );
  }

  // ── Threads (Loomio 3.8 GET /b2/threads…) ─────────────────────────────────

  registerTool(
    server,
    "list_threads",
    "The cheapest 'what is new across everything I can see': 1 call lists every visible thread, newest activity first (`topic_id`, `type`, `title`, `group_id`, counters, `url`; no bodies). `group_id` / `type` filter client-side within the page (one group: list_discussions / list_polls). No date filter upstream: pass `since` and page with `offset` until `scope.exhausted`.",
    listThreadsSchema,
    listThreads,
  );

  registerTool(
    server,
    "list_thread_items",
    "One thread as structured items: 1 call by `topic_id` (2 by `discussion_id` or `poll_id`; pass exactly one). Returns `items[]` in thread order plus the comments, polls, stances (votes), outcomes and users they reference. The whole thread is fetched once and sliced here (`limit`, `offset`, `kinds`) under the `max_total_chars` budget; `next_offset` says where to continue.",
    listThreadItemsSchema,
    listThreadItems,
  );

  registerTool(
    server,
    "get_thread_markdown",
    "The best single call for 'summarise / read this thread': 1 call by `topic_id` (2 by `discussion_id` or `poll_id`; pass exactly one) returns Loomio's server-rendered Markdown of the thread (`markdown`, `chars`, `truncated`). Structured data: list_thread_items. `max_chars` cuts from the END, so `truncated: true` means the newest items were dropped.",
    getThreadMarkdownSchema,
    getThreadMarkdown,
  );

  // ── Search ────────────────────────────────────────────────────────────────

  registerTool(
    server,
    "search_content",
    "Keyword search over everything the connector's user can see: 1 call. Pass `query` (prefix match; `!word` excludes), `author_id` alone for 'what did X post', or both. Hard cap: at most 20 results, no paging; `capped: true` means narrow the search. Stance hits on polls with hidden results are DROPPED from a `query` search; never use search to probe hidden vote reasons.",
    searchContentSchema,
    searchContent,
  );

  // ── Participation ─────────────────────────────────────────────────────────

  registerTool(
    server,
    "get_participation_report",
    "Rank the members of a group set: 1 call returns Loomio's own report, a row per user sorted by `total` desc. Scope by `group_ids` (1-50, counted together) or `group_scope: 'my'`; top `limit` rows (default 50, max 500), zero-activity users dropped unless `include_inactive`. Anonymous polls are excluded; a vote counts in the month its counted stance row was created.",
    getParticipationReportSchema,
    getParticipationReport,
  );

  registerTool(
    server,
    "get_user_activity",
    "One person's participation across groups: 1 call per group + 1. Required `user_id` (from list_memberships or a participation row) and `group_ids`. Returns `counts`, `by_group`, `sample_events` (newest items with urls, not a full list). MONTH-GRAINED: `since` / `until` widen to whole months; anonymous polls never count; a vote counts in the month its counted stance row was created.",
    getUserActivitySchema,
    getUserActivity,
  );

  // ── Memberships ───────────────────────────────────────────────────────────

  registerTool(
    server,
    "list_memberships",
    "A group's members: 1 call. Returns `memberships[]` (`user_email` only where the connector's user is a group admin), `users[]`, `total`. Use it to resolve a name to a `user_id` and ALWAYS before manage_memberships with remove_absent. A non-member gets an EMPTY list, not 403: never report it as an empty group.",
    listMembershipsSchema,
    listMemberships,
  );

  if (!readOnly) {
    registerTool(
      server,
      "manage_memberships",
      "Invite users to a group by email and optionally REMOVE members not in the list: 1 call; the connector's user must be an admin of THAT group. Default is additive: new addresses are invited, nobody is touched. DANGEROUS: `remove_absent: true` removes every member whose email is absent, own user included, with no undo: list_memberships first, then confirm the diff with a human.",
      manageMembershipsSchema,
      manageMemberships,
    );
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  if (!readOnly) {
    registerTool(
      server,
      "create_comment",
      "Post a comment in a thread: 1 call (2 when `discussion_id` is a short key). Required `body` (+ `body_format`: 'html' for HTML; Loomio stores an omitted format as Markdown) and a target: `discussion_id` for a top-level comment, or `parent_id` + `parent_type` ('Comment' for a threaded reply; 'Poll' / 'Stance' / 'Outcome'). A new thread: create_discussion.",
      createCommentSchema,
      createComment,
    );

    registerTool(
      server,
      "update_comment",
      "Edit a comment: 1 call. Required numeric `id` and `body` (REPLACES the whole text: read it with list_thread_items first), optional `body_format`. Only the author, or a thread admin where the group allows it, may edit; the thread must be unlocked.",
      updateCommentSchema,
      updateComment,
    );

    registerTool(
      server,
      "delete_comment",
      "Discard a comment by numeric `id`: 1 call. Loomio's SOFT delete: the body is blanked and the comment leaves the thread view, but nothing is permanently erased (restorable in Loomio). For a wording fix prefer update_comment.",
      deleteCommentSchema,
      deleteComment,
    );
  }

  // ── b3 admin (opt-in via LOOMIO_B3_API_KEY) ───────────────────────────────

  if (b3Enabled && !readOnly) {
    registerTool(
      server,
      "deactivate_user",
      "INSTANCE-ADMIN. Deactivate a user account instance-wide by numeric `id`: 1 call with the LOOMIO_B3_API_KEY server secret (single-tenant deployments). Asynchronous on Loomio's side: the echoed `user` may still show `active: true`, so re-read with get_user. Reversible with reactivate_user; confirm with the human first. 404 unless the user is active.",
      deactivateUserSchema,
      deactivateUser,
    );

    registerTool(
      server,
      "reactivate_user",
      "INSTANCE-ADMIN. Reactivate a deactivated user by numeric `id`: 1 call with the LOOMIO_B3_API_KEY server secret. Synchronous: clears `deactivated_at` and restores the memberships the deactivation revoked; returns `user` already `active: true`. 404 unless the user is deactivated.",
      reactivateUserSchema,
      reactivateUser,
    );

    registerTool(
      server,
      "get_user",
      "INSTANCE-ADMIN READ. One account by numeric `id`, or by a linked identity via `identity_type` + `uid`: 1 call with the LOOMIO_B3_API_KEY server secret. Returns `user` {id, name, username, EMAIL, is_admin, active, identities[]} for ANY account on the instance, hence single-tenant deployments only. Use it before deactivate_user or to map an SSO identity; a `uid` containing a dot cannot be resolved, use the id. 404 when nothing matches.",
      getUserSchema,
      getUser,
    );

    registerTool(
      server,
      "list_users",
      "INSTANCE-ADMIN READ. EVERY account on the instance, active and deactivated: 1 call, unpaginated, with the LOOMIO_B3_API_KEY server secret; `is_admin` narrows to admins (true) or non-admins (false). Rows carry id, name, username, EMAIL, is_admin, active, identities[]. The whole user table with emails, hence single-tenant deployments only and possibly large: prefer get_user, or list_memberships for 'who is in group X'.",
      listUsersSchema,
      listUsers,
    );
  }

  return server;
}
