import { z } from "zod";
import { loomioGet, loomioPost } from "../loomio/client.js";
import { positiveId } from "./_common.js";

// ── list_memberships ────────────────────────────────────────────────────────

export const listMembershipsSchema = z.object({
  group_id: positiveId.describe(
    "ID of the Loomio group whose memberships to list (required). Caller must be a group admin; the response includes member email addresses.",
  ),
  limit: z.number().int().min(1).max(200).optional().describe("Page size. Loomio defaults to 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
});

export async function listMemberships(input: z.infer<typeof listMembershipsSchema>) {
  return loomioGet<unknown>("/b2/memberships", {
    group_id: input.group_id,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });
}

// ── manage_memberships ──────────────────────────────────────────────────────
//
// SAFETY:
//
//   POST /b2/memberships with `remove_absent: true` REMOVES every
//   member of the group not listed in `emails`. The empty-list case
//   removes EVERYONE. There is no Loomio-side dry-run; the call is
//   destructive on submit.
//
//   Default is `remove_absent: false` (additive only). Read existing
//   members with list_memberships before any call that sets
//   remove_absent=true, and confirm the diff with a human.
//
// Body shape: flat (this controller reads params directly, no
// Snorlax wrapping happens here).

export const manageMembershipsSchema = z.object({
  group_id: positiveId.describe(
    "ID of the Loomio group to modify (required). Caller must be a group admin.",
  ),
  emails: z
    .array(z.string().email())
    .min(1)
    .describe(
      "Email addresses to ensure are members. Each address that isn't already a member is invited / added.",
    ),
  remove_absent: z
    .boolean()
    .optional()
    .describe(
      "DANGEROUS. When true, Loomio REMOVES every existing member whose email is NOT in `emails`. " +
        "Empty-emails (after dedupe) effectively removes the entire group. " +
        "Default false. Only set true after reading list_memberships and confirming the diff with a human.",
    ),
});

export async function manageMemberships(input: z.infer<typeof manageMembershipsSchema>) {
  return loomioPost<unknown>("/b2/memberships", input);
}
