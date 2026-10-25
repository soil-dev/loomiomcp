import { z } from "zod";
import { isOpenDcr } from "../deployment.js";
import { LoomioApiError, LoomioAuthError } from "../loomio/client.js";
import { notVisibleMessage } from "../loomio/group-scope.js";
import { checkLoomioHealth } from "../loomio/health.js";
import { getFreshKeyStatus } from "../loomio/health-cache.js";

/** Strictly positive integer — Loomio uses these for every numeric id. */
export const positiveId = z.number().int().positive();

// ── Length caps on free text (security review nit 16) ──────────────────────
//
// v0.0.16 bounded no string input: a 200 KB "short key" travelled into a
// URL and cost one upstream 431, a 10 000-element `kinds` array was
// filtered against every item, and a multi-megabyte `query` went to
// Loomio's full-text search verbatim. Every caller-supplied string now
// has a ceiling, chosen so no legitimate value comes near it:
//
//   keys / handles 128   Loomio keys are 8 chars, handles a few dozen
//   query          512   a search, not a document
//   tag            128   per tag name
//   kinds           64   per kind name (the catalogue's longest is 29)
//   title          500   Loomio validates discussions at 150
//   body       100 000   Loomio's own default `max_message_length`
//                        (LMO_MAX_MESSAGE_LENGTH) for descriptions,
//                        details, comments and outcomes
//   e-mail         254   RFC 5321's path limit
//   timestamps      64   an ISO-8601 instant is ~30
//
// How a ceiling reaches tools/list differs, because the catalogue is a
// per-session tax every client pays before its first call (pinned in
// tests/server.test.ts). The READ inputs a caller probes with — query,
// search tag, kinds, timestamps — carry a real `.max()`, advertised as
// `maxLength`. A key's ceiling rides in its REGEX (`{1,128}`): the
// pattern is already in every schema that takes a key, so the bound
// costs six bytes instead of sixteen. The WRITE fields (titles, bodies,
// tags, e-mails, prompts, option names) go through `capped`: the same
// refusal, with a message naming the limit, but no `maxLength` per field
// — some thirty of them across the write tools would cost ~500 bytes of
// every session for limits no model writes near (the HTTP entry's
// 256 KB body cap bounds them as well).
export const TEXT_MAX = {
  key: 128,
  query: 512,
  tag: 128,
  kind: 64,
  title: 500,
  prompt: 1_000,
  message: 10_000,
  body: 100_000,
  email: 254,
  timestamp: 64,
} as const;

/**
 * `schema` refusing values longer than `max` characters, checked but not
 * advertised (see above). A refinement, so it composes with `.min()`,
 * `.optional()` and `.describe()` like `.max()` would.
 */
export function capped<T extends z.ZodString>(schema: T, max: number): T {
  return schema.refine((v) => v.length <= max, {
    message: `must be at most ${max} characters.`,
  }) as T;
}

/** A required title (discussion, poll; Loomio validates discussions at 150). */
export const titleText = capped(z.string().min(1), TEXT_MAX.title);
/** A rich-text body (description, details, comment). */
export const bodyText = capped(z.string(), TEXT_MAX.body);
/** One tag name on a write (search's `tag` filter carries an advertised `.max()`). */
export const tagName = capped(z.string().min(1), TEXT_MAX.tag);
/** One e-mail address. */
export const emailAddress = capped(z.string().email(), TEXT_MAX.email);
/** A notification text (`recipient_message`). */
export const messageText = capped(z.string(), TEXT_MAX.message);
/** A short prompt or poll option name. */
export const promptText = capped(z.string(), TEXT_MAX.prompt);

/**
 * Loomio identifiers are either numeric ids or short string keys
 * (e.g. "abcDEF12"). Most show / get endpoints accept either.
 */
export const loomioKey = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{1,128}$/,
    "Loomio short keys may only contain letters, numbers, _ and - (1-128 characters).",
  );

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
  .max(TEXT_MAX.timestamp)
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

/**
 * Re-say "hidden" and "not found" as ONE message in open-DCR mode
 * (security review nit 19), then rethrow.
 *
 * WHY. Loomio's record shows answer an unknown id with 404 and an id
 * that exists but is hidden from the API user with 403 "Not authorized
 * to show …" — and the connector's own messages explained the
 * difference ("this identifier is wrong rather than restricted"). Walked
 * over sequential ids, that tells an anonymous open-DCR caller which
 * private groups, discussions and polls EXIST. Loomio's web UI has the
 * same oracle, so on a static-client deployment (one known client) the
 * precise wording stays: it is the better diagnostic. Only a record
 * refusal is collapsed — a 403 about the KEY (`unauthenticated`, `waf`,
 * …) says the same for every id and keeps its own explanation.
 */
