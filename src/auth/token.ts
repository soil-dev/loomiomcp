/**
 * Stateless HMAC-signed OAuth artefacts: access / refresh tokens, open-DCR
 * client_ids and (since v0.0.17) authorization codes. Verification needs
 * only `MCP_OAUTH_SIGNING_KEY`, never shared storage — which is what lets
 * Cloud Run's ephemeral, multi-instance replicas all accept each other's
 * artefacts.
 *
 * v2 wire format (v0.0.17+), one per artefact kind:
 *
 *   "v2." + b64url(JSON claims) + "." + b64url(HMAC-SHA256(K_kind, "v2." + payload))
 *   K_kind = HKDF-SHA256(ikm = signing key, salt = "", info = "loomiomcp/v2/<kind>", 32 B)
 *
 * WHY sub-keys: v0.0.16 MACed every artefact with the raw key, so the only
 * thing telling a token from a client_id was the JSON shape — a blob carrying
 * both key sets would verify as either (review nit 2; unreachable without the
 * key, but the separation should be cryptographic, not structural). A v2 MAC
 * made with K_access cannot verify under K_refresh / K_client / K_code, so a
 * refresh token presented as a bearer, a client_id presented as a token or a
 * code presented as anything else fails the SIGNATURE check before any JSON
 * is parsed. The "v2." tag is inside the MAC so it cannot be stripped to
 * downgrade a blob to the legacy path, and the claim schemas are `.strict()`
 * so an extra key is refused rather than ignored.
 *
 * Legacy (v0.0.7 – v0.0.16) format: b64url(JSON) + "." + b64url(HMAC-SHA256(
 * raw key, payload)). Still ACCEPTED (never issued) until
 * `LEGACY_ACCEPT_UNTIL_MS` so the release does not force anyone to
 * re-authenticate: access tokens live 1 day and refresh tokens 30, but
 * open-DCR client_ids never expire, and Claude.ai holds them indefinitely.
 * After the sunset every legacy blob is refused and those clients
 * re-register once. Legacy payloads always start "ey" (b64url of `{"`), so
 * the "v2." prefix can never collide with one.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Legacy (v0.0.16-format) tokens and client_ids are refused from this instant on. */
export const LEGACY_ACCEPT_UNTIL_MS = Date.parse("2027-01-31T00:00:00Z");

export function legacyAccepted(now: number = Date.now()): boolean {
  return now < LEGACY_ACCEPT_UNTIL_MS;
}

/**
 * Below 32 characters the key is guessable offline from any one token (it is
 * the only secret behind every token, client and code), so 32 is the floor
 * (review nit 3). v0.0.16's floor was 16, and replacing a key invalidates
 * every token and client_id it signed — so refusing a 16–31-character key
 * outright would log every user of such a deployment out on upgrade, which
 * this release promises not to do. Such a key therefore keeps working, with
 * a loud startup WARNING, until the same sunset as the legacy artefacts
 * (`LEGACY_ACCEPT_UNTIL_MS`), and is refused at the first start after it
 * (review round 1). Under 16 is refused always, as before.
 */
export const MIN_SIGNING_KEY_CHARS = 32;
/** v0.0.16's floor: 16–31 characters start with a warning until `LEGACY_ACCEPT_UNTIL_MS`. */
export const LEGACY_MIN_SIGNING_KEY_CHARS = 16;

/**
 * What startup says about a signing key's length: `error` (refuse to
 * start), `warning` (a v0.0.16-era short key inside its grace period) or
 * nothing. Never quotes the key.
 */
