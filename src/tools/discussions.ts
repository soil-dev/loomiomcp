import { z } from "zod";
import {
  LoomioApiError,
  loomioDelete,
  loomioGet,
  loomioPatch,
  loomioPost,
  nestedBody,
  readParams,
} from "../loomio/client.js";
import {
  discussionUrl,
  joinTopics,
  omit,
  type SlimGroup,
  type SlimUser,
  slimGroup,
  slimUsers,
  stripBodyHtml,
  type TopicJoin,
  truncateBody,
} from "../loomio/shape.js";
import type { DiscussionsResponse, LoomioDiscussion } from "../loomio/types.js";
import {
  DEFAULT_DESCRIPTION_MAX_CHARS,
  encodePathSegment,
  formatFieldDescription,
  idOrKey,
  maxCharsSchema,
  positiveId,
  refuseHtmlWithoutFormat,
} from "./_common.js";
import {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_ITEMS_LIMIT,
  type KnownThread,
  listThreadItems,
  MAX_ITEMS_LIMIT,
} from "./threads.js";

// ── Shaping a discussion record ─────────────────────────────────────────────
//
// Loomio 3.8 keeps a thread's counters on the side-loaded `topics[]`
// row (TopicSerializer), not on the discussion: items_count,
// replies_count, last_activity_at, locked_at, pinned_at, tags,
// members_count, seen_by_count, active/closed_polls_count. Every read
// here therefore keeps the `topics` root (the `list` / `show` read
// profiles name the side-loads to drop instead of sending `compact=1`,
// which would drop it) and folds those fields onto the discussion via
// `joinTopics`. What is dropped from the record itself is bloat for a
// model: attachment metadata (kept as a count), link-preview cards,
// `mentioned_usernames` (derivable from the body), `content_locale`,
// `translation_id`. The description — the bulk of every payload — is
// capped on lists per `description_max_chars` and returned whole on the
// show; `strip_html` (list default true, show default false) converts
// an HTML description to plain text BEFORE that cap, flagged
// `description_format: "text"`, so a scan of fifty rows pays for words
// rather than markup (see `stripBodyHtml` in src/loomio/shape.ts).

const DISCUSSION_DROP = [
  "attachments",
  "link_previews",
  "mentioned_usernames",
  "content_locale",
  "translation_id",
] as const;

export type ShapedDiscussion = Partial<LoomioDiscussion> &
  Partial<TopicJoin> &
  Record<string, unknown> & { url?: string };

/**
 * One discussion as the tools present it: the record minus bloat, plus
 * the topic counters `joinTopics` folded on, `attachments_count`, the
 * description — plain text (`description_format: "text"`) when
 * `opts.stripHtml` and the stored body is HTML, then capped (with
 * `description_truncated` / `description_chars` when cut) — and the
 * canonical `url`. Pure; tolerant of a discarded record (no title, no
 * description).
 */
export function shapeDiscussion(
  record: LoomioDiscussion & Partial<TopicJoin>,
  opts: { descriptionMaxChars: number; stripHtml?: boolean },
): ShapedDiscussion {
  const base = omit(record, DISCUSSION_DROP);
  const withCounts = Array.isArray(record.attachments)
    ? { ...base, attachments_count: record.attachments.length }
    : base;
  // Strip first, cap second: the cap must land on words, and the
  // `_chars` it reports must count the text the caller actually gets.
  const body = opts.stripHtml
    ? stripBodyHtml(withCounts, "description", "description_format")
    : withCounts;
  const truncated = truncateBody(
    body,
    "description",
    opts.descriptionMaxChars,
    "description_format",
  );
  const url = record.key ? discussionUrl(record.key, { title: record.title }) : undefined;
  return url ? { ...truncated, url } : truncated;
}

// ── get_discussion ──────────────────────────────────────────────────────────
//
// `GET /b2/discussions/{id|key}` → `load_and_authorize(:discussion)`:
// friendly_id resolves either form, `can?(:show)` is
// `TopicQuery.visible_to(user)` — a discussion the user cannot see
// answers 403 "Not authorized to show Discussion." (the client explains
// it), an unknown id 404. The show profile keeps `groups` for the
// thread's group name and privacy.

