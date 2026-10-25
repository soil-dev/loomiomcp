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
