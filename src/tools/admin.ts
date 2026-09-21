import { z } from "zod";
import { loomioGetB3, loomioPostB3 } from "../loomio/client.js";
import { positiveId } from "./_common.js";

// ── deactivate_user / reactivate_user (b3 admin) ────────────────────────────
//
// Routes (Loomio 3.8.1, config/routes.rb `namespace :b3`): the MEMBER
// routes `POST /api/b3/users/:id/deactivate` and `…/:id/reactivate`.
// The collection routes `POST /api/b3/users/deactivate?id=` still exist,
// but Loomio's OpenAPI document (docs/user_manual/integrations/api/
// openapi.yaml) marks them `deprecated: true` — "legacy query-ID route" —
// so the connector uses the path form. `id` is a schema-validated
// positive integer, so interpolating it into the path is safe.
//
// Auth: `Authorization: Bearer <B3_API_KEY>` — the server-instance secret
// (`ENV['B3_API_KEY']`, >16 chars), NOT a per-user API key. These tools
// are registered only when LOOMIO_B3_API_KEY is set, and skipped in
// read-only mode.
//
// Response (`Api::B3::UsersController#user_json`): `{ success: true,
// user: {…} }` for both. The two calls differ in timing:
//   - deactivate enqueues `DeactivateUserWorker` and returns at once. The
//     echoed `user` is re-read BEFORE the job runs, so it can still show
//     `active: true` / `deactivated_at: null`; the worker then stamps
//     `deactivated_at`, revokes every active membership with that
//     timestamp, revokes mobile devices and drops pending membership
//     requests. Re-read later to confirm.
//   - reactivate is synchronous (`UserService.reactivate`): it clears
//     `deactivated_at` AND restores the memberships whose `revoked_at`
//     equals the deactivation timestamp — i.e. exactly the memberships
//     the deactivation revoked come back. The echoed `user` is already
//     `active: true`.
//
// Both answer 404 (`RecordNotFound`) when the user is not in the expected
// state: deactivate finds in `User.active`, reactivate in
// `User.deactivated`.

export interface B3Identity {
  id: number;
  identity_type: string;
  uid: string;
  email: string | null;
  name: string | null;
}

/** One user as `Api::B3::UsersController#user_json` renders it. */
export interface B3User {
  id: number;
  name: string | null;
  username: string | null;
  email: string | null;
  is_admin: boolean;
  /** `deactivated_at.blank?` — see the timing note above for deactivate. */
  active: boolean;
  deactivated_at: string | null;
  identities: B3Identity[];
}

/** Loomio's `UserSuccess` response schema. */
export interface B3UserResponse {
  success: true;
  user: B3User;
}

export const deactivateUserSchema = z.object({
  id: positiveId.describe("User id (404 unless currently active)."),
});

export async function deactivateUser(
  input: z.infer<typeof deactivateUserSchema>,
): Promise<B3UserResponse> {
  return loomioPostB3<B3UserResponse>(`/b3/users/${input.id}/deactivate`);
}

export const reactivateUserSchema = z.object({
  id: positiveId.describe("User id (404 unless currently deactivated)."),
});

export async function reactivateUser(
  input: z.infer<typeof reactivateUserSchema>,
): Promise<B3UserResponse> {
  return loomioPostB3<B3UserResponse>(`/b3/users/${input.id}/reactivate`);
}

