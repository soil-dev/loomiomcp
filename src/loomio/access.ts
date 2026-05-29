/**
 * Access classification for role-gated Loomio endpoints.
 *
 * The problem: Loomio answers a 403 with a bare `{"error":403}` and no
 * detail, and it returns that SAME response in two very different
 * situations:
 *
 *   1. the connector's API key is invalid / expired, or the bot user
 *      isn't a member of the group at all; and
 *   2. the key is perfectly valid and the bot IS a member, but the
 *      endpoint needs the group-admin (coordinator) role and the bot
 *      only has the plain member role.
 *
 * From the 403 alone they're indistinguishable, so a tool that just
 * surfaces "Loomio returned 403" leaves the caller (and the human)
 * guessing whether it's a broken key, a missing membership, or a
 * deliberate permission boundary.
 *
 * The fix: when an admin-gated call 403s, probe a MEMBER-gated endpoint
 * (`b2/polls`) for the same group with the same key. That call is
 * readable by any group member, so its result disambiguates:
 *
 *   probe 200 → key valid + bot is a member → the original 403 was the
 *               ADMIN-role boundary (case 2).
 *   probe 403 → the key can't see this group at all (case 1).
 *
 * `classifyGroupForbidden` runs that probe; `adminRequiredError` turns
 * the classification into a clear, actionable error. Both are used by
 * the membership tools (src/tools/memberships.ts).
 */

import { LoomioAuthError, loomioGetStatus } from "./client.js";

export type ForbiddenClassification =
  | { kind: "not_admin" } // key valid, bot is a member, just not an admin/coordinator
  | { kind: "no_access" } // key invalid/expired, or bot is not a member of the group
  | { kind: "inconclusive"; probeStatus: number }; // probe returned something unexpected

/**
 * Classify a 403 from an admin-gated group endpoint by probing the
 * member-gated `b2/polls` endpoint for the same group. See the module
 * comment for the reasoning. Returns a best-effort classification;
 * network/timeout errors from the probe propagate to the caller.
 */
export async function classifyGroupForbidden(groupId: number): Promise<ForbiddenClassification> {
  const probeStatus = await loomioGetStatus("/b2/polls", {
    group_id: groupId,
    limit: 1,
    status: "all",
  });
  if (probeStatus === 200) return { kind: "not_admin" };
  if (probeStatus === 403) return { kind: "no_access" };
  return { kind: "inconclusive", probeStatus };
}

export interface AdminRequiredErrorOptions {
  groupId: number;
  /** Human description of the data being requested, e.g. "the member list (names, emails, roles)". */
  resource: string;
  classification: ForbiddenClassification;
  /** Optional "you can still…" hint appended to the not_admin / inconclusive cases. */
  fallback?: string;
}

/**
 * Build a clear `LoomioAuthError` (status 403) for a denied admin-gated
 * read, tailored to the classification so the message explains *why*
 * access failed and what — if anything — to do about it.
 */
export function adminRequiredError(opts: AdminRequiredErrorOptions): LoomioAuthError {
  const { groupId, resource, classification, fallback } = opts;
  const tail = fallback ? ` ${fallback}` : "";

  switch (classification.kind) {
    case "not_admin":
      return new LoomioAuthError(
        `Loomio denied access to ${resource} for group ${groupId} (HTTP 403). ` +
          `The connector's Loomio key is valid — it can read group ${groupId} — but this data is only ` +
          `visible to a group admin (coordinator), and the connector's bot user is a plain member. ` +
          `This is a Loomio permission boundary, not a connector or client bug, and it is often ` +
          `intentional: the bot is deliberately kept as a non-admin so it can't read everyone's email. ` +
          `If this data is genuinely needed, a coordinator of group ${groupId} can grant the bot the ` +
          `coordinator role (Loomio → the group → Members → the bot user → Make coordinator).${tail}`,
        403,
      );
    case "no_access":
      return new LoomioAuthError(
        `Loomio denied access to ${resource} for group ${groupId} (HTTP 403), and a follow-up check ` +
          `shows the connector can't read group ${groupId} at all. That means one of: the Loomio API key ` +
          `is invalid or expired, or the connector's bot user is not a member of group ${groupId}. ` +
          `Verify LOOMIO_API_KEY and that the bot has been added to the group.`,
        403,
      );
    default:
      return new LoomioAuthError(
        `Loomio denied access to ${resource} for group ${groupId} (HTTP 403). This endpoint typically ` +
          `requires the connector's bot user to be an admin (coordinator) of the group, but a follow-up ` +
          `access check was inconclusive (HTTP ${classification.probeStatus}), so the exact cause — missing ` +
          `admin role, an invalid key, or the bot not being a member — couldn't be confirmed. Verify the ` +
          `group id, the API key, and the bot's role on the group.${tail}`,
        403,
      );
  }
}