export function signingKeyProblem(
  key: string | undefined,
  now: number = Date.now(),
): { error: string } | { warning: string } | undefined {
  const n = key?.length ?? 0;
  if (n >= MIN_SIGNING_KEY_CHARS) return undefined;
  const rotate =
    "It is the HMAC key behind every OAuth token, client registration and authorization code; " +
    "replacing it invalidates them all, so every user re-authorizes once (use 64 random hex " +
    "characters).";
  if (n >= LEGACY_MIN_SIGNING_KEY_CHARS && legacyAccepted(now)) {
    return {
      warning:
        `MCP_OAUTH_SIGNING_KEY is ${n} characters. Keys under ${MIN_SIGNING_KEY_CHARS} are accepted ` +
        "only until 2027-01-31 00:00 UTC (the v0.0.16 grace period); a start after that refuses this " +
        `key. Rotate to ${MIN_SIGNING_KEY_CHARS}+ characters at a convenient time before then. ${rotate}`,
    };
  }
  return {
    error:
      `MCP_OAUTH_SIGNING_KEY must be set and at least ${MIN_SIGNING_KEY_CHARS} chars long (got ${n}` +
      `${n >= LEGACY_MIN_SIGNING_KEY_CHARS ? "; the v0.0.16 grace period for shorter keys ended 2027-01-31" : ""}). ${rotate}`,
  };
}

export type BlobKind = "access" | "refresh" | "client" | "code";
type KeyKind = BlobKind | "client-secret";
const KEY_KINDS: readonly KeyKind[] = ["access", "refresh", "client", "code", "client-secret"];
const V2_PREFIX = "v2.";

/**
 * The HKDF sub-keys of one signing key, derived once per provider/store.
 * "client-secret" keys the deterministic per-client secret of a v2 client_id
 * (a fifth domain, so a derived secret can never double as a blob MAC).
 */
export class SigningKeys {
  /** The raw key — used ONLY for the legacy (v0.0.16) verification path and its secret derivation. */
  readonly legacy: string;
  private readonly derived: Map<KeyKind, Buffer>;

  constructor(signingKey: string, now: number = Date.now()) {
    // Same rule as startup (`signingKeyProblem`): 16–31 chars only inside
    // the grace period. A process started before the sunset keeps its key.
    const problem = signingKeyProblem(signingKey, now);
    if (problem && "error" in problem) {
      throw new Error(`OAuth signing key must be at least ${MIN_SIGNING_KEY_CHARS} chars long`);
    }
    this.legacy = signingKey;
    this.derived = new Map(
      KEY_KINDS.map((kind) => [
        kind,
        Buffer.from(hkdfSync("sha256", signingKey, "", `loomiomcp/v2/${kind}`, 32)),
      ]),
    );
  }

  key(kind: KeyKind): Buffer {
    return this.derived.get(kind) as Buffer;
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function mac(key: Buffer | string, data: string): string {
  return b64urlEncode(createHmac("sha256", key).update(data).digest());
}

function macEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 128 random bits, b64url — the per-artefact `nonce` (also makes client_ids unique per registration). */
export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

export class TokenSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenSignatureError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("token expired");
    this.name = "TokenExpiredError";
  }
}

export function isV2Blob(blob: string): boolean {
  return blob.startsWith(V2_PREFIX);
}

