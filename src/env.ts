/**
 * Shared env-var readers.
 *
 * Every config-reading site in the codebase parses environment
 * variables at call time (not module init) so tests can flip values
 * per case without reloading the module.
 *
 * The truthy-spelling rule is uniform: `1`, `true`, `yes`, `on`
 * (case-insensitive). Anything else, including unset, is `false`.
 */

/** The truthy-spelling rule on a raw value: 1/true/yes/on (case-insensitive). */
export function isTruthyEnvValue(value: string | undefined): boolean {
  const raw = value?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Parse a boolean env var. Recognises 1/true/yes/on (case-insensitive). */
export function readBool(name: string): boolean {
  return isTruthyEnvValue(process.env[name]);
}

/**
 * Parse a positive-integer env var. Returns `fallback` when the
 * variable is unset, empty, non-numeric, negative, or below `min`.
 * Floors fractional inputs.
 */
export function readPositiveInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/**
 * Parse a non-negative integer env var where `0` is meaningful ("off",
 * for the daily quotas and the upstream budget). Unset, empty or
 * malformed → `fallback`; never throws, because these are read on hot
 * paths. `src/http/config.ts` validates the same knobs at startup and
 * refuses a malformed value loudly, so a typo cannot silently fall back
 * on a deployment that went through `resolveBaseConfig`.
 */
export function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : fallback;
}
