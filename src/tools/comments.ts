import { z } from "zod";
import {
  flatBody,
  LoomioApiError,
  LoomioAuthError,
  loomioDelete,
  loomioGet,
  loomioPatch,
  loomioPost,
  readParams,
} from "../loomio/client.js";
import {
  assertRecordGroupAllowed,
  GroupScopeError,
  hasGroupAllowlist,
} from "../loomio/group-scope.js";
import { type SlimUser, slimUsers } from "../loomio/shape.js";
import type { LoomioComment, LoomioSideLoads, PollsResponse } from "../loomio/types.js";
import {
  bodyText,
  collapseNotVisible,
  formatFieldDescription,
  idOrKey,
  positiveId,
  refuseHtmlWithoutFormat,
} from "./_common.js";
import { resolveThread, type ShapedComment, shapeComment } from "./threads.js";

// ── Comment writes: FLAT JSON, and why ──────────────────────────────────────
//
// Comments are the one b2 resource whose body is FLAT
// (`{discussion_id, body, body_format, parent_id?, parent_type?}`), not
// wrapped. `Api::B2::CommentsController#create` (unchanged 3.8.1 → 3.13.1):
//
//   instantiate_resource                       # Comment.new(permitted `comment` hash)
//   if params[:discussion_id] && resource.parent_id.blank?
//     resource.parent_type = 'Discussion'
//     resource.parent_id = params[:discussion_id]  # read from the TOP level
//   end
//   raise CanCan::AccessDenied unless resource.parent_id.present?
//
// How the permitted `comment` hash is built depends on the version:
//   - Loomio ≤ 3.11.x: Rails' `wrap_parameters` builds it from the
//     top-level keys that are Comment COLUMNS — `body`, `body_format`,
//     `parent_id`, `parent_type` — while `discussion_id`, not a column,
//     stays at the top level where the controller reads it.
//   - Loomio ≥ 3.12.0 (`wrap_parameters false`, e5bd13dfc): the flat
//     top-level hash IS the permitted hash, with `discussion_id` deleted
//     from it for comments only (b2/base_controller.rb:46-48) — so the
//     same flat body still works, but every OTHER top-level key, and any
//     query parameter (Rails merges the two), is permit-checked and an
//     unknown one answers 400. The body below therefore carries exactly
//     the schema's five keys, and no read profile is ever sent with it.
// Wrapping the body ourselves (`{comment: {…}}`) hides `discussion_id`
// from the controller and answered 400 on 3.8.1 (verified live); form
// encoding (the ≤ 3.1.2 workaround, NOTES-ON-LOOMIO-API.md Gotcha 2)
// also 400s and is gone from the client. Proof of the flat JSON shape:
// controller tests "create happy case", "create accepts a bearer token
// with flat parameters", "update accepts a bearer token with flat
// parameters" and "destroy soft deletes comment"
// (test/controllers/api/b2/comments_controller_test.rb) — all posted
// `as: :json` with exactly these keys — and, from 3.12,
// "shared JSON handling preserves comment discussion context"
// (test/integration/b2_poll_requests_test.rb:135-148).
//
// Two refusals changed meaning in 3.11 – 3.13, and `createComment`
// explains both:
//   - 404. Since 3.11.0 (ac5c1e044) `CommentService.create` raises
//     `ParentDeleted` (a RecordNotFound) BEFORE authorizing when the
//     parent — discussion, comment, poll, stance or outcome — does not
//     exist or is soft-deleted. Before that a missing parent failed in
//     the ability check.
//   - 403 on a reply to a VOTE. Since 3.13.0 (11e5187e6)
//     `Comment#parent_allows_replies?` (comment.rb:124-126) is false for
//     `parent_type: 'Stance'` while the stance's poll is open with
//     `hide_results: until_closed` (`results_available?`), and
//     `Ability::Comment :create` requires it (ability/comment.rb:9): the
//     usual "Not authorized to create Comment." with nothing else to go
//     on. Replying to the poll itself is allowed.
//
// Replies. A comment's parent is polymorphic (`belongs_to :parent,
// polymorphic: true`): the discussion for a top-level comment, another
// Comment for a threaded reply, a Poll / Stance / Outcome to comment on
// those items. `discussion_id` is the shorthand for the first case; the
// other cases send `parent_id` + `parent_type`, and `parent_type` MUST
// accompany `parent_id` — without it the comment has no thread and
// Loomio 500s in the ability check. When both `discussion_id` and
// `parent_id` are sent the explicit parent wins.
//
// The response is `respond_with_resource`: the comment (CommentSerializer:
// `topic_id`, `parent_id`, `parent_type`, `author_id`, `body`,
// `versions_count`, `discarded_at`, …) with its author under `users`.
// No discussion is side-loaded, so no url can be built here: the
// caller has the discussion (or its `topic_id` from the echo) already.
//
// `discussion_id` on the wire is NUMERIC: the controller assigns it to
// `comments.parent_id`, an integer column, and Rails casts a short key
// like "abcDEF12" to 0 — `0.present?` passes the guard, the comment has
// no thread, and the ability check blows up. But a key is what a caller
// holds after a search hit (`discussion_key`) or a Loomio URL (`/d/{key}`),
// and every sibling write takes id-or-key, so the tool accepts both and
// resolves a key with the same one compact GET the thread tools use
// (`resolveThread`'s discussion branch → the record's numeric `id`),
// before the POST. A numeric id costs nothing extra.
//
// Group allow-list (LOOMIO_MCP_GROUP_IDS, security review F-17). A
// write must be placed in a listed group BEFORE it is sent, and a
// comment's group is only knowable through its parent: a discussion
// (`discussion_id`, or parent_type 'Discussion') or a poll (parent_type
// 'Poll') costs one compact GET and is checked; a reply to a Comment,
// Stance or Outcome, and update_comment / delete_comment (addressed by
// comment id), cannot be placed — Loomio's b2 API has no read route for
// those records — so under an allow-list they are REFUSED (fail closed).
// Without an allow-list nothing here costs a call.

