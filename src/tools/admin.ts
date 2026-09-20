import { z } from "zod";
import { loomioPostB3 } from "../loomio/client.js";
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
  id: positiveId.describe("Loomio user id to deactivate. Returns 404 if not currently active."),
});

export async function deactivateUser(
  input: z.infer<typeof deactivateUserSchema>,
): Promise<B3UserResponse> {
  return loomioPostB3<B3UserResponse>(`/b3/users/${input.id}/deactivate`);
}

export const reactivateUserSchema = z.object({
  id: positiveId.describe(
    "Loomio user id to reactivate. Returns 404 if not currently deactivated.",
  ),
});

export async function reactivateUser(
  input: z.infer<typeof reactivateUserSchema>,
): Promise<B3UserResponse> {
  return loomioPostB3<B3UserResponse>(`/b3/users/${input.id}/reactivate`);
}
