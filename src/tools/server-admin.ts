import { z } from "zod";
import {
  LoomioApiError,
  loomioDeleteB3,
  loomioGetB3,
  loomioPatchB3,
  loomioPostB3,
  nestedBody,
} from "../loomio/client.js";
import { pick } from "../loomio/shape.js";
import { positiveId } from "./_common.js";

// ── b3 provisioning: groups and memberships (Loomio ≥ 3.13.0) ──────────────
//
// Routes (config/routes.rb@v3.13.1:113-115, `namespace :b3`):
// `resources :groups, only: [:index]` and `resources :memberships, only:
// [:index, :create, :update, :destroy]` — added in 3.13.0 (ee6befeb7,
// "Add server API account and membership provisioning"). Controllers:
// app/controllers/api/b3/groups_controller.rb:1-11 and
// app/controllers/api/b3/memberships_controller.rb:1-57, over
// app/services/server_membership_service.rb; behaviour pinned by
// test/integration/b3_provisioning_test.rb and documented in
// docs/help/en/user_manual/integrations/api/server-api.md. Verified ONLY
// through that source, those tests and those docs: the reference
// deployment holds no b3 secret, so there are no live b3 captures. On
// Loomio < 3.13.0 every one of these routes is a 404 (no such route).
//
// Shared rules (every tool below):
//   - Auth: `Authorization: Bearer <LOOMIO_B3_API_KEY>`, the
//     server-instance secret checked by `Api::B3::BaseController#
//     authenticate_api_key!` — never the per-user key. Registered only
//     when that secret is set AND the server is not read-only (the
//     writes also refuse in read-only mode, in the client).
//   - No ACTOR: ServerMembershipService passes `actor: nil` everywhere —
//     memberships carry no inviter / revoker, notifications no actor
//     ("These operations intentionally have no user actor or
//     group-membership requirement"). The connector's own `tool.call`
//     log line is the only trail of who asked.
//   - Paging: both indexes call `page_collection_bounded` with its
//     default `limit_max: 50` (the b3 base controller does not raise it
//     the way b2's does to 500; snorlax_base.rb:218-222): `offset`
//     negative → 0, `limit.to_i.clamp(1, 50)`, so `limit=0` would return
//     ONE row. The connector always sends `limit` (default 50) and
//     `offset`, and computes `next_offset = offset + returned < total ?
//     offset + returned : null` from `meta.total`, which both indexes
//     count before paging. Rows are ordered by id.
//   - Errors: the bodies are bare. `ServerMembershipService::
//     InvalidParameters` (bad email list, bad boolean, no role given)
//     and `ParameterMissing` / `UnpermittedParameters` answer `{"error":
//     400}`; an unknown or deleted group, an unknown or revoked
//     membership — and, on an older Loomio, the route itself — answer
//     404; `{"error":403}` is Subscription::NotActive (b3/base_controller.rb:6)
//     or MaxMembersExceeded (the client classifies it as `plan_limit`).
//     A 422 is a RecordInvalid SnorlaxBase renders (snorlax_base.rb:8),
//     and add_group_members has two: a listed address that belongs to a
//     deactivated account (`{"errors":{"email":["belongs to a deactivated
//     account"]}}`), or a NEW address the User model refuses to create —
//     in practice `{"errors":{"email":["no spam"]}}` (below).
//     `explainB3Error` turns the bare ones into a sentence per operation
//     and tells the two 422s apart.
//
// Deliberately NOT exposed (README "Deliberately not exposed", SECURITY.md):
//   - `remove_absent` on `POST /b3/memberships`. A sync with an empty or
//     wrong list revokes everyone absent from it — admins included,
//     across every subgroup (`revoke` → `MembershipService.revoke_by_id(
//     group.id_and_subgroup_ids, …)`), with no admin check, in one
//     transaction (the upstream test "explicit sync revokes absent
//     members" ends with `assert_empty @group.memberships`). The add tool
//     builds its body field by field and its schema is strict, so the key
//     can neither be sent nor smuggled through.
//   - `POST /b3/users`: `is_admin` is a permitted field, so it creates
//     INSTANCE admins; with a name and DEFAULT_ONBOARDING_GROUP_ID set it
//     also silently joins a group. add_group_members already creates the
//     accounts it needs (`User.find_or_create_by!(email:)`).
//   - `PATCH` / `DELETE` / redact on `/b3/users` and their identity
//     variants: `is_admin` escalation, an email change hands the login to
//     whoever owns the new address, and delete / redact are irreversible.
//   - The `PUT` alias Rails' `resources` generates beside each PATCH.

