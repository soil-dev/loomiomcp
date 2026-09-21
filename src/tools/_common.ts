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