/** Sign `claims` as a v2 blob of `kind`. */
export function signBlob(keys: SigningKeys, kind: BlobKind, claims: object): string {
  const signed = `${V2_PREFIX}${b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  return `${signed}.${mac(keys.key(kind), signed)}`;
}

/** Verify a v2 blob of `kind` and return its parsed (UNVALIDATED) payload; throws TokenSignatureError. */
export function openBlob(keys: SigningKeys, kind: BlobKind, blob: string): unknown {
  if (!isV2Blob(blob)) throw new TokenSignatureError("malformed signed blob");
  const lastDot = blob.lastIndexOf(".");
  const signed = blob.slice(0, lastDot);
  const payloadB64 = signed.slice(V2_PREFIX.length);
  if (lastDot <= V2_PREFIX.length || payloadB64.includes(".")) {
    throw new TokenSignatureError("malformed signed blob");
  }
  if (!macEqual(blob.slice(lastDot + 1), mac(keys.key(kind), signed))) {
    throw new TokenSignatureError("invalid signature");
  }
  try {
    return JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new TokenSignatureError("malformed payload");
  }
}

/**
 * Verify a LEGACY (v0.0.16) blob with the raw key and return its parsed
 * payload. Refused outright after `LEGACY_ACCEPT_UNTIL_MS`. The construction
 * is byte-for-byte v0.0.16's `verifyData` — do not "modernise" it, or every
 * outstanding legacy client_id stops verifying before the sunset.
 */
export function openLegacyBlob(keys: SigningKeys, blob: string, now: number = Date.now()): unknown {
  if (!legacyAccepted(now)) throw new TokenSignatureError("legacy format no longer accepted");
  const parts = blob.split(".");
  if (parts.length !== 2) throw new TokenSignatureError("malformed signed blob");
  const [payloadB64, providedSig] = parts as [string, string];
  if (!macEqual(providedSig, mac(keys.legacy, payloadB64))) {
    throw new TokenSignatureError("invalid signature");
  }
  try {
    return JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new TokenSignatureError("malformed payload");
  }
}

export type TokenType = "access" | "refresh";

// v2 token claims. `iat` / `orig_iat` / `expiresAt` are epoch MILLISECONDS
// (as `expiresAt` always was). `orig_iat` is when the user last went through
// /authorize: refresh tokens carry it forward unchanged so the refresh chain
// has a hard horizon (provider.ts REFRESH_HORIZON_MS) instead of sliding
// forever; access tokens never carry it.
const V2TokenClaimsSchema = z
  .object({
    type: z.enum(["access", "refresh"]),
    clientId: z.string().min(1),
    resource: z.string().optional(),
    scopes: z.array(z.string()),
    iat: z.number().int(),
    orig_iat: z.number().int().optional(),
    expiresAt: z.number().int(),
    nonce: z.string().min(16),
  })
  .strict()
  .refine((c) => (c.type === "refresh") === (c.orig_iat !== undefined), {
    message: "orig_iat is required on refresh tokens and forbidden on access tokens",
  });

// Exactly what v0.0.7 – v0.0.16 issued (resource omitted when unset).
const LegacyTokenClaimsSchema = z
  .object({
    type: z.enum(["access", "refresh"]),
    clientId: z.string().min(1),
    resource: z.string().optional(),
    scopes: z.array(z.string()),
    expiresAt: z.number().int(),
    nonce: z.string().min(1),
  })
  .strict();

export type SignedTokenClaims = z.infer<typeof V2TokenClaimsSchema>;

export interface VerifiedToken {
  claims: SignedTokenClaims | z.infer<typeof LegacyTokenClaimsSchema>;
  /** True for a v0.0.16-format token (no `iat` / `orig_iat`). */
  legacy: boolean;
}

/** Issue a v2 token; `claims.type` picks the sub-key, so the type is bound cryptographically. */
export function issueToken(claims: SignedTokenClaims, keys: SigningKeys): string {
  return signBlob(keys, claims.type, claims);
}

/**
 * Verify a token that must be of type `expected`: v2 under that type's
 * sub-key, or (until the sunset) a legacy token under the raw key whose
 * `type` claim matches. Throws TokenSignatureError (bad MAC, wrong type,
 * malformed, legacy after sunset) or TokenExpiredError.
 */
export function verifyToken(
  token: string,
  keys: SigningKeys,
  expected: TokenType,
  now: number = Date.now(),
): VerifiedToken {
  let result: VerifiedToken;
  if (isV2Blob(token)) {
    const parsed = V2TokenClaimsSchema.safeParse(openBlob(keys, expected, token));
    if (!parsed.success || parsed.data.type !== expected) {
      throw new TokenSignatureError("malformed payload");
    }
    result = { claims: parsed.data, legacy: false };
  } else {
    const parsed = LegacyTokenClaimsSchema.safeParse(openLegacyBlob(keys, token, now));
    if (!parsed.success) throw new TokenSignatureError("malformed payload");
    if (parsed.data.type !== expected) throw new TokenSignatureError("wrong token type");
    result = { claims: parsed.data, legacy: true };
  }
  if (result.claims.expiresAt < now) throw new TokenExpiredError();
  return result;
}