/**
 * Rows per b3 page: `page_collection_bounded`'s default `limit_max: 50`,
 * which `Api::B3::BaseController` does not override (B2's is 500). A
 * larger `limit` is clamped by Loomio, so the schema stops at 50.
 */
export const B3_PAGE_MAX = 50;

/**
 * The connector's cap on one add_group_members call — not Loomio's,
 * which takes any length. b3 skips what bounds a USER's invitations on
 * b2, the per-actor ThrottleService limit (`actor: nil`;
 * `User.find_or_create_by!` instead of `UserInviter.where_or_create!`).
 * The spam filter still applies to NEW accounts, differently: b2's
 * `UserInviter.safe_emails` (user_inviter.rb:181-188) silently drops an
 * address matching the instance's `SPAM_REGEX`, while b3's
 * `find_or_create_by!` runs the User model's `no_spam_for :email`
 * validation (user.rb:15, concerns/no_spam.rb — the env's SPAM_REGEX,
 * two domains by default), which fails the WHOLE call with a 422. An
 * existing account is found, not validated. Loomio's delivery-time spam
 * and suppression filtering (notification_mailer.rb:154) applies on top.
 * 50 keeps one call's invitation volume reviewable by the human who
 * must confirm it, and matches the b3 page size.
 */
export const MAX_ADD_EMAILS = 50;

/** One row of `GET /b3/groups`: exactly these six keys (groups_controller.rb:6; upstream test asserts the key set). */
export interface B3Group {
  id: number;
  key: string;
  name: string;
  handle: string | null;
  parent_id: number | null;
  /** 'open' | 'closed' | 'parent_members' | 'secret' (`parent_members` since 3.11.0). */
  group_privacy: string;
}

/**
 * One membership as `membership_json` renders it
 * (memberships_controller.rb:44-56): the index rows and the PATCH echo.
 * Loomio enumerates these fields deliberately — no tokens, credentials,
 * notification settings or votes.
 */
export interface B3Membership {
  /** The MEMBERSHIP id — what update_membership_roles / revoke_membership take. Not a user id. */
  id: number;
  group_id: number;
  user_id: number;
  user_email: string | null;
  user_name: string | null;
  admin: boolean;
  delegate: boolean;
  accepted_at: string | null;
  /** `accepted_at.nil?`: an invitation not yet accepted. */
  pending: boolean;
}

const GROUP_FIELDS = ["id", "key", "name", "handle", "parent_id", "group_privacy"] as const;
const MEMBERSHIP_FIELDS = [
  "id",
  "group_id",
  "user_id",
  "user_email",
  "user_name",
  "admin",
  "delegate",
  "accepted_at",
  "pending",
] as const;

interface B3Page {
  meta?: { total?: number };
}
interface B3GroupsResponse extends B3Page {
  groups?: B3Group[];
}
interface B3MembershipsResponse extends B3Page {
  memberships?: B3Membership[];
}
/** `ServerMembershipService.sync`'s return value, rendered as is. */
interface B3SyncResponse {
  added_emails?: string[];
  removed_emails?: string[];
}
interface B3MembershipResponse {
  membership?: B3Membership;
}

// ── Errors ──────────────────────────────────────────────────────────────────

type B3Operation =
  | "list_instance_groups"
  | "list_instance_memberships"
  | "add_group_members"
  | "update_membership_roles"
  | "revoke_membership";

const OLDER_LOOMIO = "Loomio older than 3.13.0 (no such route)";
const NOTHING_CHANGED = "Nothing was changed.";

/**
 * Re-word the bare b3 error bodies (`{"error":404}` reads as "Loomio
 * API error 404: 404") into what they mean for THIS operation. 403s
 * arrive already classified by the client (b3 secret vs plan /
 * subscription), anything else passes through untouched. Every write
 * here is one transaction on Loomio's side, so a 400 / 404 / 422 means
 * nothing happened — said explicitly, because the caller is deciding
 * whether to retry an action that emails people.
 */