export function collapseNotVisible(
  err: unknown,
  what: "group" | "discussion" | "poll" | "thread",
  ref: string | number,
): never {
  maybeCollapseNotVisible(err, what, ref);
  throw err;
}

/**
 * The throwing half of `collapseNotVisible` alone: throws the collapsed
 * 404 when it applies and RETURNS otherwise, for callers that go on to
 * word the error precisely outside open-DCR mode.
 */
export function maybeCollapseNotVisible(
  err: unknown,
  what: "group" | "discussion" | "poll" | "thread",
  ref: string | number,
): void {
  if (isOpenDcr() && isHiddenOrMissing(err)) {
    throw new LoomioApiError(404, notVisibleMessage(what, ref));
  }
}

function isHiddenOrMissing(err: unknown): boolean {
  if (err instanceof LoomioApiError && err.status === 404) return true;
  return err instanceof LoomioAuthError && err.status === 403 && err.kind === "not_authorized";
}

/**
 * nit 19 for the group-keyed LISTS (round-2 finding): list_discussions,
 * list_polls and list_memberships rebuilt the existence oracle that
 * get_group no longer gives. Loomio 3.13.1's `records_visible_in_group`
 * (b2 discussions/polls index) runs `Group.find` — 404 for an unknown id
 * — and then a bare `raise CanCan::AccessDenied` — the GENERIC 403 body,
 * which the client classifies `unauthenticated` — for a hidden group.
 * In open-DCR mode both now read `notVisibleMessage("group", id)`.
 *
 * The generic body on these two routes is ALSO what a dead key gets, so
 * a 403 is collapsed only while the key is not known to be rejected:
 * the fresh probe verdict, else one probe (cached 60 s, so a walk over
 * ids costs at most two extra Loomio calls a minute). A dead key says
 * the same for every id — no oracle — and keeps its own diagnosis.
 * Rethrows anything else unchanged.
 */
export async function collapseGroupListError(err: unknown, groupId: number): Promise<never> {
  if (isOpenDcr()) {
    const missing = err instanceof LoomioApiError && err.status === 404;
    const forbidden =
      err instanceof LoomioAuthError &&
      err.status === 403 &&
      (err.kind === "not_authorized" || err.kind === "unauthenticated");
    if (missing || (forbidden && (await keyNotRejected()))) {
      throw new LoomioApiError(404, notVisibleMessage("group", groupId));
    }
  }
  throw err;
}

async function keyNotRejected(): Promise<boolean> {
  const status = getFreshKeyStatus() ?? (await checkLoomioHealth()).key_status;
  return status !== "rejected";
}

/**
 * Every `poll_type` Loomio 3.8.1 accepts — the keys of
 * config/poll_types.yml, which `Poll` validates against
 * (`validates :poll_type, inclusion: { in: AppConfig.poll_types.keys }`).
 * `check` (sense check), `question` (free-text answers, no options) and
 * `stv` (single transferable vote) are new since the 0.0.11 enum.
 */
export const PollTypeEnum = z.enum([
  "proposal",
  "poll",
  "count",
  "score",
  "ranked_choice",
  "meeting",
  "dot_vote",
  "check",
  "question",
  "stv",
]);

export type PollType = z.infer<typeof PollTypeEnum>;

export interface PollTypeRules {
  /** `has_options` in poll_types.yml: whether the type takes `options` at all. */
  hasOptions: boolean;
  /** `min_options`: how many the UI insists on (Loomio's model does not validate this — the connector does). */
  minOptions: number;
  /** `prevent_anonymous`: the UI hides the anonymous toggle for these; the connector refuses it. */
  preventAnonymous: boolean;
  /**
   * `common_poll_options` keys: option NAMES that `Poll#poll_option_names=`
   * recognises and decorates with Loomio's icon, meaning and prompt
   * (and re-labels in the instance's locale — "agree" comes back as
   * "Agree"). Any other name is a plain option. Empty for types with no
   * catalogue.
   */
  commonOptions: readonly string[];
}

/**
 * Per-type rules, transcribed from config/poll_types.yml (Loomio 3.8.1).
 * They exist because Loomio's Poll model validates NONE of them: a
 * proposal posted without `options` is saved with zero options (an
 * unusable poll — the 0.0.11 description's "built-in agree / disagree /
 * abstain" was wrong; those come from the web client's templates, not
 * the model), and an anonymous count/question/meeting is saved although
 * the product forbids it. The schema refuses what the UI would.
 */
