/**
 * Response shaping: the pure functions that turn what Loomio's b2 API
 * sends (src/loomio/types.ts) into what an AI caller should read.
 *
 * Why a separate layer. Loomio's responses are built for its own
 * browser client: every record arrives with side-loaded roots joined
 * by id, every user with avatar metadata and per-group titles, every
 * discussion with its full HTML body, and every thread's counters live
 * on a `topics[]` row rather than on the discussion or poll. Handed to a
 * model verbatim that is (a) mostly irrelevant, (b) large — a 50-row
 * discussion list is tens of kilobytes of markup — and (c) subtly
 * misleading, because the interesting numbers (replies, last activity,
 * locked, pinned, tags) sit in a root the model has to join by hand.
 * The tools therefore run every response through four operations, each
 * in one place here so the rules stay identical across tools:
 *
 *   join     — `joinTopics` folds the thread counters from `topics[]`
 *              onto the discussion / poll that owns them
 *              (`discussion.topic_id` → `topic.id`).
 *   slim     — `slimUser` / `slimGroup` keep the few fields a caller
 *              acts on (ids, names, handles, privacy, counts) and drop
 *              avatars, locales, permission matrices and the like.
 *   truncate — `truncateText` / `truncateField` cap description and
 *              body text with an explicit `*_truncated` flag, so a list
 *              stays cheap and the model knows to fetch the record for
 *              the rest; `truncateBody` first strips the attributes off
 *              an HTML body that exceeds its cap (`compactHtml`) so the
 *              capped characters carry words, not `rel=` / `target=`.
 *   strip    — `htmlToText` / `stripBodyHtml` turn an HTML body into
 *              plain text (`*_format: "text"`) ahead of the cap, for the
 *              `strip_html` knob the list and get tools expose.
 *   link     — `discussionUrl` & co. build the canonical Loomio web URL
 *              for a record, so an answer can point a human at it.
 *
 * URL formats are Loomio's own (config/routes.rb lines for `d/`, `p/`,
 * `g/`; app/helpers/pretty_url_helper.rb; vue/src/routes.js):
 *
 *   discussion  /d/{key}[/{slug}]          slug = title.parameterize; the
 *                                          route is `d/:key(/:slug)(/:sequence_id)`,
 *                                          so the slug is cosmetic and any
 *                                          value (or none) resolves
 *   poll        /p/{key}[/{slug}]          same shape (`p/:key(/:slug)(/:sequence_id)`)
 *   comment     /d/{key}?comment_id={id}   exactly what `PrettyUrlHelper#comment_url`
 *               /p/{key}?comment_id={id}   emits (no slug, comment_id as a query
 *                                          param); the topic page reads
 *                                          `route.query.comment_id`
 *   item        /d/{key}?sequence_id={n}   `no_slug_topic_url_options` puts
 *                                          sequence_id in the query the same way;
 *                                          the topic page reads `route.query.sequence_id`
 *   group       /{handle}                  `group_handle_url` (routes.rb
 *                                          `get ":id" => 'groups#show'`) when the
 *                                          group has a handle,
 *               /g/{key}[/{slug}]          otherwise (`g/:key(/:slug)`)
 *
 * The site base is `LOOMIO_API_BASE_URL` with its trailing `/api`
 * removed — Loomio mounts the API under the web app's own host.
 *
 * Everything here is synchronous, side-effect free and tolerant of
 * missing fields (Loomio hides fields conditionally): a helper never
 * throws on a record shape it did not expect, it passes through what it
 * can and leaves the rest undefined.
 */

import { apiBaseUrl } from "./client.js";
import type { LoomioGroup, LoomioTopic, LoomioUser } from "./types.js";

// ── Indexing ────────────────────────────────────────────────────────────────

/** `Map` of `id` → row for a side-loaded root; empty for a missing root. */
export function indexById<T extends { id: number }>(
  rows: readonly T[] | undefined,
): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows ?? []) map.set(row.id, row);
  return map;
}

// ── Topics join ─────────────────────────────────────────────────────────────

/**
 * The counters worth carrying from a `topics[]` row onto its discussion
 * or poll. Deliberately NOT the whole row: the `reader_*` fields
 * describe the API user's own reading state (volume, last read, read
 * ranges) and mean nothing to a caller; `ranges`, `max_depth`,
 * `position`-style internals serve Loomio's incremental loading; the
 * `allow_*` flags are group policy the group record already states.
 */