function explainB3Error(err: unknown, op: B3Operation, id?: number): never {
  if (!(err instanceof LoomioApiError)) throw err;
  if (err.status === 404) {
    const why: Record<B3Operation, string> = {
      list_instance_groups: `GET /b3/groups names no record, so only the route can be missing: ${OLDER_LOOMIO}.`,
      list_instance_memberships: `Group ${id} is unknown or deleted, or this is ${OLDER_LOOMIO}. Group ids: list_instance_groups.`,
      add_group_members: `Group ${id} is unknown or deleted, or this is ${OLDER_LOOMIO}. ${NOTHING_CHANGED}`,
      update_membership_roles:
        `Membership ${id} is unknown or REVOKED (Loomio answers 404 for a revoked membership; ` +
        `add_group_members re-adds the person), or this is ${OLDER_LOOMIO}. Membership ids come ` +
        `from list_instance_memberships — a user id is not one. ${NOTHING_CHANGED}`,
      revoke_membership:
        `Membership ${id} is unknown or its group is deleted, or this is ${OLDER_LOOMIO}. An ` +
        `already revoked membership is NOT a 404 (repeating a revoke succeeds). Membership ids come ` +
        `from list_instance_memberships — a user id is not one. ${NOTHING_CHANGED}`,
    };
    throw new LoomioApiError(404, `Loomio answered 404 for ${op}. ${why[op]}`);
  }
  if (err.status === 400 && op === "add_group_members") {
    throw new LoomioApiError(
      400,
      'Loomio answered 400 (a bare {"error":400}) for add_group_members: an address failed ' +
        "Loomio's email check or is longer than 200 characters. The call is all-or-nothing: " +
        `${NOTHING_CHANGED} Fix or drop that address and retry.`,
    );
  }
  if (err.status === 400 && op === "update_membership_roles") {
    throw new LoomioApiError(
      400,
      'Loomio answered 400 (a bare {"error":400}) for update_membership_roles: an invalid role ' +
        `value, or no role given — send \`admin\` and/or \`delegate\` as booleans. ${NOTHING_CHANGED}`,
    );
  }
  if (err.status === 422 && op === "add_group_members") {
    // Two causes, told apart by Loomio's own text (which `err.message`
    // carries as "email: …"): the deactivated-account check, or the User
    // model refusing to create a new account ("no spam"; see
    // MAX_ADD_EMAILS). Blaming every 422 on a deactivation sent callers
    // to reactivate a user who does not exist.
    const nothing = "nothing was changed (all-or-nothing, no account created, no invitation sent).";
    if (/deactivated/i.test(err.message)) {
      throw new LoomioApiError(
        422,
        `${err.message} — a listed address belongs to a DEACTIVATED account: reactivate_user ` +
          `first (Loomio never reactivates implicitly); ${nothing}`,
      );
    }
    throw new LoomioApiError(
      422,
      `${err.message} — Loomio refused to create an account for a listed address (e.g. 'no ` +
        "spam': it matches the instance's SPAM_REGEX); " +
        `${nothing} Drop that address and retry.`,
    );
  }
  throw err;
}

// ── Paging ──────────────────────────────────────────────────────────────────

const limitField = z
  .number()
  .int()
  .min(1)
  .max(B3_PAGE_MAX)
  .optional()
  .describe("Rows per page, 1-50 (Loomio's cap). Default 50.");
const offsetField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Pass the previous `next_offset`. Default 0.");

interface PageWindow {
  total: number;
  returned: number;
  next_offset: number | null;
}

/**
 * `total` / `next_offset` for one b3 page. `meta.total` is always sent
 * (both indexes count before paging); were it missing, a full page is
 * the only "more may follow" signal. An empty page never points onward,
 * so a caller looping on `next_offset` always terminates.
 */
function pageWindow(
  offset: number,
  limit: number,
  returned: number,
  metaTotal: unknown,
): PageWindow {
  const end = offset + returned;
  if (typeof metaTotal === "number") {
    return {
      total: metaTotal,
      returned,
      next_offset: returned > 0 && end < metaTotal ? end : null,
    };
  }
  return { total: end, returned, next_offset: returned >= limit && returned > 0 ? end : null };
}

// ── list_instance_groups ────────────────────────────────────────────────────
//
// `GET /b3/groups?limit&offset` → `Group.kept.order(:id)`: EVERY group
// that is not deleted — secret ones, ones with expired subscriptions,
// subgroups, groups the connector's user has never heard of — sliced
// to six fields (upstream test "server key lists private and public
// groups across the instance with bounded pagination").

export const listInstanceGroupsSchema = z.object({
  limit: limitField,
  offset: offsetField,
});

