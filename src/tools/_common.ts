import { z } from "zod";

/** Strictly positive integer — Loomio uses these for every numeric id. */
export const positiveId = z.number().int().positive();

/**
 * Loomio identifiers are either numeric ids or short string keys
 * (e.g. "abcDEF12"). Most show / get endpoints accept either.
 */
export const loomioKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Loomio short keys may only contain letters, numbers, _ and -.");

export const idOrKey = z.union([loomioKey, positiveId]);

export type IdOrKey = z.infer<typeof idOrKey>;

/**
 * Optional ISO-8601-ish timestamp that must be parseable by `Date.parse`
 * when present. Without this guard a typo like `since: "last week"` slips
 * through as a string and, because `NaN` comparisons are always false,
 * silently disables the time filter — turning a bounded query into a
 * full-history scan that still *looks* bounded. Reject it up front.
 */
export const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "must be a parseable ISO-8601 timestamp (e.g. 2026-01-31 or 2026-01-31T00:00:00Z).",
  })
  .optional();

export function encodePathSegment(value: IdOrKey): string {
  const raw = String(value);
  if (raw === "" || raw === "." || raw === "..") {
    throw new Error("id_or_key must be a non-empty Loomio id or short key.");
  }
  return encodeURIComponent(raw);
}

/** Documented `poll_type` values, per https://www.loomio.com/help/api2 */
export const PollTypeEnum = z.enum([
  "proposal",
  "poll",
  "count",
  "score",
  "ranked_choice",
  "meeting",
  "dot_vote",
]);
