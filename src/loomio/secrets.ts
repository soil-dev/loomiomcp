/**
 * The two Loomio credentials the connector holds — `LOOMIO_API_KEY` (b2,
 * per user) and `LOOMIO_B3_API_KEY` (b3, instance secret) — read,
 * validated and scrubbed in ONE place.
 *
 * WHY (security review F-02). v0.0.16 only checked that the variables
 * were set and interpolated the raw value into `Authorization: Bearer …`.
 * A two-line value (a CRLF paste, a secret file with an interior line
 * break) made undici throw `Headers.append: "Bearer <the whole secret>"
 * is an invalid header value`, and that message travelled verbatim into
 * every tool error (i.e. to every anonymous open-DCR caller), into the
 * health probe's `detail` and the startup warning — while /health
 * classified it as a transient `network_error`. The fix has three
 * layers, each sufficient on its own for the case it covers:
 *
 *   1. `validateSecret` — a value is normalised (leading and trailing
 *      spaces, tabs, CRs and LFs dropped — exactly what v0.0.16's undici
 *      `Headers` normalisation stripped on the wire, so every value that
 *      worked there still works: `echo key > file`, a trailing space in
 *      a Desktop config or an `--env-file` line) and must then be
 *      printable ASCII without spaces (`[\x21-\x7e]+`, which every
 *      Loomio key and any sane B3_API_KEY satisfies). An INTERIOR line
 *      break or space (the F-02 case) still fails. Anything else is
 *      refused with a FIXED message that never quotes the value — at
 *      startup (both entry points call `secretConfigError`) and on every
 *      read, so a value swapped under a running test cannot slip past.
 *   2. The HTTP client maps every non-HTTP fetch failure to a fixed
 *      transport error (src/loomio/client.ts), so no undici message —
 *      whatever it quotes — reaches a caller.
 *   3. `scrubSecrets` — a last-resort filter over every tool error text,
 *      the probe's `detail` and get_user_activity's relayed search
 *      error: any occurrence of either configured value (raw, normalised,
 *      or one line of a multi-line value) becomes `[redacted]`.
 */

/** Printable ASCII, no space: what a bearer credential can carry in a header without escaping. */
const SECRET_SHAPE = /^[\x21-\x7e]+$/;

export type SecretName = "LOOMIO_API_KEY" | "LOOMIO_B3_API_KEY";

/**
 * The value with leading/trailing HTTP whitespace (space, tab, CR, LF)
 * removed. WHY this set and not just one trailing newline: v0.0.16 put
 * the raw value into undici's `Headers`, whose WHATWG normalisation
 * strips exactly these four characters at both ends, so `"key "`,
 * `"key\t"`, `"key\n\n"` and `"key\r"` all reached Loomio as `Bearer key`
 * and worked. A stricter rule would turn a working v0.0.16 config into a
 * FATAL at startup (compat review, round 2). Interior whitespace is left
 * in place so the shape check below still refuses it.
 */
function normalise(raw: string): string {
  return raw.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

/** Why `raw` cannot be used as a bearer credential, or undefined when it can. Never quotes the value. */
export function secretShapeError(name: SecretName, raw: string): string | undefined {
  const value = normalise(raw);
  if (value === "") return `${name} is empty.`;
  if (!SECRET_SHAPE.test(value)) {
    return (
      `${name} contains characters a bearer credential cannot carry (whitespace, a line break ` +
      "inside the value, control or non-ASCII characters). Re-copy it as ONE line of printable " +
      "characters — a CRLF paste or a multi-line secret file is the usual cause. The value is not " +
      "shown here on purpose."
    );
  }
  return undefined;
}

/**
 * The normalised credential, or `undefined` when unset. Throws the
 * fixed shape error (as a plain Error; the client wraps it in its own
 * configuration-error class) when set but unusable.
 */
export function readSecret(name: SecretName): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const problem = secretShapeError(name, raw);
  if (problem) throw new Error(problem);
  return normalise(raw);
}

/**
 * Startup check for both entry points: the first problem with either
 * configured secret, as a fixed message, or undefined. Unset is not a
 * problem here (the entries check LOOMIO_API_KEY presence themselves;
 * the b3 secret is optional).
 */
export function secretConfigError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["LOOMIO_API_KEY", "LOOMIO_B3_API_KEY"] as const) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const problem = secretShapeError(name, raw);
    if (problem) return problem;
  }
  return undefined;
}

/** Fragments shorter than this are not scrubbed on their own (they would mangle ordinary text). */
const MIN_SCRUB_FRAGMENT = 8;

function scrubNeedles(): string[] {
  const needles = new Set<string>();
  for (const name of ["LOOMIO_API_KEY", "LOOMIO_B3_API_KEY"] as const) {
    const raw = process.env[name];
    if (!raw) continue;
    needles.add(raw);
    needles.add(normalise(raw));
    // A multi-line value may be quoted line by line, or JSON-escaped.
    needles.add(JSON.stringify(raw).slice(1, -1));
    for (const part of raw.split(/[\r\n]+/)) {
      if (part.trim().length >= MIN_SCRUB_FRAGMENT) needles.add(part.trim());
    }
  }
  // Longest first, so a whole value is replaced before any of its lines.
  return [...needles]
    .filter((n) => n.length >= MIN_SCRUB_FRAGMENT)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a configured Loomio credential in `text`
 * with `[redacted]`. Cheap when nothing matches; applied to every tool
 * error and every operator-facing probe `detail`. Read at call time so
 * it follows the environment exactly as the client does.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const needle of scrubNeedles()) {
    if (out.includes(needle)) out = out.split(needle).join("[redacted]");
  }
  return out;
}