export const TOPIC_JOIN_FIELDS = [
  "items_count",
  "replies_count",
  "last_activity_at",
  "locked_at",
  "pinned_at",
  "tags",
  "members_count",
  "seen_by_count",
  "active_polls_count",
  "closed_polls_count",
] as const;

export type TopicJoin = Pick<LoomioTopic, (typeof TOPIC_JOIN_FIELDS)[number]>;

/** The joinable subset of one topic row (only the fields Loomio actually sent). */
export function topicJoinFields(topic: LoomioTopic): TopicJoin {
  return pick(topic, TOPIC_JOIN_FIELDS);
}

/**
 * Fold each record's topic counters onto the record. `records` are
 * discussions or polls (anything with a `topic_id`); `topics` is the
 * side-loaded root from the same response. A record whose topic is
 * absent — the caller sent `compact=1` by mistake, or Loomio withheld
 * the row — comes back unchanged rather than with nulls, so a missing
 * join is visible as missing fields, not as "0 replies".
 */
export function joinTopics<T extends { topic_id?: number | null }>(
  records: readonly T[] | undefined,
  topics: readonly LoomioTopic[] | undefined,
): Array<T & Partial<TopicJoin>> {
  const byId = indexById(topics);
  return (records ?? []).map((record) => {
    const topic = record.topic_id != null ? byId.get(record.topic_id) : undefined;
    return topic ? { ...record, ...topicJoinFields(topic) } : { ...record };
  });
}

// ── Slimming ────────────────────────────────────────────────────────────────

export interface SlimUser {
  id: number;
  name: string | null;
  username: string | null;
  /** Only when `includeEmail` was requested AND Loomio sent one. */
  email?: string;
}

export interface SlimOptions {
  /**
   * Copy `email` when Loomio sent it. Off by default: Loomio includes a
   * user's email only where the API user is entitled to it (admin
   * memberships, own row, b3), and even then most tools have no reason
   * to repeat it. Admin / b3 tools opt in.
   */
  includeEmail?: boolean;
}

/**
 * A user as the tools present one: id, name, username — enough to
 * attribute a comment or address a member — and nothing about avatars,
 * locale, time zone, verification or per-group titles.
 */
export function slimUser(user: LoomioUser, opts: SlimOptions = {}): SlimUser {
  const out: SlimUser = {
    id: user.id,
    name: user.name ?? null,
    username: user.username ?? null,
  };
  if (opts.includeEmail && typeof user.email === "string" && user.email !== "") {
    out.email = user.email;
  }
  return out;
}

/** `slimUser` over a side-loaded `users[]` root; `[]` for a missing root. */
export function slimUsers(
  users: readonly LoomioUser[] | undefined,
  opts: SlimOptions = {},
): SlimUser[] {
  return (users ?? []).map((u) => slimUser(u, opts));
}

/**
 * The group fields a caller acts on: identity (`id`, `key`, `handle`,
 * `name`, `full_name`, `parent_id`), what it can expect to see there
 * (`group_privacy`, `is_visible_to_public`, `discussion_privacy_options`),
 * how big it is (`memberships_count`, `discussions_count`,
 * `polls_count`) and whether it is live (`enabled` = kept and
 * subscription active). Dropped: the permission matrix (`members_can_*`),
 * cover/logo urls, subscription plan, template counts, description HTML.
 */
export const SLIM_GROUP_FIELDS = [
  "id",
  "key",
  "handle",
  "name",
  "full_name",
  "group_privacy",
  "is_visible_to_public",
  "discussion_privacy_options",
  "memberships_count",
  "discussions_count",
  "polls_count",
  "enabled",
  "parent_id",
] as const;

export type SlimGroup = Pick<LoomioGroup, (typeof SLIM_GROUP_FIELDS)[number]>;

export function slimGroup(group: LoomioGroup): SlimGroup {
  return pick(group, SLIM_GROUP_FIELDS);
}

export function slimGroups(groups: readonly LoomioGroup[] | undefined): SlimGroup[] {
  return (groups ?? []).map(slimGroup);
}

/**
 * Shallow copy of `source` WITHOUT the listed keys. The complement of
 * `pick`, for records the tools return nearly whole (a group show, a
 * poll) minus the few fields that are pure bloat for a model —
 * attachment arrays, link previews, cover-image urls. Keys the record
 * does not have are ignored, so a drop list can name fields Loomio
 * emits only conditionally.
 */
export function omit<T extends object>(
  source: T,
  keys: readonly string[],
): Partial<T> & Record<string, unknown> {
  const drop = new Set<string>(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out as Partial<T> & Record<string, unknown>;
}

/** Copy the listed keys that are present (not `undefined`) on `source`. */
export function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as Pick<T, K>;
}