export interface ListInstanceGroupsResult extends PageWindow {
  groups: B3Group[];
  scope: { limit: number; offset: number; note: string };
}

export async function listInstanceGroups(
  input: z.infer<typeof listInstanceGroupsSchema> = {},
): Promise<ListInstanceGroupsResult> {
  const limit = input.limit ?? B3_PAGE_MAX;
  const offset = input.offset ?? 0;
  let body: B3GroupsResponse;
  try {
    body = await loomioGetB3<B3GroupsResponse>("/b3/groups", { limit, offset });
  } catch (err) {
    explainB3Error(err, "list_instance_groups");
  }
  const groups = (Array.isArray(body.groups) ? body.groups : []).map(
    (g) => pick(g, GROUP_FIELDS) as B3Group,
  );
  return {
    groups,
    ...pageWindow(offset, limit, groups.length, body.meta?.total),
    scope: {
      limit,
      offset,
      note:
        "Every non-deleted group on the Loomio instance, ordered by id — secret groups and groups " +
        "with expired subscriptions included, whether or not the connector's user is a member " +
        "(b3 has no visibility filter). Continue with `offset: next_offset` until it is null.",
    },
  };
}

// ── list_instance_memberships ───────────────────────────────────────────────
//
// `GET /b3/memberships?group_id&limit&offset` → `group.memberships`
// (the ACTIVE scope: `revoked_at IS NULL`, pending invitations
// included) of one kept group, ordered by id. DIRECT members only:
// subgroup rosters are separate groups. Every row carries the member's
// email whoever the connector's user is (upstream test "server
// membership listing includes roles and pending state but no
// credentials or voting data") — hence single-tenant deployments only.

export const listInstanceMembershipsSchema = z.object({
  group_id: positiveId.describe("Group id (list_instance_groups)."),
  limit: limitField,
  offset: offsetField,
});

export interface ListInstanceMembershipsResult extends PageWindow {
  memberships: B3Membership[];
  scope: { group_id: number; limit: number; offset: number; note: string };
}

export async function listInstanceMemberships(
  input: z.infer<typeof listInstanceMembershipsSchema>,
): Promise<ListInstanceMembershipsResult> {
  const limit = input.limit ?? B3_PAGE_MAX;
  const offset = input.offset ?? 0;
  let body: B3MembershipsResponse;
  try {
    body = await loomioGetB3<B3MembershipsResponse>("/b3/memberships", {
      group_id: input.group_id,
      limit,
      offset,
    });
  } catch (err) {
    explainB3Error(err, "list_instance_memberships", input.group_id);
  }
  const memberships = (Array.isArray(body.memberships) ? body.memberships : []).map(
    (m) => pick(m, MEMBERSHIP_FIELDS) as B3Membership,
  );
  return {
    memberships,
    ...pageWindow(offset, limit, memberships.length, body.meta?.total),
    scope: {
      group_id: input.group_id,
      limit,
      offset,
      note:
        "Active memberships of this group, pending invitations included (`pending: true`), revoked " +
        "ones excluded; DIRECT members only (each subgroup has its own roster). Every row carries " +
        "the member's email. `id` is the membership id update_membership_roles and " +
        "revoke_membership take.",
    },
  };
}

// ── add_group_members ───────────────────────────────────────────────────────
//
// `POST /b3/memberships` with exactly `{group_id, emails}` →
// `ServerMembershipService.sync(group:, emails:, remove_absent: false)`.
// What one call does, in ONE transaction (all-or-nothing):
//   - validates the whole list first: an array of strings, each ≤ 200
//     chars and matching `EmailValidator::EMAIL_REGEXP`, else 400;
//     `raise Subscription::NotActive unless group.enabled?` (403);
//   - normalises (`strip.downcase`, `uniq`) and `User.find_or_create_by!`
//     each address — an unknown one becomes a new, UNVERIFIED account,
//     validated on creation: an address matching the instance's
//     SPAM_REGEX fails the whole call with 422 "no spam";
//   - refuses the whole call with 422 if any listed account is
//     deactivated (it never reactivates implicitly);
//   - `added = emails - current_emails`, where `current_emails` are the
//     group's members' STORED addresses compared case-sensitively — so a
//     member whose stored address differs only in case is re-invited
//     and reported as added;
//   - checks the member cap (`UserInviter.check_members_limit!`, 403),
//     then `GroupService.invite_users(actor: nil)`: a pending membership
//     and Loomio's invitation EMAIL for each added person, except that
//     verified members of another enabled group of the same organisation
//     are accepted at once; a previously revoked membership is restored
//     (see revoke_membership); open-poll ballots follow asynchronously
//     (`PollGroupMembersAddedWorker`).
// The body is built here field by field — never by spreading the input —
// and the schema is strict, so `remove_absent` (see the module note)
// can never reach Loomio. Without it `sync` only adds:
// `removed_emails` is always `[]`, relayed as received so a future
// Loomio that removed anyone could not do so invisibly. Not idempotent
// for the MCP annotation's purposes: the case-differing re-invite above
// repeats on every replay.