export const getDiscussionSchema = z.object({
  id_or_key: idOrKey.describe("Discussion id or short key."),
  strip_html: z.boolean().optional().describe("Plain text instead of HTML; default false."),
  include_items: z
    .boolean()
    .optional()
    .describe("Also embed the thread's items as `thread_items` (+1 call)."),
  items_limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ITEMS_LIMIT)
    .optional()
    .describe(
      `With include_items: items to embed (default ${DEFAULT_ITEMS_LIMIT}, max ${MAX_ITEMS_LIMIT}).`,
    ),
  items_body_max_chars: maxCharsSchema("body", DEFAULT_BODY_MAX_CHARS).describe(
    `With include_items: chars per body (default ${DEFAULT_BODY_MAX_CHARS}; 0 omits, -1 full).`,
  ),
});

/**
 * The seam `include_items` calls: `listThreadItems`, or a test double.
 * The second argument is the record this tool just fetched, so the items
 * request can exclude the opening post (`items_known_thread` profile —
 * Loomio would otherwise serialise the discussion, full body included, a
 * second time) and the embedded header needs nothing from that response.
 */
export type ThreadItemsFetcher = (
  input: { topic_id: number; limit?: number; body_max_chars?: number },
  known: KnownThread,
) => Promise<unknown>;

export interface GetDiscussionDeps {
  fetchItems?: ThreadItemsFetcher;
}

export interface GetDiscussionResult {
  discussion: ShapedDiscussion;
  group: SlimGroup | null;
  users: SlimUser[];
  /** Present only when `include_items` was requested: the list_thread_items result for this thread. */
  thread_items?: unknown;
  scope?: { note: string };
}