// ── get_user / list_users (b3 reads) ────────────────────────────────────────
//
// Routes (3.8.1 routes.rb, `namespace :b3`): `GET /api/b3/users`
// (`users#index`, optional `?is_admin=true|false`, ordered by id, NO
// pagination — the whole instance in one response), `GET
// /api/b3/users/:id` (`users#show`) and `GET
// /api/b3/users/identity/:identity_type/:uid` (`users#show_by_identity`,
// resolved through `Identity.with_user.find_by!(identity_type:, uid:)`).
// Proof: controller tests "index returns users with identities", "index
// filters users by admin status", "show returns a user", "show by
// identity returns a user" and "bearer token authenticates requests"
// (test/controllers/api/b3/users_controller_test.rb).
//
// Every row is `user_json` — id, name, username, EMAIL, is_admin,
// active, deactivated_at, identities[{id, identity_type, uid, email,
// name}] — for every account on the instance, active or not, member of
// the connector's groups or not. That is why these two are b3 tools
// gated like the writes (LOOMIO_B3_API_KEY set AND not read-only) and
// documented as single-tenant only: an operator exposing the connector
// to several organisations on one Loomio instance must not enable them.
// Same auth as deactivate/reactivate (`Authorization: Bearer
// <B3_API_KEY>`), same 403 semantics (`classifyForbidden` names the b3
// secret); an unknown id / identity answers 404 (`RecordNotFound`).
//
// Identity route caveat: Rails' default segment pattern excludes "." so
// a uid containing a dot (most emails) is split into uid + format by the
// router and answers 404 in 3.8.1. Address such users by numeric id.

/** `GET /b3/users/{id}` and `…/identity/{type}/{uid}` both answer `{ user }`. */
export interface B3UserShowResponse {
  user: B3User;
}

/** `GET /b3/users` answers `{ users }` — unpaginated, ordered by id. */
export interface B3UsersIndexResponse {
  users: B3User[];
}

export const getUserSchema = z
  .object({
    id: positiveId.optional().describe("User id. Pass this OR identity_type + uid."),
    identity_type: z
      .string()
      .min(1)
      .optional()
      .describe("Provider of a linked identity, e.g. 'saml'. Requires uid."),
    uid: z
      .string()
      .min(1)
      .optional()
      .describe("The identity's uid. One containing '.' cannot be resolved; use id instead."),
  })
  .superRefine((input, ctx) => {
    const byId = input.id !== undefined;
    const byIdentity = input.identity_type !== undefined || input.uid !== undefined;
    if (byId === byIdentity) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Pass exactly one of: id, or identity_type + uid.",
      });
    }
    if (byIdentity && (input.identity_type === undefined || input.uid === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["uid"],
        message: "identity_type and uid go together.",
      });
    }
  });

export type GetUserInput = z.infer<typeof getUserSchema>;

export interface GetUserResult {
  user: B3User;
  /** Which route answered: the id route or the identity route. */
  resolved_by: "id" | "identity";
}

export async function getUser(input: GetUserInput): Promise<GetUserResult> {
  if (input.id !== undefined) {
    const body = await loomioGetB3<B3UserShowResponse>(`/b3/users/${input.id}`);
    return { user: body.user, resolved_by: "id" };
  }
  // Both segments are caller strings; encode them so a uid with "/" or
  // "?" cannot rewrite the path. The schema has already required both.
  const type = encodeURIComponent(input.identity_type ?? "");
  const uid = encodeURIComponent(input.uid ?? "");
  const body = await loomioGetB3<B3UserShowResponse>(`/b3/users/identity/${type}/${uid}`);
  return { user: body.user, resolved_by: "identity" };
}

export const listUsersSchema = z.object({
  is_admin: z
    .boolean()
    .optional()
    .describe("true = instance admins only, false = non-admins only. Omit for all."),
});

export type ListUsersInput = z.infer<typeof listUsersSchema>;

export interface ListUsersResult {
  users: B3User[];
  returned: number;
  scope: {
    is_admin: boolean | null;
    note: string;
  };
}

export async function listUsers(input: ListUsersInput = {}): Promise<ListUsersResult> {
  const body = await loomioGetB3<B3UsersIndexResponse>(
    "/b3/users",
    input.is_admin === undefined ? undefined : { is_admin: input.is_admin },
  );
  const users = Array.isArray(body.users) ? body.users : [];
  return {
    users,
    returned: users.length,
    scope: {
      is_admin: input.is_admin ?? null,
      note:
        "Every account on the Loomio instance" +
        (input.is_admin === undefined ? "" : ` with is_admin=${input.is_admin}`) +
        ", active and deactivated, whatever its groups — Loomio's b3 index is unpaginated and " +
        "unfiltered by membership. Rows include email addresses.",
    },
  };
}
