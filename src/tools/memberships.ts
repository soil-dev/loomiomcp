import { z } from "zod";
import { loomioGet, loomioPost } from "../loomio/client.js";
import { positiveId } from "./_common.js";

// ── list_memberships ────────────────────────────────────────────────────────
//
// Who sees what (Loomio 3.8.1 — Api::B2::MembershipsController#index,
// MembershipQuery.visible_to, MembershipSerializer):
//
//   - The roster (ids, names, usernames, admin / delegate flags, title,
//     accepted_at) is visible to ANY member of the group, and to admins
//     of the parent group when the subgroup is visible to parent
//     members. No admin role is needed to read it.
//   - `user_email` is serialized only for groups in the connector user's
//     `adminable_group_ids`, plus memberships that user invited itself
//     (`include_user_email?`). A plain member gets the roster WITHOUT
//     email addresses — silently, no error.
//   - A NON-member is not refused: `accessible_records` is scoped to the
//     user's own groups, so the controller finds nothing and answers 200
//     with `memberships: []`. Instance `is_admin` does not widen this
//     (Loomio's own test: "instance admin not in group cannot list
//     memberships or email addresses").
//
// That last point is why the empty case is annotated below. A real group
// always has at least its creator, so an empty roster almost always
// means "the connector's user is not a member" — and Loomio gives no
// other signal. Without the note an agent reads `memberships: []` as
// "this group is empty" and reports that as fact.
//
// 403s (rotated key, WAF) are classified by the HTTP client
// (`classifyForbidden` in src/loomio/client.ts); nothing here needs to
// probe or re-explain them. The connector's earlier "access fence" —
// a follow-up request to b2/polls to tell a bad key from a missing
// admin role — predates Loomio's distinguishable 403 bodies and is gone.

export const listMembershipsSchema = z.object({
  group_id: positiveId.describe(
    "ID of the Loomio group whose memberships to list (required). Any member of the group can list " +
      "its roster (ids, names, usernames, roles, join state); `user_email` is included only for groups " +
      "where the connector's user is an admin (coordinator), or for members it invited. If the " +
      "connector's user is not a member (or the group is hidden from it), Loomio answers 200 with an " +
      "EMPTY list — not 403 — and the connector adds `scope.note` saying so.",
  ),
  limit: z.number().int().min(1).max(200).optional().describe("Page size. Loomio defaults to 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Defaults to 0."),
});

/**
 * Loomio's collection response: the `memberships` root is always present
 * (Snorlax renders `[]` for an empty collection), with side-loaded
 * `users` / `groups` and a `meta` block alongside. Passed through as-is.
 */
interface MembershipsResponse {
  memberships?: unknown[];
  [key: string]: unknown;
}

export const EMPTY_ROSTER_NOTE =
  "Empty list: the connector's user is not a member of this group (or the group is hidden from it). " +
  "Loomio returns an empty list, not 403, in that case.";

export async function listMemberships(input: z.infer<typeof listMembershipsSchema>) {
  const resp = await loomioGet<MembershipsResponse>("/b2/memberships", {
    group_id: input.group_id,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });
  const memberships = Array.isArray(resp.memberships) ? resp.memberships : [];
  if (memberships.length > 0) return resp;
  // An empty page past the end of a real roster is the one benign
  // reading; only possible when the caller paginated.
  const offsetNote = input.offset
    ? ` (With offset=${input.offset} it can also simply be a page past the end of the roster.)`
    : "";
  return { ...resp, scope: { note: `${EMPTY_ROSTER_NOTE}${offsetNote}` } };
}

// ── manage_memberships ──────────────────────────────────────────────────────
//
// SAFETY:
//
//   POST /b2/memberships with `remove_absent` REMOVES every member of the
//   group whose email is not listed in `emails`. Per Loomio's controller
//   (`current_emails = User.active.where(id: group.memberships…)` and
//   `MembershipService.revoke` on each absentee) that includes:
//     - pending invitees — `group.memberships` is the `active` scope
//       (revoked_at IS NULL), which still contains not-yet-accepted
//       memberships;
//     - the connector's OWN user, if its email is absent — locking the
//       connector out of the group;
//     - the same users' memberships in every SUBGROUP —
//       `MembershipService.revoke` cascades over `id_and_subgroup_ids`.
//   There is no Loomio-side dry-run; the call is destructive on submit.
//
//   Default is additive only. Read existing members with list_memberships
//   before any call that sets remove_absent=true, and confirm the diff
//   with a human.
//
// AUTH: `authorize_manage_group!` requires the connector's user to be an
// admin (coordinator) of THAT group — `adminable_group_ids.include?` —
// and answers 403 `{"error":"User is not an admin"}` otherwise. Admin of
// the parent group and instance `is_admin` do not count (Loomio's own
// test: "instance admin not in group cannot remove members").
//
// WIRE FORMAT: flat body — this controller reads `params[:emails]` and
// `params[:remove_absent]` directly, no Snorlax wrapping. `remove_absent`
// is read as `params[:remove_absent].to_i == 1`. A JSON `true` has no
// `#to_i` in Ruby, so sending the boolean makes the controller raise
// NoMethodError → HTTP 500 — AFTER `GroupService.invite` has already sent
// the invitations. The connector therefore sends the integer `1` when
// the flag is set and omits the key entirely otherwise (Loomio's own
// controller test posts `remove_absent: 1`).

export const manageMembershipsSchema = z.object({
  group_id: positiveId.describe(
    "ID of the Loomio group to modify (required). The connector's user must be an admin (coordinator) " +
      'of this group; Loomio answers 403 "User is not an admin" otherwise.',
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
      "DANGEROUS. When true, Loomio REMOVES every existing member whose email is NOT in `emails` — " +
        "including pending invitees, the connector's own user if its email is absent, and the same " +
        "users' memberships in every subgroup. Empty-emails (after dedupe) effectively removes the " +
        "entire group. Default false. Only set true after reading list_memberships and confirming " +
        "the diff with a human.",
    ),
});

export interface ManageMembershipsResponse {
  /** Emails that were newly added / invited by this call. */
  added_emails: string[];
  /** Emails whose memberships this call revoked (always [] unless remove_absent). */
  removed_emails: string[];
}

export async function manageMemberships(input: z.infer<typeof manageMembershipsSchema>) {
  const body: Record<string, unknown> = { group_id: input.group_id, emails: input.emails };
  // Integer 1, or nothing — never the JSON boolean. See WIRE FORMAT above.
  if (input.remove_absent) body["remove_absent"] = 1;
  return loomioPost<ManageMembershipsResponse>("/b2/memberships", body);
}
