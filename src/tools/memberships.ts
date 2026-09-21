import { z } from "zod";
import { loomioGet, loomioPost, readParams } from "../loomio/client.js";
import { pick, type SlimUser, slimUsers } from "../loomio/shape.js";
import type { LoomioMembership, MembershipsResponse } from "../loomio/types.js";
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
//     email addresses — silently, no error. That flag lives on the
//     MEMBERSHIP row; the `users[]` root never carries a member's
//     email (Loomio's own test "group admin can list member email
//     addresses" asserts `refute serialized_user.key?("email")`).
//   - The ONE `users[].email` this endpoint does emit is the API user's
//     OWN: `AuthorSerializer#include_email?` is true when
//     `scope[:current_user_id] == object.id`, and every b2 index sets
//     `current_user_id`. It is not roster data — it is the connector
//     account's mailbox, which on a shared deployment every caller
//     would otherwise learn from any member group — so the tool drops
//     `users[].email` entirely (there is nothing else it could be).
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
// Wire: `compact=1`. The roster needs no topics join and no group
// record (the caller passed the id), and `compact` drops the group,
// parent, membership-of-group, reaction, tag and translation side-loads
// while `users` — never droppable — still arrives (verified on a live
// 3.8.1 capture: roots `memberships`, `users`, `meta`). `user_email` is
// unaffected: it is a serializer scope decision, not a side-load. Each
// row is then reduced to its meaningful fields (`volume_*` and
// `experiences` are the API user's own notification settings and
// onboarding flags) and users are slimmed to id / name / username —
// `user_email` on the membership row is the only email that flows.
//
// 403s (rotated key, WAF) are classified by the HTTP client
// (`classifyForbidden` in src/loomio/client.ts); nothing here needs to
// probe or re-explain them.

export const listMembershipsSchema = z.object({
  group_id: positiveId.describe("Group id (a non-member gets an empty list, not 403)."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200. Default 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Default 0."),
});

const MEMBERSHIP_FIELDS = [
  "id",
  "user_id",
  "group_id",
  "admin",
  "delegate",
  "title",
  "inviter_id",
  "created_at",
  "accepted_at",
  "user_email",
] as const;

export type ShapedMembership = Pick<LoomioMembership, (typeof MEMBERSHIP_FIELDS)[number]>;

export interface ListMembershipsResult {
  memberships: ShapedMembership[];
  /**
   * Members and inviters referenced by the rows: id, name, username —
   * never `email`. Member emails Loomio entitles the user to arrive as
   * `user_email` on the membership row; the only `users[].email` this
   * endpoint emits is the connector account's own, which is dropped.
   */
  users: SlimUser[];
  /** Loomio's `meta.total`: the whole roster, before pagination. */
  total: number;
  returned: number;
  scope?: { note: string };
}

export const EMPTY_ROSTER_NOTE =
  "Empty list: the connector's user is not a member of this group (or the group is hidden from it). " +
  "Loomio returns an empty list, not 403, in that case.";

export async function listMemberships(
  input: z.infer<typeof listMembershipsSchema>,
): Promise<ListMembershipsResult> {
  const body = await loomioGet<MembershipsResponse>("/b2/memberships", {
    group_id: input.group_id,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...readParams("compact"),
  });
  const memberships = (Array.isArray(body.memberships) ? body.memberships : []).map((m) =>
    pick(m, MEMBERSHIP_FIELDS),
  );
  const out: ListMembershipsResult = {
    memberships,
    // No `includeEmail`: see the module note — the only users[].email
    // here is the API user's own.
    users: slimUsers(body.users),
    total: typeof body.meta?.total === "number" ? body.meta.total : memberships.length,
    returned: memberships.length,
  };
  if (memberships.length > 0) return out;
  // An empty page past the end of a real roster is the one benign
  // reading; only possible when the caller paginated.
  const offsetNote = input.offset
    ? ` (With offset=${input.offset} it can also simply be a page past the end of the roster.)`
    : "";
  return { ...out, scope: { note: `${EMPTY_ROSTER_NOTE}${offsetNote}` } };
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
  group_id: positiveId.describe("Group id; the connector's user must be its admin."),
  emails: z
    .array(z.string().email())
    .min(1)
    .describe("Addresses to ensure are members; new ones are invited."),
  remove_absent: z
    .boolean()
    .optional()
    .describe(
      "DANGEROUS: also revokes every member absent from `emails`, own user included. Default false.",
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