export const addGroupMembersSchema = z.strictObject({
  group_id: positiveId.describe("Group id (list_instance_groups)."),
  emails: z
    .array(z.string().email())
    .min(1)
    .max(MAX_ADD_EMAILS)
    .describe("1-50 addresses; Loomio trims, lowercases and dedupes them."),
});

export type AddGroupMembersInput = z.infer<typeof addGroupMembersSchema>;

export interface AddGroupMembersResult {
  group_id: number;
  /** Loomio's `added_emails`: newly invited (or re-invited) addresses, normalised by Loomio. */
  added_emails: string[];
  /** The input normalised as Loomio does (trim, lowercase, dedupe) minus `added_emails`: already members. */
  unchanged_emails: string[];
  /** Loomio's `removed_emails`, as received — always `[]` because `remove_absent` is never sent. */
  removed_emails: string[];
  scope: { note: string };
}

/** `email.strip.downcase` then `uniq`, in input order — ServerMembershipService.sync's normalisation. */
export function normaliseEmails(emails: readonly string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()))];
}

export async function addGroupMembers(input: AddGroupMembersInput): Promise<AddGroupMembersResult> {
  // Exactly these two keys. See the section note: no spread, no remove_absent.
  const body = { group_id: input.group_id, emails: [...input.emails] };
  let resp: B3SyncResponse;
  try {
    resp = await loomioPostB3<B3SyncResponse>("/b3/memberships", body);
  } catch (err) {
    explainB3Error(err, "add_group_members", input.group_id);
  }
  if (!Array.isArray(resp.added_emails)) {
    // Without the list there is no telling who was invited; claiming
    // "unchanged" for everyone would be a lie about emails already sent.
    throw new LoomioApiError(
      502,
      "Loomio answered POST /b3/memberships without `added_emails`; the response shape is not the " +
        "one Loomio 3.13 produces. The call may have taken effect — check with " +
        "list_instance_memberships before retrying.",
    );
  }
  const added = resp.added_emails.map(String);
  const addedSet = new Set(added);
  return {
    group_id: input.group_id,
    added_emails: added,
    unchanged_emails: normaliseEmails(input.emails).filter((e) => !addedSet.has(e)),
    removed_emails: Array.isArray(resp.removed_emails) ? resp.removed_emails.map(String) : [],
    scope: {
      note:
        "Additive only: nobody was removed. Unknown addresses got a new, unverified account; " +
        "everyone in added_emails gets Loomio's invitation email (subject only to Loomio's " +
        "delivery-time spam and suppression filters) and stays pending until they accept, except " +
        "verified members of another group of the same organisation, who are accepted directly. " +
        "Loomio compares stored addresses case-sensitively, so a member whose stored address " +
        "differs only in case is re-invited and listed in added_emails.",
    },
  };
}

// ── update_membership_roles ─────────────────────────────────────────────────
//
// `PATCH /b3/memberships/{id}` with `{membership: {admin?, delegate?}}`
// (`params.require(:membership).permit(:admin, :delegate)`; any other
// key, a non-boolean value or an empty hash is a 400) →
// `ServerMembershipService.update`: `Membership.active.find` (a revoked
// membership is 404), `Subscription::NotActive` unless the group is
// enabled (403), then `update!` under a user lock. A role that turns ON
// notifies the member once (`new_coordinator` / `new_delegate`, no
// actor); repeating the same values changes and notifies nothing
// (upstream test "role updates maintain counts delegate profiles and
// transition notifications"). Omitted roles stay as they are. Nothing
// on Loomio's side stops demoting a group's LAST admin — the tool
// description says so. Only the keys given are sent, explicitly nested
// (see "Write bodies" in src/loomio/client.ts).