const ParentTypeEnum = z.enum(["Discussion", "Comment", "Poll", "Stance", "Outcome"]);

export const createCommentSchema = z
  .object({
    discussion_id: idOrKey
      .optional()
      .describe("Discussion id or short key (+1 call) for a top-level comment; or use parent_id."),
    parent_id: positiveId
      .optional()
      .describe("Comment, Poll, Stance or Outcome id to reply to (needs parent_type)."),
    parent_type: ParentTypeEnum.optional().describe("Type of parent_id; required with it."),
    body: bodyText.min(1),
    body_format: z.enum(["md", "html"]).optional().describe(formatFieldDescription("body")),
  })
  .superRefine((input, ctx) => {
    refuseHtmlWithoutFormat(ctx, input.body, input.body_format, "body");
    if (input.discussion_id === undefined && input.parent_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["discussion_id"],
        message: "Pass discussion_id (top-level comment) or parent_id + parent_type (reply).",
      });
    }
    if (input.parent_id !== undefined && input.parent_type === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["parent_type"],
        message:
          "parent_type is required with parent_id (Loomio cannot place the comment in a thread without it).",
      });
    }
    if (input.parent_id === undefined && input.parent_type !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["parent_id"],
        message: "parent_type was given without parent_id.",
      });
    }
  });

/** `respond_with_resource` for a comment: the `comments` root plus the author under `users`. */
export interface CommentsResponse extends LoomioSideLoads {
  comments?: LoomioComment[];
}

export interface CommentWriteResult {
  /** The comment as list_thread_items shapes one, body returned whole. */
  comment: ShapedComment & { topic_id?: number | null };
  users: SlimUser[];
}

function shapeCommentWrite(body: CommentsResponse, where: string): CommentWriteResult {
  const record = body.comments?.[0];
  if (!record) {
    throw new LoomioApiError(
      502,
      `Loomio answered ${where} without a comment record; the response shape is not the one Loomio ` +
        "3.8.1 produces.",
    );
  }
  const shaped = shapeComment(record, -1);
  return {
    // `topic_id` is the thread the comment landed in — what
    // list_thread_items / get_thread_markdown take to show it in context.
    comment: record.topic_id !== undefined ? { ...shaped, topic_id: record.topic_id } : shaped,
    users: slimUsers(body.users),
  };
}