// ── Truncation ──────────────────────────────────────────────────────────────

export interface Truncated<T extends string | null | undefined> {
  /** The (possibly shortened) text; `undefined` when `max === 0` asked for the field to be omitted. */
  text: T | string | undefined;
  /** True when characters were cut OR the field was omitted because `max === 0`. */
  truncated: boolean;
  /** Length of the ORIGINAL text in UTF-16 code units (0 for null/undefined). */
  chars: number;
}

/**
 * Cap `text` at `max` characters. The three `max` regimes are the
 * contract every `*_max_chars` tool input follows:
 *
 *   max < 0   full text, never truncated (the caller wants it all)
 *   max === 0 omit the text entirely (`text: undefined`), still report
 *             `chars` so the caller knows there was something
 *   max > 0   keep the first `max` characters
 *
 * Cuts never split a surrogate pair (an emoji or CJK extension
 * character would otherwise become a lone half and render as U+FFFD).
 * The text is returned clean — no ellipsis is appended, because the
 * `truncated` flag carries that information and an appended marker
 * would be indistinguishable from content in a Markdown body.
 * `null` and `undefined` pass through untouched with `chars: 0`.
 */
export function truncateText<T extends string | null | undefined>(
  text: T,
  max: number,
): Truncated<T> {
  if (text === null || text === undefined) return { text, truncated: false, chars: 0 };
  const chars = text.length;
  if (max < 0) return { text, truncated: false, chars };
  if (max === 0) return { text: undefined, truncated: chars > 0, chars };
  if (chars <= max) return { text, truncated: false, chars };
  let cut = text.slice(0, max);
  // A high surrogate at the cut point means we split a pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, chars };
}

/**
 * Apply `truncateText` to one string field of a record, IN a shallow
 * copy, following the output convention the tools document: the field
 * keeps its name; when it was cut the copy gains `<field>_truncated:
 * true` and `<field>_chars: <original length>`; when `max === 0` the
 * field is removed and the copy gains `<field>_omitted: true` plus
 * `<field>_chars`. A record whose field is missing or not a string is
 * returned as a plain copy. Non-string fields are never touched.
 */
export function truncateField<T extends Record<string, unknown>>(
  record: T,
  field: string,
  max: number,
): T & Record<string, unknown> {
  const value = record[field];
  if (typeof value !== "string") return { ...record };
  const { text, truncated, chars } = truncateText(value, max);
  if (max === 0) {
    const { [field]: _omitted, ...rest } = record;
    return { ...rest, [`${field}_omitted`]: true, [`${field}_chars`]: chars } as T &
      Record<string, unknown>;
  }
  if (!truncated) return { ...record };
  return { ...record, [field]: text, [`${field}_truncated`]: true, [`${field}_chars`]: chars };
}

// ── HTML compaction for capped bodies ───────────────────────────────────────
//
// Loomio stores rich text as the HTML its editor emits, and `HasRichText`
// decorates it on save (`sanitize_<field>!` → `add_required_link_attributes`
// / `add_heading_ids`): every non-canonical link carries
// `target="_blank" rel="nofollow ugc noreferrer noopener"`, every heading
// an `id` duplicating its own text, every mention a `class` and a
// `data-mention-id`. On a CAPPED list row those attributes are a large
// share of the first N characters — measured at 17 % of a plain body and
// over half of a link- or heading-dense one — so a caller reading 1500
// characters gets far fewer words than it paid for. `compactHtml` strips
// every attribute except a link's `href` and an image's `alt`, and drops
// the whitespace between tags. The result is still HTML with the same
// text and the same links; only the cap is applied to a denser string.
// It runs ONLY when a positive cap is in force and the stored text is
// longer than the cap (`truncateBody`): `get_*` (max -1) and bodies that
// fit are returned byte-for-byte as Loomio stored them, and a Markdown
// body is never touched.

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;

/** One attribute value as `"…"`, whatever quoting the source used. */
function quoteAttr(raw: string): string {
  if (raw.startsWith('"')) return raw;
  const bare = raw.startsWith("'") ? raw.slice(1, -1) : raw;
  return `"${bare.replace(/"/g, "&quot;")}"`;
}

function keptAttr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(attrs);
  return m ? ` ${name}=${quoteAttr(m[1] as string)}` : "";
}

/**
 * The same HTML with every tag attribute removed except `<a href>` and
 * `<img alt>`, and no whitespace between adjacent tags. Pure; text
 * content, entity escapes and tag structure are untouched.
 */