export async function getDiscussion(
  input: z.infer<typeof getDiscussionSchema>,
  deps: GetDiscussionDeps = {},
): Promise<GetDiscussionResult> {
  const body = await loomioGet<DiscussionsResponse>(
    `/b2/discussions/${encodePathSegment(input.id_or_key)}`,
    readParams("show"),
  );
  const record = body.discussions?.[0];
  if (!record) {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/discussions/${input.id_or_key} without a discussion record; the ` +
        "response shape is not the one Loomio 3.8.1 produces.",
    );
  }
  const [joined] = joinTopics([record], body.topics);
  const group =
    (body.groups ?? []).find((g) => g.id === record.group_id) ?? body.groups?.[0] ?? undefined;
  const out: GetDiscussionResult = {
    discussion: shapeDiscussion(joined ?? record, {
      descriptionMaxChars: -1,
      stripHtml: input.strip_html ?? false,
    }),
    group: group ? slimGroup(group) : null,
    users: slimUsers(body.users),
  };
  if (!input.include_items) return out;
  if (record.topic_id == null) {
    // Every kept discussion has a topic; a record without one is a
    // shape the connector does not know, so say so rather than guess.
    return {
      ...out,
      thread_items: null,
      scope: {
        note: "include_items was requested but Loomio sent no topic_id for this discussion, so its items could not be fetched.",
      },
    };
  }
  // The topic id is already on the record — no second lookup — and the
  // record itself travels along so the items request can drop it.
  const fetchItems = deps.fetchItems ?? listThreadItems;
  const thread_items = await fetchItems(
    {
      topic_id: record.topic_id,
      ...(input.items_limit !== undefined ? { limit: input.items_limit } : {}),
      ...(input.items_body_max_chars !== undefined
        ? { body_max_chars: input.items_body_max_chars }
        : {}),
    },
    {
      type: "Discussion",
      id: record.id,
      key: record.key ?? null,
      title: record.title ?? null,
      group_id: record.group_id ?? null,
    },
  );
  return { ...out, thread_items };
}

// ── list_discussions ────────────────────────────────────────────────────────
//
// `GET /b2/discussions?group_id=` → `records_visible_in_group(Discussion)`:
// 403 (generic body) when the group is not visible to the user, else the
// discussions `TopicQuery.visible_to` admits in THAT group (no
// subgroups), ordered by latest activity, paginated by limit/offset with
// `meta.total` the pre-pagination count. `status` is read as
// 'locked'|'closed' → is_locked, 'unlocked'|'open' → is_unlocked, and
// ANYTHING ELSE (including absent) → every kept thread. The connector
// sends its documented default explicitly for that reason.

export const listDiscussionsSchema = z.object({
  group_id: positiveId,
  status: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe("'open' (default) = unlocked, 'closed' = locked, 'all'."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200. Default 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Default 0."),
  description_max_chars: maxCharsSchema("description", DEFAULT_DESCRIPTION_MAX_CHARS),
  strip_html: z.boolean().optional().describe("Plain text instead of HTML; default true."),
});

export interface ListDiscussionsResult {
  discussions: ShapedDiscussion[];
  users: SlimUser[];
  /** Loomio's `meta.total`: every matching discussion, before pagination. */
  total: number;
  returned: number;
  scope: {
    group_id: number;
    status: "open" | "closed" | "all";
    offset: number;
    description_max_chars: number;
    strip_html: boolean;
  };
}

export async function listDiscussions(
  input: z.infer<typeof listDiscussionsSchema>,
): Promise<ListDiscussionsResult> {
  const status = input.status ?? "open";
  const max = input.description_max_chars ?? DEFAULT_DESCRIPTION_MAX_CHARS;
  const stripHtml = input.strip_html ?? true;
  const body = await loomioGet<DiscussionsResponse>("/b2/discussions", {
    group_id: input.group_id,
    // Always explicit — see the module note on how Loomio reads `status`.
    status,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...readParams("list"),
  });
  const discussions = joinTopics(body.discussions, body.topics).map((d) =>
    shapeDiscussion(d, { descriptionMaxChars: max, stripHtml }),
  );
  return {
    discussions,
    users: slimUsers(body.users),
    // DiscussionsController#index sets collection_count on every call
    // (Loomio 3.8.1), so `meta.total` is always there; the fallback only
    // guards against a shape this connector does not know.
    total: typeof body.meta?.total === "number" ? body.meta.total : discussions.length,
    returned: discussions.length,
    scope: {
      group_id: input.group_id,
      status,
      offset: input.offset ?? 0,
      description_max_chars: max,
      strip_html: stripHtml,
    },
  };
}

// ── create_discussion ───────────────────────────────────────────────────────
//
// Body: NESTED `{ discussion: {…} }`. Loomio 3.8.1's
// `Api::B2::BaseController#permitted_params` takes `params[:discussion]`
// when present; without it Rails' `wrap_parameters` builds that hash
// from the top-level keys that are Discussion COLUMNS — and `group_id`,
// `private`, `recipient_*`, `tags` are not columns, so a flat JSON body
// silently loses them (see `nestedBody` in src/loomio/client.ts).
// `DiscussionService.create` reads `recipient_user_ids` /
// `recipient_emails` / `recipient_audience` from the permitted hash, so
// they belong inside the wrapper too. Every key below is in
// `PermittedParams#discussion_attributes`; anything else would 400
// (`action_on_unpermitted_parameters = :raise`).
//
// `private` is sent only when the caller sets it. Loomio's own default
// applies otherwise (`TopicService.private_default`: false for a
// public_only group, true for the rest — controller test "create
// defaults to public when the group requires public discussions"), so
// the 0.0.11 pre-flight `GET /v1/groups/{id}` that resolved it here is
// gone: one call instead of two, and no v1 (browser API) request from a
// key-authenticated connector.

export const createDiscussionSchema = z
  .object({
    title: z.string().min(1),
    group_id: positiveId,
    description: z.string().optional(),
    description_format: z
      .enum(["md", "html"])
      .optional()
      .describe(formatFieldDescription("description")),
    private: z
      .boolean()
      .optional()
      .describe("true = members only, false = public. Default: the group's setting."),
    tags: z.array(z.string().min(1)).optional(),
    recipient_audience: z.enum(["group"]).optional().describe("'group' = notify the whole group."),
    recipient_user_ids: z.array(positiveId).optional().describe("User ids to notify."),
    recipient_emails: z
      .array(z.string().email())
      .optional()
      .describe("Emails to notify; non-members become guests."),
    recipient_message: z.string().optional().describe("Text for the notification."),
    notify_recipients: z
      .boolean()
      .optional()
      .describe("false = add recipients without emailing them."),
  })
  .superRefine((input, ctx) => {
    refuseHtmlWithoutFormat(ctx, input.description, input.description_format, "description");
  });

/** What every discussion write answers: the record as get_discussion shapes it, plus who and where. */
export interface DiscussionWriteResult {
  discussion: ShapedDiscussion;
  /** The thread's group when Loomio side-loaded it (create and update do), else null. */
  group: SlimGroup | null;
  users: SlimUser[];
}

/**
 * The record a write echoed, shaped like a `get_discussion` answer.
 * Loomio's b2 writes `respond_with_resource`, i.e. the same serializer
 * and side-loads as the show (`discussions`, `topics`, `groups`,
 * `users`), so the topic counters join the same way; the description
 * is returned whole — the caller just wrote it, and Loomio may have
 * normalised it. A missing record is a shape this connector does not
 * know, named as such rather than returned as an empty success.
 */
function shapeDiscussionWrite(body: DiscussionsResponse, where: string): DiscussionWriteResult {
  const record = body.discussions?.[0];
  if (!record) {
    throw new LoomioApiError(
      502,
      `Loomio answered ${where} without a discussion record; the response shape is not the one ` +
        "Loomio 3.8.1 produces.",
    );
  }
  const [joined] = joinTopics([record], body.topics);
  const group =
    (body.groups ?? []).find((g) => g.id === record.group_id) ?? body.groups?.[0] ?? undefined;
  return {
    discussion: shapeDiscussion(joined ?? record, { descriptionMaxChars: -1 }),
    group: group ? slimGroup(group) : null,
    users: slimUsers(body.users),
  };
}

export async function createDiscussion(
  input: z.infer<typeof createDiscussionSchema>,
): Promise<DiscussionWriteResult> {
  const resp = await loomioPost<DiscussionsResponse>(
    "/b2/discussions",
    nestedBody("discussion", input),
  );
  const created = resp.discussions?.[0];
  // Misdirected-write guard. The one way a discussion lands in the wrong
  // group is a body Loomio did not read the way we meant (a flat body
  // losing group_id would create it under the user's default context);
  // if the record Loomio echoes disagrees with the request, say so and
  // name the id so the caller can find and discard it — never report
  // success for a thread in the wrong place.
  if (created && created.group_id !== input.group_id) {
    throw new LoomioApiError(
      502,
      `create_discussion: Loomio created discussion ${created.id} in group ${created.group_id ?? "null"}, ` +
        `not the requested group ${input.group_id}. The record exists — review it (get_discussion ` +
        `${created.id}) and delete it (delete_discussion) if misplaced. This indicates the write body ` +
        "was not read as intended; report it.",
    );
  }
  return shapeDiscussionWrite(resp, "POST /b2/discussions");
}

// ── update_discussion ───────────────────────────────────────────────────────
//
// `PATCH /b2/discussions/{id}` → `load_resource` (`Discussion.find` —
// friendly_id finders, so an id OR a short key) then
// `DiscussionService.update(discussion:, params: resource_params,
// actor:)`. The body is NESTED for the same reason as create: the
// controller's `permitted_params` takes `params[:discussion]` verbatim
// when present. Proof of the wire format: Loomio's controller test
// "update happy case" (test/controllers/api/b2/discussions_controller_test.rb,
// 3.8.1) PATCHes `title` / `description` / `description_format` and
// asserts the echoed `discussions[0].title`; it posts form params, which
// take the flat fallback of the very same `permitted_params`. The
// nested JSON form was verified live against a 3.8.1 instance
// (`{"discussion":{"title":…}}` → 200, title updated).
//
// What the service does with the hash (DiscussionService.update):
//   - `TOPIC_ATTRS` are pulled out and only `TOPIC_ATTRS_UPDATE`
//     (private, max_depth, newest_first, allow_concurrent_polls,
//     allow_comments, allow_reactions, comment_length_max, locked_at,
//     pinned_at) reach `discussion.topic.update!`. `group_id` and
//     `tags` are pulled out too and then DROPPED — a discussion cannot
//     be moved through this route, and tags sent here are a silent
//     no-op in 3.8.1, which is why neither is offered below.
//   - the rest goes to the discussion; `recipient_*` add readers
//     (`TopicService.add_users`), and a present `recipient_message`
//     creates a `discussion_edited` thread item and notifies them.
// Authorization (app/models/ability/discussion.rb `:update`): the
// discussion is kept AND the user is its author, a thread admin, or a
// group member where `members_can_edit_discussions`. A refusal is 403
// "Not authorized to update Discussion."; an unknown id or key is 404.

const recipientFields = {
  recipient_audience: z
    .enum(["group"])
    .optional()
    .describe("'group' = notify the whole group (needs announce permission)."),
  recipient_user_ids: z
    .array(positiveId)
    .optional()
    .describe("User ids to add as readers and notify."),
  recipient_emails: z
    .array(z.string().email())
    .optional()
    .describe("Emails to invite as readers; non-members become guests."),
  recipient_message: z
    .string()
    .optional()
    .describe("Notification text; records a visible 'edited' item."),
  notify_recipients: z
    .boolean()
    .optional()
    .describe("false = add recipients without emailing them."),
};

const DISCUSSION_UPDATE_FIELDS = [
  "title",
  "description",
  "description_format",
  "private",
  "allow_comments",
  "allow_reactions",
  "allow_concurrent_polls",
] as const;

export const updateDiscussionSchema = z
  .object({
    id_or_key: idOrKey.describe("Discussion id or short key."),
    title: z.string().min(1).optional(),
    description: z.string().optional().describe("New body; REPLACES the whole description."),
    description_format: z
      .enum(["md", "html"])
      .optional()
      .describe("Omitted = the STORED format stays; send 'html' when the text is HTML."),
    private: z
      .boolean()
      .optional()
      .describe("true = members only; must fit `discussion_privacy_options`."),
    allow_comments: z.boolean().optional().describe("Whether members may comment."),
    allow_reactions: z.boolean().optional().describe("Whether members may react."),
    allow_concurrent_polls: z.boolean().optional().describe("Allow several open polls at once."),
    ...recipientFields,
  })
  .superRefine((input, ctx) => {
    const touched = [
      ...DISCUSSION_UPDATE_FIELDS,
      "recipient_audience",
      "recipient_user_ids",
      "recipient_emails",
    ].some((k) => input[k as keyof typeof input] !== undefined);
    if (!touched) {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message:
          "Nothing to update: pass at least one of title, description, private, allow_comments, " +
          "allow_reactions, allow_concurrent_polls, or recipients to add.",
      });
    }
  });

