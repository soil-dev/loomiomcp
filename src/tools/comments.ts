import { z } from "zod";
import {
  flatBody,
  LoomioApiError,
  loomioDelete,
  loomioPatch,
  loomioPost,
} from "../loomio/client.js";
import { type SlimUser, slimUsers } from "../loomio/shape.js";
import type { LoomioComment, LoomioSideLoads } from "../loomio/types.js";
import { formatFieldDescription, idOrKey, positiveId, refuseHtmlWithoutFormat } from "./_common.js";
import { resolveThread, type ShapedComment, shapeComment } from "./threads.js";

// ── Comment writes: FLAT JSON, and why ──────────────────────────────────────
//
// Comments are the one b2 resource whose body is FLAT
// (`{discussion_id, body, body_format, parent_id?, parent_type?}`), not
// wrapped. `Api::B2::CommentsController#create` (Loomio 3.8.1):
//
//   instantiate_resource                       # Comment.new(permitted `comment` hash)
//   if params[:discussion_id] && resource.parent_id.blank?
//     resource.parent_type = 'Discussion'
//     resource.parent_id = params[:discussion_id]  # read from the TOP level
//   end
//   raise CanCan::AccessDenied unless resource.parent_id.present?
//
// The permitted `comment` hash is the one Rails' `wrap_parameters`
// builds from the top-level keys that are Comment COLUMNS — `body`,
// `body_format`, `parent_id`, `parent_type` — while `discussion_id`,
// not a column, stays at the top level where the controller reads it.
// Wrapping the body ourselves (`{comment: {…}}`) hides `discussion_id`
// from the controller and answers 400 (verified live); form encoding
// (the ≤ 3.1.2 workaround, NOTES-ON-LOOMIO-API.md Gotcha 2) also 400s
// on 3.8.1 and is gone from the client. Proof of the flat JSON shape:
// controller tests "create happy case", "create accepts a bearer token
// with flat parameters", "update accepts a bearer token with flat
// parameters" and "destroy soft deletes comment"
// (test/controllers/api/b2/comments_controller_test.rb, 3.8.1) — all
// posted `as: :json` with exactly these keys.
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
    body: z.string().min(1),
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
  let discussionId: number | undefined;
  if (typeof input.discussion_id === "string") {
    const { header } = await resolveThread({ discussion_id: input.discussion_id });
    if (header.id == null) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET /b2/discussions/${input.discussion_id} without a discussion id; the ` +
          "response shape is not the one Loomio 3.8.1 produces.",
      );
    }
    discussionId = header.id;
  } else {
    discussionId = input.discussion_id;
  }
  const resp = await loomioPost<CommentsResponse>(
    "/b2/comments",
    flatBody({ ...input, discussion_id: discussionId }),
  );
  return shapeCommentWrite(resp, "POST /b2/comments");
}

// ── update_comment ──────────────────────────────────────────────────────────
//
// `PATCH /b2/comments/{id}` → `load_resource` (`Comment.find` — numeric
// id only; comments have no short key) → `CommentService.update(comment:,
// params: resource_params, actor:)`, which stamps `edited_at`,
// re-validates and bumps `versions_count`. Body FLAT `{body,
// body_format}` (wrap_parameters wraps both columns). Proof: controller
// test "update accepts a bearer token with flat parameters" (3.8.1,
// `as: :json`); also verified live (200, versions_count 1 → 2).
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
  body: z.string().min(1).describe("New body; REPLACES the whole text."),
  body_format: z
    .enum(["md", "html"])
    .optional()
    .describe("Omitted = the STORED format stays; send 'html' when the text is HTML."),
});

export async function updateComment(
  input: z.infer<typeof updateCommentSchema>,
): Promise<CommentWriteResult> {
  const { id, ...attrs } = input;
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
