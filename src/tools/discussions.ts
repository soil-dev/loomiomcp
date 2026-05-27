import { z } from "zod";
import {
  isReadOnly,
  LoomioApiError,
  LoomioAuthError,
  LoomioReadOnlyError,
  loomioGet,
  loomioPost,
} from "../loomio/client.js";
import { encodePathSegment, idOrKey, positiveId } from "./_common.js";

// ── get_discussion ──────────────────────────────────────────────────────────

export const getDiscussionSchema = z.object({
  id_or_key: idOrKey.describe(
    "Discussion id (numeric) or short string key (e.g. 'abcDEF12'). Loomio accepts either.",
  ),
});

export async function getDiscussion(input: z.infer<typeof getDiscussionSchema>) {
  return loomioGet<unknown>(`/b2/discussions/${encodePathSegment(input.id_or_key)}`);
}

// ── list_discussions ────────────────────────────────────────────────────────

export const listDiscussionsSchema = z.object({
  group_id: positiveId.describe("ID of the Loomio group whose discussions to list (required)."),
  status: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe(
      "Filter by status. 'open' = unlocked, 'closed' = locked, 'all' = every kept discussion. Loomio defaults to 'open'.",
    ),
  limit: z.number().int().min(1).max(200).optional().describe("Page size. Loomio defaults to 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
});

export async function listDiscussions(input: z.infer<typeof listDiscussionsSchema>) {
  return loomioGet<unknown>("/b2/discussions", {
    group_id: input.group_id,
    ...(input.status ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });
}

// ── create_discussion ───────────────────────────────────────────────────────
//
// Body shape: flat. Snorlax's `permitted_params` re-wraps the payload
// under `{discussion: …}` server-side — sending an already-wrapped
// body causes the wrapper key to be stripped and re-wrapped, producing
// an empty record. Always send fields at the top level.

export const createDiscussionSchema = z.object({
  title: z.string().min(1).describe("Discussion title (required)."),
  group_id: positiveId.describe("ID of the Loomio group to create the discussion in (required)."),
  description: z.string().optional().describe("Optional discussion body."),
  description_format: z
    .enum(["md", "html"])
    .optional()
    .describe("Format of `description`. Defaults to Loomio's group default when omitted."),
  private: z
    .boolean()
    .optional()
    .describe(
      "Visibility: true = group members only, false = publicly visible. " +
        "Loomio's validator enforces this against the group's `discussion_privacy_options`: " +
        "`public_only` requires `private: false`, `private_only` requires `private: true`, " +
        "`public_or_private` allows either. " +
        "When omitted, the connector reads the group's setting and chooses the value Loomio's " +
        "web UI would pick: `false` for `public_only`, `true` otherwise (matching `Group#discussion_private_default`). " +
        "Pass an explicit value to override.",
    ),
  recipient_audience: z
    .enum(["group"])
    .optional()
    .describe("Audience selector for notification recipients. 'group' = notify whole group."),
  recipient_user_ids: z
    .array(positiveId)
    .optional()
    .describe("Explicit list of user IDs to notify."),
  recipient_emails: z
    .array(z.string().email())
    .optional()
    .describe("Explicit list of email addresses to notify."),
  recipient_message: z
    .string()
    .optional()
    .describe("Optional custom message to include in notifications."),
});

/**
 * Resolve the effective `private` value for a new discussion in
 * `group_id`. Mirrors Loomio's `Group#discussion_private_default`:
 *   public_only          → false
 *   private_only         → true
 *   public_or_private    → true   (Loomio's own default)
 *
 * Uses `GET /api/v1/groups/{id}?api_key=…`, which Loomio exposes
 * without session auth for any public-visible group. On 403 the
 * group is hidden — Loomio's validator forces every hidden group to
 * `private_only`, so `true` is the only valid choice.
 */
async function resolveDiscussionPrivate(groupId: number): Promise<boolean> {
  interface GroupShape {
    discussion_privacy_options?: string;
  }
  try {
    const resp = await loomioGet<{ groups?: GroupShape[] }>(`/v1/groups/${groupId}`);
    const opts = resp.groups?.[0]?.discussion_privacy_options;
    return opts !== "public_only";
  } catch (err) {
    // A 403 specifically means the group is hidden from us, and
    // Loomio's GroupPrivacy validator forces every hidden group to
    // `private_only`, so `true` is the only valid fallback.
    if ((err instanceof LoomioAuthError || err instanceof LoomioApiError) && err.status === 403) {
      return true;
    }
    throw err;
  }
}

export async function createDiscussion(input: z.infer<typeof createDiscussionSchema>) {
  if (isReadOnly()) throw new LoomioReadOnlyError("POST");
  const priv =
    input.private !== undefined ? input.private : await resolveDiscussionPrivate(input.group_id);
  return loomioPost<unknown>("/b2/discussions", { ...input, private: priv });
}