export function compactHtml(html: string): string {
  return html
    .replace(TAG_RE, (_m, close: string, name: string, attrs: string, selfClose: string) => {
      if (close) return `</${name}>`;
      const lower = name.toLowerCase();
      const keep =
        lower === "a" ? keptAttr(attrs, "href") : lower === "img" ? keptAttr(attrs, "alt") : "";
      return `<${name}${keep}${selfClose ? " /" : ""}>`;
    })
    .replace(/>\s+</g, "><");
}

/**
 * `truncateField` for a rich-text body that knows its format: when the
 * record says the body is HTML (`record[formatField] === "html"`), a
 * positive cap applies AND the stored text is longer than that cap, the
 * HTML is compacted first (`compactHtml`) and the cap applied to the
 * compacted text. `<field>_truncated` then means the compacted text was
 * still longer than the cap; `<field>_chars` stays the ORIGINAL stored
 * length — what `get_*` returns. Every other case is `truncateField`.
 */
export function truncateBody<T extends Record<string, unknown>>(
  record: T,
  field: string,
  max: number,
  formatField: string,
): T & Record<string, unknown> {
  const value = record[field];
  if (max <= 0 || typeof value !== "string" || value.length <= max) {
    return truncateField(record, field, max);
  }
  if (record[formatField] !== "html") return truncateField(record, field, max);
  const compact = compactHtml(value);
  if (compact.length <= max) return { ...record, [field]: compact };
  const { text } = truncateText(compact, max);
  return {
    ...record,
    [field]: text,
    [`${field}_truncated`]: true,
    [`${field}_chars`]: value.length,
  };
}