export async function updateDiscussion(
  input: z.infer<typeof updateDiscussionSchema>,
): Promise<DiscussionWriteResult> {
  const { id_or_key, ...attrs } = input;
  const path = `/b2/discussions/${encodePathSegment(id_or_key)}`;
  const resp = await loomioPatch<DiscussionsResponse>(path, nestedBody("discussion", attrs));
  return shapeDiscussionWrite(resp, `PATCH ${path}`);
}

// ── delete_discussion ───────────────────────────────────────────────────────
//
// `DELETE /b2/discussions/{id}` → `load_resource` then
// `DiscussionService.discard` → `TopicService.discard_without_authorization`:
// a SOFT discard. The row stays; `discarded_at` / `discarded_by` are
// stamped on the discussion and its topic, the serializer nulls `title`
// and `description` (`hide_when_discarded`), the thread leaves every
// list (`kept` scopes) and an admin can restore it from Loomio's UI.
// Nothing is destroyed. Proof: controller test "destroy soft deletes
// discussion" (3.8.1) asserts `discarded_at` on the record, its topic
// and the echoed JSON; DELETE was also exercised live (200, title
// nulled). Authorization (`:discard`): kept AND author or thread admin —
// 403 "Not authorized to discard Discussion." otherwise; unknown → 404.

export const deleteDiscussionSchema = z.object({
  id_or_key: idOrKey.describe("Discussion id or short key."),
});

export interface DeleteDiscussionResult extends DiscussionWriteResult {
  /** True when Loomio's echo carries `discarded_at` — the record is now hidden, not destroyed. */
  discarded: boolean;
  note: string;
}

export async function deleteDiscussion(
  input: z.infer<typeof deleteDiscussionSchema>,
): Promise<DeleteDiscussionResult> {
  const path = `/b2/discussions/${encodePathSegment(input.id_or_key)}`;
  const resp = await loomioDelete<DiscussionsResponse>(path);
  const shaped = shapeDiscussionWrite(resp, `DELETE ${path}`);
  return {
    ...shaped,
    discarded: typeof shaped.discussion.discarded_at === "string",
    note:
      "Soft-discarded: the discussion and its thread are hidden from every list and their title/body " +
      "nulled, but the records remain and a group admin can restore them in Loomio. Nothing was " +
      "permanently deleted.",
  };
}
