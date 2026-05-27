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

export function encodePathSegment(value: IdOrKey): string {
  return encodeURIComponent(String(value));
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