// ── Snippets ────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Decode the HTML character references Loomio's search highlights
 * carry: Rails' `html_escape` (`&amp; &lt; &gt; &quot; &#39;`) on the
 * author-mode excerpt, plus whatever the indexed text itself contained.
 * Numeric (`&#39;`, `&#x27;`) and the common named forms are decoded;
 * anything unknown is left as written rather than guessed at.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * A search result's `highlight` as a one-line Markdown snippet. In
 * query mode Loomio's `ts_headline` wraps every match in `<b>…</b>`
 * (SearchQuery: `StartSel = "<b>", StopSel = "</b>"`); in author mode
 * it is an html-escaped 240-character excerpt with no markup. Both
 * become plain text with `**match**` emphasis: the `<b>` pairs turn
 * into `**`, every other tag is dropped, character references are
 * decoded, whitespace runs (the excerpt keeps the source's newlines)
 * collapse to one space, and the result is capped at `max` characters
 * (no ellipsis — `truncateText`'s convention; the author-mode excerpt
 * already ends in Loomio's own "..." when it was cut). `null` in, `null`
 * out.
 */
export function highlightToMarkdown(
  highlight: string | null | undefined,
  max = 400,
): string | null {
  if (highlight == null) return null;
  const text = decodeHtmlEntities(
    highlight.replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**").replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(text, max).text ?? "";
}

// ── HTML to plain text ──────────────────────────────────────────────────────
//
// Even compacted (`compactHtml`), a stored body spends a good share of a
// list row's cap on `<p>`, `<li>`, `<a href>` wrappers — and a model
// scanning fifty rows for "what is this thread about" has no use for
// the markup at all. `strip_html` (on by default for list_discussions /
// list_polls, off for the gets, which return the record as stored)
// converts the body to plain text BEFORE the cap, so every capped
// character is a word and `<field>_chars` counts words too. Deliberately
// a small converter with no dependency: block boundaries become
// newlines, list items a dash, every other tag is dropped, character
// references are decoded and whitespace is collapsed. Links keep their
// text and lose their href — the row's `url` and `get_*` (HTML by
// default) still lead to them. Markdown bodies are never touched: they
// are already readable and the format says what they are.

const BLOCK_CLOSE_RE =
  /<\/(?:p|div|h[1-6]|blockquote|pre|table|ul|ol|dl|section|article|figure|figcaption)\s*>/gi;

/** `html` as plain text: paragraph breaks kept as blank lines, list items as `- ` lines. Pure. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
    .replace(BLOCK_CLOSE_RE, "\n\n")
    .replace(/<\/(?:li|dt|dd|tr)\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, " ")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `record` with `field` converted from HTML to plain text and
 * `formatField` set to `"text"` — when the record says the body IS HTML
 * (`record[formatField] === "html"`) and the field is a string. A
 * Markdown, missing or nulled (discarded) body comes back as a plain
 * copy with its format untouched. Runs before `truncateBody`, which then
 * takes its plain-text path: `<field>_truncated` / `<field>_chars` /
 * `<field>_omitted` describe the TEXT, the thing the caller received.
 */
export function stripBodyHtml<T extends Record<string, unknown>>(
  record: T,
  field: string,
  formatField: string,
): T & Record<string, unknown> {
  const value = record[field];
  if (typeof value !== "string" || record[formatField] !== "html") return { ...record };
  return { ...record, [field]: htmlToText(value), [formatField]: "text" };
}

// ── Canonical URLs ──────────────────────────────────────────────────────────

/**
 * The Loomio WEB origin (plus any mount path) for links: the configured
 * API base with its trailing `/api` removed. `https://www.loomio.com/api`
 * → `https://www.loomio.com`; `https://loomio.example.org/api/` →
 * `https://loomio.example.org`. A base without `/api` is used as-is
 * (minus trailing slashes) so an unusual mount still yields a URL on
 * the right host.
 */
export function siteBaseUrl(): string {
  return apiBaseUrl()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
}

/**
 * Rails' `String#parameterize`, near enough for a slug that Loomio's
 * routes treat as optional: transliterate accents to ASCII (NFKD, strip
 * combining marks), lower-case, collapse every run of anything but
 * `[a-z0-9_-]` into one `-`, trim the dashes. Characters with no ASCII
 * form (CJK, emoji) vanish; a title made only of those yields "" and the
 * URL is emitted without a slug, which Loomio's `(/:slug)` accepts.
 */
export function slugify(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ThreadUrlOptions {
  /** Record title, for the cosmetic slug. */
  title?: string | null;
  /** A thread item's `sequence_id`, to open the thread scrolled to it. Wins over `title`. */
  sequence_id?: number | null;
  /** A comment id, to open the thread scrolled to it. Wins over both. */
  comment_id?: number | null;
}

function topicUrl(prefix: "d" | "p", key: string, opts: ThreadUrlOptions): string {
  const base = `${siteBaseUrl()}/${prefix}/${encodeURIComponent(key)}`;
  if (opts.comment_id != null) return `${base}?comment_id=${opts.comment_id}`;
  if (opts.sequence_id != null) return `${base}?sequence_id=${opts.sequence_id}`;
  const slug = slugify(opts.title);
  return slug ? `${base}/${slug}` : base;
}

/** `/d/{key}[/{slug}]`, or with `?comment_id=` / `?sequence_id=` to deep-link an item. */
export function discussionUrl(key: string, opts: ThreadUrlOptions = {}): string {
  return topicUrl("d", key, opts);
}

/** `/p/{key}[/{slug}]`, or with `?comment_id=` / `?sequence_id=` to deep-link an item. */
export function pollUrl(key: string, opts: ThreadUrlOptions = {}): string {
  return topicUrl("p", key, opts);
}

/**
 * URL of the thread a `topics[]` / `threads[]` row fronts, given its
 * `topicable_type` and the fronted record's key. `undefined` for a type
 * the connector does not know or a missing key — never a guess.
 */
export function threadUrl(
  topicableType: string | null | undefined,
  key: string | null | undefined,
  opts: ThreadUrlOptions = {},
): string | undefined {
  if (!key) return undefined;
  if (topicableType === "Discussion") return discussionUrl(key, opts);
  if (topicableType === "Poll") return pollUrl(key, opts);
  return undefined;
}

/**
 * Deep link to a comment: `/d/{key}?comment_id={id}` (or `/p/…` when the
 * comment sits on a standalone poll's thread) — what Loomio's own
 * `comment_url` helper emits.
 */
export function commentUrl(
  parent: {
    type: "Discussion" | "Poll" | string | null | undefined;
    key: string | null | undefined;
  },
  commentId: number,
): string | undefined {
  return threadUrl(parent.type, parent.key, { comment_id: commentId });
}

/**
 * `/{handle}` when the group has a handle (Loomio's preferred form),
 * else `/g/{key}[/{slug}]`; `undefined` when the record has neither.
 */
export function groupUrl(group: {
  handle?: string | null;
  key?: string | null;
  name?: string | null;
}): string | undefined {
  const base = siteBaseUrl();
  if (group.handle) return `${base}/${encodeURIComponent(group.handle)}`;
  if (group.key) {
    const slug = slugify(group.name);
    const path = `${base}/g/${encodeURIComponent(group.key)}`;
    return slug ? `${path}/${slug}` : path;
  }
  return undefined;
}