export const POLL_TYPE_RULES: Record<PollType, PollTypeRules> = {
  proposal: {
    hasOptions: true,
    minOptions: 1,
    preventAnonymous: false,
    commonOptions: [
      "agree",
      "abstain",
      "disagree",
      "block",
      "veto",
      "consent",
      "objection",
      "object",
      "looks_good",
      "could_be_better",
      "needs_a_rethink",
      "accept",
      "decline",
      "yes",
      "no",
    ],
  },
  poll: { hasOptions: true, minOptions: 1, preventAnonymous: false, commonOptions: [] },
  count: {
    hasOptions: true,
    minOptions: 1,
    preventAnonymous: true,
    commonOptions: ["accept", "decline"],
  },
  score: { hasOptions: true, minOptions: 1, preventAnonymous: false, commonOptions: [] },
  ranked_choice: { hasOptions: true, minOptions: 2, preventAnonymous: false, commonOptions: [] },
  meeting: { hasOptions: true, minOptions: 1, preventAnonymous: true, commonOptions: [] },
  dot_vote: { hasOptions: true, minOptions: 1, preventAnonymous: false, commonOptions: [] },
  check: {
    hasOptions: true,
    minOptions: 1,
    preventAnonymous: false,
    commonOptions: ["looks_good", "not_sure", "concerned"],
  },
  question: { hasOptions: false, minOptions: 0, preventAnonymous: true, commonOptions: [] },
  stv: { hasOptions: true, minOptions: 2, preventAnonymous: false, commonOptions: [] },
};

/**
 * Loomio's group show route (`GET /b2/groups/:id`) resolves `:id` as a
 * numeric id, else a short key, else a handle (ModelLocator, 3.8.1). A
 * handle is `String#parameterize` output — `[a-z0-9_-]`, subgroups
 * prefixed with `{parent-handle}-` — so the key regex covers it.
 */
export const idOrKeyOrHandle = z.union([loomioKey, positiveId]);

/**
 * The three regimes every `*_max_chars` input follows (see
 * `truncateText` in src/loomio/shape.ts): `-1` full text, `0` omit the
 * field, `N > 0` keep the first N characters and flag the cut. Shared
 * so the tool descriptions say the same thing in the same words. The
 * text is paid for in every session's tools/list (this schema is reused
 * by four tools), so it names the regimes and nothing else; HOWTO.md
 * "Tool reference" carries the HTML-compaction detail.
 */
export function maxCharsSchema(field: string, defaultValue: number) {
  return z
    .number()
    .int()
    .min(-1)
    .optional()
    .describe(`Chars per \`${field}\`; default ${defaultValue}, 0 omits it, -1 = full.`);
}

// ── Rich-text format fields ─────────────────────────────────────────────────
//
// `description_format` (discussions), `details_format` (polls) and
// `body_format` (comments) are all stored as "md" when omitted: each
// column is `default: "md", null: false` in Loomio 3.8.1's db/schema.rb,
// no service on the b2 write path assigns it, and there is no group-level
// format setting (`Group#description_format` is the group's OWN
// description). An HTML body sent without its format is therefore saved
// as Markdown — the browser happens to render it (marked passes raw HTML
// through), but every server-side rendering (notification emails,
// chatbot posts, exports: `MarkdownService.render_html`, Redcarpet with
// `filter_html`) strips the tags, and the record carries the wrong
// format for every later edit. The creates refuse that silently-wrong
// write when the body plainly IS HTML — it starts with a block-level
// tag. Inline HTML inside Markdown (a `<br>` mid-paragraph) passes.

const BLOCK_HTML_RE =
  /^\s*<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|section|article|figure|hr|br)\b[^>]*>/i;

/** True when `text` opens with an HTML block-level tag — the shape a rich-text editor emits. */
export function looksLikeHtml(text: string): boolean {
  return BLOCK_HTML_RE.test(text);
}

/** The `.describe()` text every `*_format` write field shares, so all three say the same true thing. */
export function formatFieldDescription(field: string): string {
  return `Default 'md'; 'html' when \`${field}\` is HTML.`;
}

/**
 * Schema-level guard for a create: a body that starts with a block-level
 * HTML tag must name its format. Attach in `superRefine`.
 */
export function refuseHtmlWithoutFormat(
  ctx: z.RefinementCtx,
  body: string | undefined,
  format: string | undefined,
  field: string,
): void {
  if (body === undefined || format !== undefined || !looksLikeHtml(body)) return;
  ctx.addIssue({
    code: "custom",
    path: [`${field}_format`],
    message:
      `${field} starts with an HTML block tag but ${field}_format was not sent. Loomio stores an omitted ` +
      "format as 'md', so the HTML would be kept as literal Markdown text and stripped from every " +
      `server-rendered surface (emails, exports). Send ${field}_format: 'html' (or 'md' if the body ` +
      "really is Markdown).",
  });
}

/** Default cap for list-tool description/details fields. */
export const DEFAULT_DESCRIPTION_MAX_CHARS = 1500;

/** Loomio's default page size when `limit` is absent (SnorlaxBase#default_page_size). */
export const LOOMIO_DEFAULT_PAGE_SIZE = 50;