export const updateMembershipRolesSchema = z
  .strictObject({
    id: positiveId.describe("Membership id (list_instance_memberships), not a user id."),
    admin: z.boolean().optional().describe("Group admin (coordinator) role; omitted = unchanged."),
    delegate: z.boolean().optional().describe("Delegate role; omitted = unchanged."),
  })
  .superRefine((input, ctx) => {
    if (input.admin === undefined && input.delegate === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["admin"],
        message: "Pass admin and/or delegate (Loomio answers 400 when no role is given).",
      });
    }
  });

export type UpdateMembershipRolesInput = z.infer<typeof updateMembershipRolesSchema>;

export interface UpdateMembershipRolesResult {
  membership: B3Membership;
}

export async function updateMembershipRoles(
  input: UpdateMembershipRolesInput,
): Promise<UpdateMembershipRolesResult> {
  const roles: Record<string, boolean> = {};
  if (input.admin !== undefined) roles["admin"] = input.admin;
  if (input.delegate !== undefined) roles["delegate"] = input.delegate;
  const path = `/b3/memberships/${input.id}`;
  let resp: B3MembershipResponse;
  try {
    resp = await loomioPatchB3<B3MembershipResponse>(path, nestedBody("membership", roles));
  } catch (err) {
    explainB3Error(err, "update_membership_roles", input.id);
  }
  if (!resp.membership) {
    throw new LoomioApiError(
      502,
      "Loomio answered PATCH /b3/memberships/{id} without a `membership`; the response shape is not " +
        "the one Loomio 3.13 produces. The roles may have changed — check with " +
        "list_instance_memberships.",
    );
  }
  return { membership: pick(resp.membership, MEMBERSHIP_FIELDS) as B3Membership };
}

// ── revoke_membership ───────────────────────────────────────────────────────
//
// `DELETE /b3/memberships/{id}` → `ServerMembershipService.revoke` →
// `MembershipService.revoke_by_id(group.id_and_subgroup_ids, user_id,
// nil)` with `preserve_cast_votes: false`. Upstream test "server removal
// revokes subgroup membership topic access and active poll stances":
//   - the membership AND the person's memberships in every SUBGROUP are
//     revoked (other organisations' groups and direct threads untouched);
//   - their thread access in those groups is revoked (guest flags too);
//   - their stances in OPEN polls are revoked — votes already cast
//     included (only account deactivation preserves cast votes);
//   - no notification, no revoker recorded.
// `Membership.find` (not `.active`), so repeating the call on a revoked
// membership succeeds (b3_provisioning_test.rb:156-157) — the MCP
// idempotent hint. 404 = unknown membership or a deleted group.
//
// Undo is partial ("reinviting restores revoked access and voting
// without restoring administrator status"): add_group_members with the
// person's address restores the TARGET group's row, its thread access
// and its open-poll ballots — not the subgroups (separate rows, never
// re-invited), and not the admin role: `invite_users` resets `admin`,
// `accepted_at`, `inviter_id` and the revocation stamps only
// (group_service.rb:72-80), so the old `delegate` flag survives and
// the row comes back PENDING — with a fresh invitation email — unless
// the person is a verified member of another group of the organisation.

export const revokeMembershipSchema = z.strictObject({
  id: positiveId.describe("Membership id (list_instance_memberships), not a user id."),
});

export type RevokeMembershipInput = z.infer<typeof revokeMembershipSchema>;

export interface RevokeMembershipResult {
  success: true;
  membership_id: number;
  scope: { note: string };
}

export async function revokeMembership(
  input: RevokeMembershipInput,
): Promise<RevokeMembershipResult> {
  try {
    await loomioDeleteB3<{ success?: boolean }>(`/b3/memberships/${input.id}`);
  } catch (err) {
    explainB3Error(err, "revoke_membership", input.id);
  }
  return {
    success: true,
    membership_id: input.id,
    scope: {
      note:
        "Revoked. The person also lost the group's SUBGROUPS and its threads, and their votes in " +
        "open polls were revoked, cast votes included; no notification was sent and Loomio records " +
        "no actor. Repeating the call succeeds. Undo is partial: add_group_members restores THIS " +
        "group only (and its open-poll votes) — not the subgroups, not the admin role; the old " +
        "delegate flag survives, and the membership may come back pending with a fresh invitation " +
        "email.",
    },
  };
}
