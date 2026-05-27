import { z } from "zod";
import { loomioPostB3 } from "../loomio/client.js";
import { positiveId } from "./_common.js";

// ── deactivate_user / reactivate_user (b3 admin) ────────────────────────────
//
// These hit `/b3/users/deactivate` and `/b3/users/reactivate` on
// Loomio. They use a different auth secret (`?b3_api_key=…`,
// validated server-side against `ENV['B3_API_KEY']`) — not the
// per-user API key. These tools are only registered when
// LOOMIO_B3_API_KEY is set, and skipped in readonly mode.

export const deactivateUserSchema = z.object({
  id: positiveId.describe("Loomio user id to deactivate. Returns 404 if not active."),
});

export async function deactivateUser(input: z.infer<typeof deactivateUserSchema>) {
  return loomioPostB3<unknown>("/b3/users/deactivate", { id: input.id });
}

export const reactivateUserSchema = z.object({
  id: positiveId.describe(
    "Loomio user id to reactivate. Returns 404 if not currently deactivated.",
  ),
});

export async function reactivateUser(input: z.infer<typeof reactivateUserSchema>) {
  return loomioPostB3<unknown>("/b3/users/reactivate", { id: input.id });
}