export async function createComment(
  input: z.infer<typeof createCommentSchema>,
): Promise<CommentWriteResult> {
  // A short key must become the numeric id before the POST (see the
  // module note); the resolver's 404 wording ("no such id or key") is
  // reused as is.
  // Under a group allow-list the check above already resolved (and
  // judged) the discussion; otherwise a key costs the one GET here.
  let discussionId = await assertCommentTargetInScope(input);
  if (discussionId === undefined && typeof input.discussion_id === "string") {
    const { header } = await resolveThread({ discussion_id: input.discussion_id });
    if (header.id == null) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/discussions/${input.discussion_id} without a discussion id; the ` +
          "response shape is not the one Loomio 3.8.1 produces.",
      );
    }
    discussionId = header.id;
  } else if (discussionId === undefined) {
    discussionId = typeof input.discussion_id === "number" ? input.discussion_id : undefined;
  }
  // Exactly the five schema keys (see the module note: from Loomio 3.12
  // any other top-level key answers 400). zod has already stripped
  // unknown input keys; `flatBody` drops the undefined ones.
  const body = flatBody({
    discussion_id: discussionId,
    parent_id: input.parent_id,
    parent_type: input.parent_type,
    body: input.body,
    body_format: input.body_format,
  });
  let resp: CommentsResponse;
  try {
    resp = await loomioPost<CommentsResponse>("/b2/comments", body);
  } catch (err) {
    explainCreateRefusal(err, input.parent_type);
  }
  return shapeCommentWrite(resp, "POST /b2/comments");
}

/** The allow-list refusal for a comment write whose group cannot be read (module note). */
function unplaceable(what: string): GroupScopeError {
  return new GroupScopeError(
    `${what} cannot be checked against this connector's group allow-list (LOOMIO_MCP_GROUP_IDS): ` +
      "Loomio's API has no read for a comment, vote or outcome that would name its group, so the " +
      "write is refused. Comment on the discussion (discussion_id) or the poll (parent_type 'Poll') " +
      "instead, or edit the comment in Loomio.",
  );
}

/**
 * F-17 for create_comment (module note): with an allow-list set, read the
 * parent discussion or poll and refuse one outside the list before the
 * POST. The explicit parent wins over `discussion_id`, as in Loomio.
 * Returns the discussion's numeric id when it resolved `discussion_id`
 * itself, so the caller does not read the same record twice.
 */
async function assertCommentTargetInScope(
  input: z.infer<typeof createCommentSchema>,
): Promise<number | undefined> {
  if (!hasGroupAllowlist()) return undefined;
  const type = input.parent_id !== undefined ? input.parent_type : "Discussion";
  const ref = input.parent_id ?? input.discussion_id;
  if (ref === undefined) return undefined;
  if (type === "Discussion") {
    let header: Awaited<ReturnType<typeof resolveThread>>["header"];
    try {
      ({ header } = await resolveThread({ discussion_id: ref }));
    } catch (err) {
      collapseNotVisible(err, "discussion", ref);
    }
    assertRecordGroupAllowed(header.group_id, "discussion", ref);
    return input.parent_id === undefined ? (header.id ?? undefined) : undefined;
  }
  if (type === "Poll") {
    let body: PollsResponse;
    try {
      body = await loomioGet<PollsResponse>(`/b2/polls/${ref}`, readParams("compact"));
    } catch (err) {
      collapseNotVisible(err, "poll", ref);
    }
    assertRecordGroupAllowed(body.polls?.[0]?.group_id ?? null, "poll", ref);
    return undefined;
  }
  throw unplaceable(`A reply to a ${type ?? "record"}`);
}

/**
 * The two create refusals whose Loomio text says nothing useful (see
 * the module note): a 404 for a missing or soft-deleted parent, and a
 * 403 on a reply to a vote whose poll still hides results until it
 * closes. Everything else — including every other 403, whose cause the
 * client already classified — passes through untouched.
 */
