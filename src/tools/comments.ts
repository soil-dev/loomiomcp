import { z } from "zod";
import { loomioPost } from "../loomio/client.js";
import { positiveId } from "./_common.js";

// ── create_comment ──────────────────────────────────────────────────────────
//
// Body shape: flat. The comments controller's `permitted_params`
// strips `:discussion_id` and re-wraps remaining params under
// `{comment: …}`. So `discussion_id` goes in the URL query and the
// rest of the fields go flat in the body — sending `{comment: {…}}`
// would be double-wrapped.

export const createCommentSchema = z.object({
  discussion_id: positiveId.describe("ID of the discussion to comment on."),
  body: z.string().min(1).describe("Comment body (required)."),
  body_format: z
    .enum(["md", "html"])
    .optional()
    .describe("Format of `body`. Defaults to Loomio's group default when omitted."),
});

export async function createComment(input: z.infer<typeof createCommentSchema>) {
  const { discussion_id, ...rest } = input;
  // Form-encoded body: a JSON body triggers Rails' wrap_parameters,
  // and the b2 comments controller's permitted_params override doesn't
  // strip the auto-wrap key for `:comment`, producing a double-wrap
  // that the strict :raise mode then 400s on. See
  // NOTES-ON-LOOMIO-API.md.
  return loomioPost<unknown>("/b2/comments", rest, {
    params: { discussion_id },
    encoding: "form",
  });
}
