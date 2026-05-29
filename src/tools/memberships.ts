import { z } from "zod";
import { LoomioAuthError, loomioGet, loomioPost } from "../loomio/client.js";
import { adminRequiredError, classifyGroupForbidden } from "../loomio/access.js";
import { positiveId } from "./_common.js";

// Member display names, usernames, and ids — everything except email —
// are readable WITHOUT the admin role via the group's event stream.
// Pointed to in the not-admin error so the caller has a path forward.
const NON_ADMIN_FALLBACK =
  "Member display names, usernames, and ids (but not email addresses) are available without admin " +
  "via get_user_activity / list_events, which read the group's event stream.";

// Turn a 403 from an admin-gated membership call into an explanatory
// error. Runs the access probe to classify the denial; if the probe
// ITSELF errors (network/timeout), don't mask the real 403 with a
// probe-side 504 — fall back to the original error, which already
// carries a useful both-causes message.
async function explainForbidden(
  groupId: number,
  original: LoomioAuthError,
  resource: string,
  fallback?: string,
): Promise<Error> {
  try {
    const classification = await classifyGroupForbidden(groupId);
    return adminRequiredError({ groupId, resource, classification, fallback });
  } catch {
    return original;
  }
}

// ── list_memberships ────────────────────────────────────────────────────────

export const listMembershipsSchema = z.object({
  group_id: positiveId.describe(
    "ID of the Loomio group whose memberships to list (required). The connector's bot user must be an " +
      "admin (coordinator) of the group — Loomio only returns the member list, including email addresses, " +
      "to group admins. For a non-admin bot this returns a clear 403 explaining the role requirement; " +
      "names/usernames/ids (not emails) are still reachable via get_user_activity / list_events.",
  ),
  limit: z.number().int().min(1).max(200).optional().describe("Page size. Loomio defaults to 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
});

export async function listMemberships(input: z.infer<typeof listMembershipsSchema>) {
  try {
    return await loomioGet<unknown>("/b2/memberships", {
      group_id: input.group_id,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    });
  } catch (err) {
    // Admin-gated read. Loomio's 403 body can't tell "bad key" from
    // "valid key, not an admin" — probe a member-gated endpoint to
    // classify, then throw an error that actually explains why.
    if (err instanceof LoomioAuthError && err.status === 403) {
      throw await explainForbidden(
        input.group_id,
        err,
        "the member list (names, emails, roles)",
        NON_ADMIN_FALLBACK,
      );
    }
    throw err;
  }
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
  try {
    return await loomioPost<unknown>("/b2/memberships", input);
  } catch (err) {
    // Same admin gate as the read side: only coordinators can change a
    // group's membership. Classify the 403 and explain the role
    // requirement instead of surfacing a bare "Loomio returned 403".
    if (err instanceof LoomioAuthError && err.status === 403) {
      throw await explainForbidden(input.group_id, err, "membership changes");
    }
    throw err;
  }
}