function explainCreateRefusal(err: unknown, parentType: string | undefined): never {
  if (err instanceof LoomioApiError && err.status === 404) {
    throw new LoomioApiError(
      404,
      "Loomio answered 404 for POST /b2/comments: the target discussion, comment, poll, stance or " +
        "outcome does not exist or was soft-deleted (Loomio ≥ 3.11 refuses a reply to a deleted " +
        "item with 404 before checking permissions). Check the id and parent_type; nothing was " +
        "created.",
    );
  }
  if (
    err instanceof LoomioAuthError &&
    err.status === 403 &&
    err.kind === "not_authorized" &&
    parentType === "Stance"
  ) {
    throw new LoomioAuthError(
      `${err.message} With parent_type 'Stance' the likely cause: Loomio ≥ 3.13 refuses replies to ` +
        "a VOTE while its poll is open and hides results until closing (hide_results " +
        "'until_closed'). Reply to the poll instead (parent_type 'Poll', parent_id = the poll id), " +
        "or wait for it to close.",
      403,
      "not_authorized",
    );
  }
  throw err;
}

// ── update_comment ──────────────────────────────────────────────────────────
//
// `PATCH /b2/comments/{id}` → `load_resource` (`Comment.find` — numeric
// id only; comments have no short key) → `CommentService.update(comment:,
// params: resource_params, actor:)`, which stamps `edited_at`,
// re-validates and bumps `versions_count`. Body FLAT `{body,
// body_format}`: on ≤ 3.11 wrap_parameters wraps both columns, on ≥ 3.12
// the flat hash is permitted as is (and an extra key would 400). Proof:
// controller test "update accepts a bearer token with flat parameters"
// (`as: :json`, 3.8.1 and 3.13.1); also verified live on 3.8.1 (200,
// versions_count 1 → 2).
// Authorization (`:update`, app/models/ability/comment.rb): comment
// kept, thread not locked, and EITHER the user is the author, a thread
// member and the group has `members_can_edit_comments`, OR the user is a
// thread admin and the group has `admins_can_edit_user_content` → 403
// "Not authorized to update Comment." otherwise (the upstream test
// "update missing permission" is exactly the members_can_edit_comments
// = false case). `parent_id` / `parent_type` are permitted but a
// changed parent fails validation ("cannot be changed"), so they are
// not offered.

export const updateCommentSchema = z.object({
  id: positiveId,
  body: bodyText.min(1).describe("New body; REPLACES the whole text."),
  body_format: z
    .enum(["md", "html"])
    .optional()
    .describe("Omitted = the STORED format stays; send 'html' when the text is HTML."),
});

export async function updateComment(
  input: z.infer<typeof updateCommentSchema>,
): Promise<CommentWriteResult> {
  const { id, ...attrs } = input;
  if (hasGroupAllowlist()) throw unplaceable("A comment edit");
  const path = `/b2/comments/${id}`;
  const resp = await loomioPatch<CommentsResponse>(path, flatBody(attrs));
  return shapeCommentWrite(resp, `PATCH ${path}`);
}

// ── delete_comment ──────────────────────────────────────────────────────────
//
// `DELETE /b2/comments/{id}` → `CommentService.discard`: SOFT. Stamps
// `discarded_at` / `discarded_by`, unpins the comment's thread item and
// re-sequences the thread; the serializer nulls `body`
// (`hide_when_discarded`). Replies to the comment stay where they are.
// Restorable by the author or a thread admin in Loomio's UI
// (`:undiscard`). Proof: controller test "destroy soft deletes comment"
// (3.8.1, `as: :json`) asserts `discarded_at`, `discarded_by` and a null
// echoed `body`; DELETE exercised live (200). Authorization (`:discard`):
// thread not locked, and the user the author (as a thread member) or a
// thread admin → 403 "Not authorized to discard Comment." otherwise;
// unknown id → 404.

export const deleteCommentSchema = z.object({
  id: positiveId,
});

export interface DeleteCommentResult extends CommentWriteResult {
  discarded: boolean;
  note: string;
}

export async function deleteComment(
  input: z.infer<typeof deleteCommentSchema>,
): Promise<DeleteCommentResult> {
  if (hasGroupAllowlist()) throw unplaceable("A comment deletion");
  const path = `/b2/comments/${input.id}`;
  const resp = await loomioDelete<CommentsResponse>(path);
  const shaped = shapeCommentWrite(resp, `DELETE ${path}`);
  return {
    ...shaped,
    discarded: typeof shaped.comment.discarded_at === "string",
    note:
      "Soft-discarded: the comment's body is nulled and it drops out of the thread view, but the " +
      "record remains (replies keep their place) and the author or a thread admin can restore it in " +
      "Loomio. Nothing was permanently deleted.",
  };
}
