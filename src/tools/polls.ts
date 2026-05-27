import { z } from "zod";
import { loomioGet, loomioPost } from "../loomio/client.js";
import { encodePathSegment, idOrKey, PollTypeEnum, positiveId } from "./_common.js";

// ── get_poll ────────────────────────────────────────────────────────────────

export const getPollSchema = z.object({
  id_or_key: idOrKey.describe("Poll id (numeric) or short string key."),
});

export async function getPoll(input: z.infer<typeof getPollSchema>) {
  return loomioGet<unknown>(`/b2/polls/${encodePathSegment(input.id_or_key)}`);
}

// ── list_polls ──────────────────────────────────────────────────────────────

export const listPollsSchema = z.object({
  group_id: positiveId.describe("ID of the Loomio group whose polls to list (required)."),
  status: z
    .enum(["active", "closed", "all"])
    .optional()
    .describe("Filter polls by status. Loomio defaults to 'active'."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size. Loomio defaults to 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
});

export async function listPolls(input: z.infer<typeof listPollsSchema>) {
  return loomioGet<unknown>("/b2/polls", {
    group_id: input.group_id,
    ...(input.status ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });
}

// ── create_poll ─────────────────────────────────────────────────────────────
//
// Body shape: flat. See note in discussions.ts on why wrapping breaks.

export const createPollSchema = z
  .object({
    title: z.string().min(1).describe("Poll title (required)."),
    poll_type: PollTypeEnum.describe(
      "Poll type. One of: proposal, poll, count, score, ranked_choice, meeting, dot_vote.",
    ),
    group_id: positiveId
      .optional()
      .describe(
        "Group the poll belongs to. Required when not attaching to an existing discussion via discussion_id.",
      ),
    discussion_id: positiveId
      .optional()
      .describe(
        "Attach the poll to an existing discussion. When set, group_id is taken from the discussion.",
      ),
    details: z.string().optional().describe("Optional poll body / context."),
    details_format: z
      .enum(["md", "html"])
      .optional()
      .describe("Format of `details`. Defaults to 'md'."),
    options: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Voting options. `proposal` has built-in agree/disagree/abstain options; for poll / count / score / ranked_choice / meeting / dot_vote you MUST supply your own.",
      ),
    closing_at: z.string().optional().describe("ISO-8601 timestamp at which the poll closes."),
    specified_voters_only: z
      .boolean()
      .optional()
      .describe("If true, only users in recipient_user_ids / recipient_emails can vote."),
    hide_results: z
      .enum(["off", "until_vote", "until_closed"])
      .optional()
      .describe("Results visibility policy. Defaults to 'off'."),
    shuffle_options: z.boolean().optional().describe("If true, shuffle option display order."),
    anonymous: z.boolean().optional().describe("If true, hide voter identities."),
    recipient_audience: z.enum(["group"]).optional(),
    notify_on_closing_soon: z
      .enum(["nobody", "author", "voters", "undecided_voters", "all_members"])
      .optional()
      .describe("Who Loomio notifies as the closing date approaches. Defaults to 'nobody'."),
    recipient_user_ids: z.array(positiveId).optional(),
    recipient_emails: z.array(z.string().email()).optional(),
    recipient_message: z.string().optional(),
    notify_recipients: z
      .boolean()
      .optional()
      .describe("If false, suppress the initial notification email. Defaults to false."),
  })
  .superRefine((input, ctx) => {
    if (input.group_id === undefined && input.discussion_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["group_id"],
        message: "Either group_id or discussion_id is required.",
      });
    }
    if (input.poll_type !== "proposal" && !input.options?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "options is required for non-proposal poll types.",
      });
    }
  });

export async function createPoll(input: z.infer<typeof createPollSchema>) {
  return loomioPost<unknown>("/b2/polls", input);
}
