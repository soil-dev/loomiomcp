import { z } from "zod";
import {
  isReadOnly,
  LoomioApiError,
  LoomioReadOnlyError,
  loomioDelete,
  loomioGet,
  loomioPatch,
  loomioPost,
  nestedBody,
  readParams,
} from "../loomio/client.js";
import {
  joinTopics,
  omit,
  pick,
  pollUrl,
  type SlimGroup,
  type SlimUser,
  slimGroup,
  slimUsers,
  stripBodyHtml,
  type TopicJoin,
  truncateBody,
} from "../loomio/shape.js";
import type {
  LoomioOutcome,
  LoomioPoll,
  LoomioPollOption,
  LoomioStance,
  PollsResponse,
} from "../loomio/types.js";
import { type GatedPoll, gatePollResults, ownStanceFor } from "../loomio/visibility.js";
import {
  DEFAULT_DESCRIPTION_MAX_CHARS,
  encodePathSegment,
  formatFieldDescription,
  idOrKey,
  isoTimestamp,
  maxCharsSchema,
  POLL_TYPE_RULES,
  PollTypeEnum,
  positiveId,
  refuseHtmlWithoutFormat,
} from "./_common.js";
import { resolveThread, type ThreadRef } from "./threads.js";

// ── Shaping a poll record ───────────────────────────────────────────────────
//
// Three things happen to every poll before a caller sees it:
//
//   1. Topic join. As for discussions, the thread counters live on the
//      side-loaded `topics[]` row (joined by `poll.topic_id`), so the
//      reads keep that root and `joinTopics` folds the counters on.
//   2. Result gating (src/loomio/visibility.ts). PollSerializer emits
//      `results` / `stance_counts` / `total_score` / `stv_results`
//      whenever `results_available?` — i.e. for every open `until_vote`
//      poll too, although Loomio's own client hides them from a member
//      who has not voted. The connector applies Loomio's full predicate
//      (`results_visible?(voted:)`) with "voted" = the API user's own
//      `my_stance` is cast, strips the four fields when it says no, and
//      always emits `results_visible` + `results_hidden_reason` so the
//      caller can tell "no results" from "hidden results".
//   3. Side-load folding. The poll's options (`poll_options` root, by
//      `poll_id`), its current outcome (`outcomes` root, by
//      `current_outcome_id`) and the API user's own stance (`stances`
//      root — on these endpoints it holds ONLY `my_stance` rows) are
//      attached to the poll as `poll_options[]`, `current_outcome` and
//      `my_stance`, slimmed to their meaningful fields.
//
// Dropped from the record: attachment metadata (kept as a count),
// link-preview cards, `mentioned_usernames`, `content_locale` and the
// chart/result-presentation knobs Loomio's Vue client reads.
// `poll_option_names` stays on the show: it is cheap and survives a
// missing `poll_options` root. `details` (the body) is capped on lists,
// and `strip_html` (list default true, show default false) turns an
// HTML `details` into plain text BEFORE the cap, flagged
// `details_format: "text"` (`stripBodyHtml`, src/loomio/shape.ts).
//
// Two shapes. The SHOW (get_poll, the write echoes) returns the record
// whole minus that bloat. A LIST row is slimmer, because `results[]` —
// per option: `voter_ids` (up to 50), a `voter_scores` map over every
// voter, colour, icon, rank, percentages, plus a synthetic "undecided"
// row (id -1) listing the non-voters — was measured at 30–40 % of a
// visible poll's bytes and, over a 50-row page with ~100 voters,
// hundreds of KB of user ids a list has no use for. Its per-option
// tallies are already `stance_counts` (poll.rb `update_counts!`:
// `poll_options.map(&:total_score)` in priority order, i.e. aligned
// with the `poll_options[]` the row carries), so a list row keeps
// `stance_counts` + `total_score`, drops `results` / `stv_results`, keeps
// the type-specific voting knobs only when Loomio set them (they are
// null for every other type), and drops `poll_option_names` when
// `poll_options[]` already names them. get_poll has everything.

const POLL_DROP = [
  "attachments",
  "link_previews",
  "mentioned_usernames",
  "content_locale",
  "result_columns",
  "chart_type",
  "chart_column",
  "legacy_anonymous_vote_reasons_count",
  "poll_option_name_format",
  "limit_reason_length",
] as const;

/** Result breakdowns a LIST row leaves to get_poll (`stance_counts` / `total_score` stay). */
const LIST_POLL_DROP = ["results", "stv_results"] as const;

/**
 * Type-specific voting knobs Loomio nulls for every type they do not
 * apply to (`stv_seats` on a proposal, `meeting_duration` on a score
 * poll, …). A list row keeps them only when set, so a 50-row page is
 * not 50 × the same twenty nulls.
 */
const LIST_POLL_NULLABLE_KNOBS = [
  "agree_target",
  "opening_at",
  "opened_at",
  "discarded_by",
  "meeting_duration",
  "can_respond_maybe",
  "stv_seats",
  "stv_method",
  "stv_quota",
  "poll_template_id",
  "poll_template_key",
  "quorum_pct",
  "reason_prompt",
  "min_score",
  "max_score",
  "dots_per_person",
  "minimum_stance_choices",
  "maximum_stance_choices",
] as const;

const POLL_OPTION_FIELDS = ["id", "name", "priority", "meaning", "prompt"] as const;

const OUTCOME_FIELDS = [
  "id",
  "poll_id",
  "poll_option_id",
  "statement",
  "statement_format",
  "author_id",
  "created_at",
  "review_on",
  "latest",
] as const;

/** The API user's own stance: what it voted and why. `participant_id` is implied (it is the user). */
const OWN_STANCE_FIELDS = [
  "id",
  "cast_at",
  "revoked_at",
  "option_scores",
  "none_of_the_above",
  "reason",
  "reason_format",
] as const;

export interface PollSideLoads {
  poll_options?: readonly LoomioPollOption[];
  outcomes?: readonly LoomioOutcome[];
  /** The `stances` root — `my_stance` rows only on the poll list and show. */
  stances?: readonly LoomioStance[];
}

export type ShapedPoll = Partial<GatedPoll<LoomioPoll>> &
  Partial<TopicJoin> &
  Record<string, unknown> & {
    poll_options: Pick<LoomioPollOption, (typeof POLL_OPTION_FIELDS)[number]>[];
    current_outcome: Pick<LoomioOutcome, (typeof OUTCOME_FIELDS)[number]> | null;
    my_stance: Pick<LoomioStance, (typeof OWN_STANCE_FIELDS)[number]> | null;
    url?: string;
  };

/**
 * One poll as the tools present it (see the module note). Pure; the
 * input is not mutated. `opts.detailsMaxChars` follows the
 * `*_max_chars` contract (-1 full, 0 omit, N cap); `opts.stripHtml`
 * converts an HTML `details` to plain text (`details_format: "text"`)
 * before that cap; `opts.mode` picks the show shape (default) or the
 * slimmer list row.
 */
export function shapePoll(
  record: LoomioPoll & Partial<TopicJoin>,
  side: PollSideLoads,
  opts: { detailsMaxChars: number; stripHtml?: boolean; mode?: "show" | "list" },
): ShapedPoll {
  const own = ownStanceFor(record.id, side.stances, { showRoot: true });
  const gated = gatePollResults(record, own);
  const list = opts.mode === "list";
  const base = omit(gated, list ? [...POLL_DROP, ...LIST_POLL_DROP] : POLL_DROP);
  if (list) {
    for (const knob of LIST_POLL_NULLABLE_KNOBS) if (base[knob] == null) delete base[knob];
  }
  const withCounts = Array.isArray(record.attachments)
    ? { ...base, attachments_count: record.attachments.length }
    : base;
  // Strip first, cap second (see shapeDiscussion): the cap lands on
  // words and `details_chars` counts the text the caller receives.
  const body = opts.stripHtml ? stripBodyHtml(withCounts, "details", "details_format") : withCounts;
  const truncated = truncateBody(body, "details", opts.detailsMaxChars, "details_format");

  const poll_options = (side.poll_options ?? [])
    .filter((o) => o.poll_id === record.id)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((o) => pick(o, POLL_OPTION_FIELDS));
  if (list && poll_options.length > 0) delete truncated["poll_option_names"];

  // `current_outcome_id` is authoritative; fall back to the latest
  // outcome for the poll when the id is absent (older records).
  const outcomes = side.outcomes ?? [];
  const outcome =
    (record.current_outcome_id != null
      ? outcomes.find((o) => o.id === record.current_outcome_id)
      : undefined) ?? outcomes.find((o) => o.poll_id === record.id && o.latest !== false);

  const url = record.key ? pollUrl(record.key, { title: record.title }) : undefined;
  return {
    ...truncated,
    poll_options,
    current_outcome: outcome ? pick(outcome, OUTCOME_FIELDS) : null,
    my_stance: own ? pick(own, OWN_STANCE_FIELDS) : null,
    ...(url ? { url } : {}),
  } as ShapedPoll;
}

function sideLoadsOf(body: PollsResponse): PollSideLoads {
  return { poll_options: body.poll_options, outcomes: body.outcomes, stances: body.stances };
}

// ── get_poll ────────────────────────────────────────────────────────────────
//
// `GET /b2/polls/{id|key}` → `load_and_authorize(:poll)`; `can?(:show)`
// is `PollQuery.visible_to(user)`. Invisible → 403 "Not authorized to
// show Poll.", unknown → 404. The show profile keeps `groups`.

export const getPollSchema = z.object({
  id_or_key: idOrKey.describe("Poll id or short key."),
  strip_html: z.boolean().optional().describe("Plain text instead of HTML; default false."),
});

export interface GetPollResult {
  poll: ShapedPoll;
  group: SlimGroup | null;
  users: SlimUser[];
}

export async function getPoll(input: z.infer<typeof getPollSchema>): Promise<GetPollResult> {
  const body = await loomioGet<PollsResponse>(
    `/b2/polls/${encodePathSegment(input.id_or_key)}`,
    readParams("show"),
  );
  const record = body.polls?.[0];
  if (!record) {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/polls/${input.id_or_key} without a poll record; the response shape is ` +
        "not the one Loomio 3.8.1 produces.",
    );
  }
  const [joined] = joinTopics([record], body.topics);
  const group =
    (body.groups ?? []).find((g) => g.id === record.group_id) ?? body.groups?.[0] ?? undefined;
  return {
    poll: shapePoll(joined ?? record, sideLoadsOf(body), {
      detailsMaxChars: -1,
      stripHtml: input.strip_html ?? false,
    }),
    group: group ? slimGroup(group) : null,
    users: slimUsers(body.users),
  };
}

// ── list_polls ──────────────────────────────────────────────────────────────
//
// `GET /b2/polls?group_id=` → `records_visible_in_group(Poll)` (403 for
// an invisible group, else the polls visible in that group), ordered
// `created_at desc`, paginated, `meta.total` set. `status` is read as
// 'closed' → `Poll.closed` (closed_at set), 'all' → `kept`, and
// ANYTHING ELSE → `Poll.active` (kept, not closed, opened). The
// connector's enum maps 1:1 and its default 'active' is sent explicitly.

export const listPollsSchema = z.object({
  group_id: positiveId,
  status: z
    .enum(["active", "closed", "all"])
    .optional()
    .describe("'active' (default) = open, 'closed', 'all'."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200. Default 50."),
  offset: z.number().int().min(0).optional().describe("Page offset. Default 0."),
  description_max_chars: maxCharsSchema("details", DEFAULT_DESCRIPTION_MAX_CHARS),
  strip_html: z.boolean().optional().describe("Plain text instead of HTML; default true."),
});

export interface ListPollsResult {
  polls: ShapedPoll[];
  users: SlimUser[];
  /** Loomio's `meta.total`: every matching poll, before pagination. */
  total: number;
  returned: number;
  scope: {
    group_id: number;
    status: "active" | "closed" | "all";
    offset: number;
    description_max_chars: number;
    strip_html: boolean;
  };
}

export async function listPolls(input: z.infer<typeof listPollsSchema>): Promise<ListPollsResult> {
  const status = input.status ?? "active";
  const max = input.description_max_chars ?? DEFAULT_DESCRIPTION_MAX_CHARS;
  const stripHtml = input.strip_html ?? true;
  const body = await loomioGet<PollsResponse>("/b2/polls", {
    group_id: input.group_id,
    status,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...readParams("list"),
  });
  const side = sideLoadsOf(body);
  const polls = joinTopics(body.polls, body.topics).map((p) =>
    shapePoll(p, side, { detailsMaxChars: max, stripHtml, mode: "list" }),
  );
  return {
    polls,
    users: slimUsers(body.users),
    total: typeof body.meta?.total === "number" ? body.meta.total : polls.length,
    returned: polls.length,
    scope: {
      group_id: input.group_id,
      status,
      offset: input.offset ?? 0,
      description_max_chars: max,
      strip_html: stripHtml,
    },
  };
}

// ── Poll writes: what Loomio 3.8.1 reads, and from where ───────────────────
//
// `POST /b2/polls` → `PollService.create(params: resource_params, …)`
// then `PollService.invite(poll:, actor:, params: params)`. Two
// different `params`:
//   - `resource_params` is the permitted `poll` hash — NESTED
//     `{"poll":{…}}` for the reasons `nestedBody` documents (a FLAT JSON
//     body loses `group_id` and `options`, which are not Poll columns:
//     verified live, the result is an orphan poll with no options).
//     Every key sent under `poll` is in `PermittedParams#poll_attributes`.
//     `options` is `Poll#options=`, an alias of `poll_option_names=`.
//   - `params` is the raw request hash, and `invite` reads
//     `recipient_user_ids` / `recipient_emails` / `recipient_audience`
//     / `notify_recipients` / `recipient_message` from its TOP level.
//     For a `specified_voters_only` anonymous poll,
//     `create_anonymous_poll_voters` reads the same keys from the
//     NESTED hash instead. So the recipient keys travel in BOTH places
//     (`nestedBody`'s third argument); the nested copies are filtered
//     out by `assign_attributes_and_files` for the model and read only
//     by that one path.
// Attaching to a thread: PermittedParams knows `topic_id`, not
// `discussion_id` (sent nested, it answers 400 — verified live). The
// connector resolves `discussion_id` → the discussion's `topic_id` with
// one compact GET (`resolveThread`), and sends `topic_id` alone:
// `PollService.build` reuses the existing Topic (`poll.topic ||= …`)
// and derives `group_id` from it, ignoring any `group_id` in the body.
// Anonymous polls: `build` forces `voting_system: anonymous_ballot`,
// `hide_results: until_closed`, and `invite` raises a bare
// `CanCan::AccessDenied` for an anonymous poll that is not active — i.e.
// one without a future `closing_at` — AFTER `create` saved it. The
// schema therefore requires `closing_at` when `anonymous`.
// Opening and announcing: `build` sets `opened_at = Time.now` ONLY when
// `closing_at` is present (and `opening_at` blank or past); without it
// the poll is saved as a DRAFT — `opened_at` null, `Poll.active` (the
// list_polls default) excludes it, `can :vote_in` requires `active?`, so
// nobody can vote — with HTTP 200 and no error. The connector reports
// `opened` on every create and a `warning` when it is false.
// `create` then runs `announce_poll_opened(poll) if poll.opened_at &&
// poll.notify_on_open`: a `poll_announced` notification to every
// eligible voter (`poll.stances.latest` minus the author — one stance per
// group member after `create_anyone_can_vote_stances`), in-app for all,
// email/push per volume. `notify_on_open` is a Poll column whose DB
// default is TRUE and is in `PermittedParams#poll_attributes`, so the
// common create_poll call (title + options + closing_at) notifies the
// whole group unless `notify_on_open: false` is sent; `open_poll_if_ready`
// does the same on update when a `closing_at` first opens a draft
// (Loomio's own test/services/poll_service_test.rb asserts the
// notification with notify_on_open true and its absence with false).
// `notify_recipients` is a different, narrower switch: it gates only the
// recipient_*-based announcement in `PollService.invite`.
// Proof of the wire format: controller tests "create happy case no
// notifications" / "… notify email" / "… notify user_id" / "… notify
// group" (test/controllers/api/b2/polls_controller_test.rb, 3.8.1) post
// `group_id`, `title`, `poll_type`, `closing_at`, `options` and the
// `recipient_*` keys and assert `polls[0].group_id`; the nested JSON
// body, `topic_id` attachment and the option-loss symptom of a flat
// body were verified live against a 3.8.1 instance.
// Authorization (`:create`, app/models/ability/poll.rb): group enabled,
// thread not locked, `allow_concurrent_polls` or no active poll in the
// thread, and the user a group admin, a member where
// `members_can_raise_motions`, or a thread admin/member so allowed →
// 403 "Not authorized to create Poll." otherwise.

const HideResultsEnum = z.enum(["off", "until_vote", "until_closed"]);

/** `Poll.notify_on_closing_soon` enum (app/models/poll.rb): the four values Loomio accepts. */
const NotifyOnClosingSoonEnum = z.enum(["nobody", "author", "undecided_voters", "voters"]);

/** `Poll.stance_reason_required` enum. */
const StanceReasonRequiredEnum = z.enum([
  "disabled",
  "optional",
  "required",
  "required_for_disagree_or_block",
  "required_for_block",
]);

/**
 * The tuning knobs Loomio permits on both create and update, all
 * `PermittedParams#poll_attributes`. Every describe here is emitted
 * TWICE in tools/list (create_poll and update_poll), so each carries
 * only the fact that changes a call; the per-type option keys, the
 * anonymous-poll overrides and the notification paths are spelled out
 * in HOWTO.md "Tool reference".
 */
const pollSettingFields = {
  details: z.string().optional(),
  details_format: z.enum(["md", "html"]).optional().describe(formatFieldDescription("details")),
  // Update-safe wording: on PATCH an omitted closing_at leaves the
  // deadline alone, so the shared text must not say "required"; the
  // create-only fact (no closing_at = unopened draft) is overridden in
  // createPollSchema. Without the split, update_poll advertised
  // "Effectively REQUIRED" and a model renaming a poll invented a new
  // deadline. "Next full hour": Loomio rounds closing_at down to the
  // hour and closes on an hourly job, so a nearer time 422s or waits.
  closing_at: isoTimestamp.describe(
    "ISO-8601, future; omitted = unchanged. To end voting soon pass the next full hour.",
  ),
  hide_results: HideResultsEnum.optional().describe(
    "Default 'off'; anonymous polls force 'until_closed'.",
  ),
  specified_voters_only: z.boolean().optional().describe("Only the named recipients may vote."),
  shuffle_options: z.boolean().optional().describe("Randomise option order per voter."),
  notify_on_open: z
    .boolean()
    .optional()
    .describe("Announce (`poll_announced`) on opening; Loomio's default is TRUE."),
  notify_on_closing_soon: NotifyOnClosingSoonEnum.optional().describe(
    "24h closing reminder; API default is 'nobody'.",
  ),
  stance_reason_required: StanceReasonRequiredEnum.optional().describe(
    "Default 'optional'; anonymous polls force 'disabled'.",
  ),
  reason_prompt: z.string().optional().describe("Prompt above the reason box."),
  show_none_of_the_above: z
    .boolean()
    .optional()
    .describe("Offer 'none of the above' (poll, ranked_choice)."),
  min_score: z.number().int().optional().describe("score: min per option (default 0)."),
  max_score: z.number().int().optional().describe("score: max per option (default 5); meeting: 2."),
  dots_per_person: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("dot_vote: points per voter (default 8)."),
  minimum_stance_choices: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Min options per voter (ranked_choice: ranks, default 3)."),
  maximum_stance_choices: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max options per voter (poll: 1; raise for multi-choice)."),
  stv_seats: z.number().int().positive().optional().describe("stv: seats to fill."),
  meeting_duration: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("meeting: slot minutes. No default through the API."),
  can_respond_maybe: z
    .boolean()
    .optional()
    .describe("meeting: allow 'maybe'. API default is false."),
};

/** Recipient keys. On create they go nested AND top-level (see the module note); on update nested only. */
const pollRecipientFields = {
  recipient_audience: z
    .enum(["group"])
    .optional()
    .describe("'group' = every member (needs announce permission)."),
  recipient_user_ids: z.array(positiveId).optional().describe("User ids to invite / notify."),
  recipient_emails: z
    .array(z.string().email())
    .optional()
    .describe("Emails to invite; non-members become guests."),
  recipient_message: z.string().optional().describe("Text for the notification."),
  notify_recipients: z
    .boolean()
    .optional()
    .describe("Email/push the named recipients; SEPARATE from notify_on_open."),
};

const RECIPIENT_KEYS = [
  "recipient_audience",
  "recipient_user_ids",
  "recipient_emails",
  "recipient_message",
  "notify_recipients",
] as const;

function splitRecipients<T extends Record<string, unknown>>(
  attrs: T,
): { rest: Record<string, unknown>; recipients: Record<string, unknown> } {
  const recipients: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...attrs };
  for (const key of RECIPIENT_KEYS) {
    if (rest[key] !== undefined) recipients[key] = rest[key];
  }
  return { rest, recipients };
}

export const createPollSchema = z
  .object({
    title: z.string().min(1),
    poll_type: PollTypeEnum.describe(
      "'question' has no options; 'meeting' options are ISO-8601 times; 'stv' takes stv_seats.",
    ),
    group_id: positiveId
      .optional()
      .describe("Group of a STANDALONE poll (else only cross-checked)."),
    discussion_id: idOrKey
      .optional()
      .describe("Discussion to attach to (id or key; +1 call). Prefer topic_id."),
    topic_id: positiveId
      .optional()
      .describe("Thread id (`topic_id` on any thread row); no extra call."),
    options: z
      .array(z.string().min(1))
      .optional()
      .describe("Option names in order. REQUIRED except 'question'; ranked_choice/stv need 2+."),
    anonymous: z
      .boolean()
      .optional()
      .describe("Permanent. Needs closing_at; not for count, question, meeting."),
    tags: z.array(z.string().min(1)).optional().describe("Tags for a standalone poll's thread."),
    ...pollSettingFields,
    // Create-only override of the shared field: a poll saved without
    // closing_at is a draft nobody is asked to vote on.
    closing_at: isoTimestamp.describe(
      "ISO-8601, future. Effectively REQUIRED: omitted = unopened draft.",
    ),
    ...pollRecipientFields,
  })
  .superRefine((input, ctx) => {
    const refs = [input.group_id, input.discussion_id, input.topic_id].filter(
      (v) => v !== undefined,
    ).length;
    if (refs === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["group_id"],
        message:
          "Pass group_id (standalone poll) or discussion_id / topic_id (poll inside a thread).",
      });
    }
    if (input.discussion_id !== undefined && input.topic_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["topic_id"],
        message: "Pass either discussion_id or topic_id, not both.",
      });
    }
    const rules = POLL_TYPE_RULES[input.poll_type];
    const count = input.options?.length ?? 0;
    if (rules.hasOptions && count < rules.minOptions) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message:
          `poll_type '${input.poll_type}' needs at least ${rules.minOptions} option${rules.minOptions === 1 ? "" : "s"}: ` +
          "Loomio has no built-in defaults through the API and would save the poll with none.",
      });
    }
    if (!rules.hasOptions && count > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `poll_type '${input.poll_type}' takes no options (voters answer in free text).`,
      });
    }
    if (input.anonymous) {
      if (rules.preventAnonymous) {
        ctx.addIssue({
          code: "custom",
          path: ["anonymous"],
          message: `poll_type '${input.poll_type}' cannot be anonymous (Loomio's prevent_anonymous).`,
        });
      }
      if (input.closing_at === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["closing_at"],
          message:
            "Anonymous polls need a future closing_at: Loomio refuses to invite voters to an anonymous " +
            "poll that is not open (403 after the poll was saved), and results appear only at close.",
        });
      }
      if (input.hide_results !== undefined && input.hide_results !== "until_closed") {
        ctx.addIssue({
          code: "custom",
          path: ["hide_results"],
          message:
            "Anonymous polls are always hide_results 'until_closed' (Loomio forces it); omit it.",
        });
      }
    }
    refuseHtmlWithoutFormat(ctx, input.details, input.details_format, "details");
  });

export type CreatePollInput = z.infer<typeof createPollSchema>;

export interface PollWriteResult {
  poll: ShapedPoll;
  group: SlimGroup | null;
  users: SlimUser[];
}

export interface CreatePollResult extends PollWriteResult {
  /** False when Loomio saved the poll as a draft (no `closing_at` → `opened_at` null): nobody can vote yet. */
  opened: boolean;
  /** Present when `opened` is false: what happened and how to open the poll. */
  warning?: string;
}

const UNOPENED_WARNING =
  "Poll saved but NOT open for voting: no closing_at was given, so Loomio left opened_at null. " +
  "Members cannot vote and list_polls (status 'active') will not show it. Call update_poll with a " +
  "future closing_at to open it (Loomio then announces it to eligible voters unless notify_on_open " +
  "is false), or delete_poll if it was not meant as a draft.";

function shapePollWrite(body: PollsResponse, where: string): PollWriteResult {
  const record = body.polls?.[0];
  if (!record) {
    throw new LoomioApiError(
      502,
      `Loomio answered ${where} without a poll record; the response shape is not the one Loomio ` +
        "3.8.1 produces.",
    );
  }
  const [joined] = joinTopics([record], body.topics);
  const group =
    (body.groups ?? []).find((g) => g.id === record.group_id) ?? body.groups?.[0] ?? undefined;
  return {
    poll: shapePoll(joined ?? record, sideLoadsOf(body), { detailsMaxChars: -1 }),
    group: group ? slimGroup(group) : null,
    users: slimUsers(body.users),
  };
}

function misdirected(created: LoomioPoll, detail: string): LoomioApiError {
  return new LoomioApiError(
    502,
    `create_poll: Loomio created poll ${created.id} but ${detail}. The record exists — review it ` +
      `(get_poll ${created.id}) and delete it (delete_poll) if misplaced. The request and Loomio's ` +
      "echo disagree on something the connector checked or sent, which indicates the write body was " +
      "not read as intended; report it.",
  );
}

export async function createPoll(input: CreatePollInput): Promise<CreatePollResult> {
  // A read-only deployment refuses the WRITE up front — before the
  // discussion lookup below spends a call on a poll that will never be
  // created. `loomioPost` would refuse too, but only after that GET.
  if (isReadOnly()) throw new LoomioReadOnlyError("POST");
  const { group_id, discussion_id, topic_id, ...attrs } = input;

  // Where the poll goes. A discussion reference costs one compact GET
  // (the same resolver the thread tools use) and yields the thread id
  // AND the discussion's group, so a `group_id` given alongside can be
  // checked BEFORE anything is written: a poll meant for group A must
  // not land in a thread of group B because two ids disagreed. A
  // `topic_id` alone costs nothing; `topic_id` WITH a `group_id` pays
  // the same one GET (`GET /b2/threads/{topic_id}`, whose row carries
  // the group) so the promise "refused before anything is written"
  // holds on that path too — Loomio derives the group from the thread
  // and would otherwise create a correctly placed poll that the
  // post-write guard below then reports as misdirected.
  let attachTopicId: number | undefined = topic_id;
  const ref: ThreadRef | undefined =
    discussion_id !== undefined
      ? { discussion_id }
      : topic_id !== undefined && group_id !== undefined
        ? { topic_id }
        : undefined;
  if (ref) {
    const { header } = await resolveThread(ref, { lookupTopic: true });
    attachTopicId = header.topic_id;
    if (group_id !== undefined && header.group_id !== null && header.group_id !== group_id) {
      const named =
        discussion_id !== undefined ? `discussion ${discussion_id}` : `thread ${topic_id}`;
      throw new LoomioApiError(
        409,
        `create_poll: ${named} belongs to group ${header.group_id}, not the requested group ` +
          `${group_id}. Nothing was created — drop group_id to attach the poll to the thread (its ` +
          "group is authoritative), or drop discussion_id / topic_id for a standalone poll in that group.",
      );
    }
  }

  const { rest, recipients } = splitRecipients(attrs);
  const pollAttrs =
    attachTopicId !== undefined
      ? { ...rest, topic_id: attachTopicId, ...recipients }
      : { ...rest, group_id, ...recipients };
  const resp = await loomioPost<PollsResponse>(
    "/b2/polls",
    nestedBody("poll", pollAttrs, recipients),
  );

  const created = resp.polls?.[0];
  if (created) {
    // Misdirected-write guards: the echo must agree with the request on
    // WHERE the poll is and must carry the options we sent. A flat body
    // (or a future Loomio reading the hash differently) produces exactly
    // these symptoms — an orphan poll, or one with `poll_option_names: []`
    // — and success must never be reported for either.
    if (attachTopicId !== undefined && created.topic_id !== attachTopicId) {
      throw misdirected(
        created,
        `in thread ${created.topic_id ?? "null"}, not the requested thread ${attachTopicId}`,
      );
    }
    if (group_id !== undefined && created.group_id !== group_id) {
      throw misdirected(
        created,
        `in group ${created.group_id ?? "null"}, not the requested group ${group_id}`,
      );
    }
    if (
      (input.options?.length ?? 0) > 0 &&
      Array.isArray(created.poll_option_names) &&
      created.poll_option_names.length === 0
    ) {
      throw misdirected(created, "with NO options although options were sent");
    }
  }
  const shaped = shapePollWrite(resp, "POST /b2/polls");
  // A draft is a silent outcome Loomio answers 200 to (see the module
  // note): say so on the result instead of leaving `opened_at: null` for
  // the caller to notice.
  const opened = created?.opened_at != null;
  return opened ? { ...shaped, opened } : { ...shaped, opened, warning: UNOPENED_WARNING };
}

// ── update_poll ─────────────────────────────────────────────────────────────
//
// `PATCH /b2/polls/{id}` → `load_resource` (`Poll.find`, friendly_id
// finders: id or key) → `PollService.update(poll:, params:
// resource_params, actor:)`. Body NESTED `{"poll":{…}}`; the service
// reads the recipient keys from THIS hash (`UserInviter.authorize!(
// user_ids: params[:recipient_user_ids] …)`), so on update they are
// nested only. `poll_type` is dropped by the service
// (`params.except(:poll_type, …)`) and `group_id` / `tags` are pulled
// into topic params and then discarded (`TOPIC_ATTRS_UPDATE`), so none
// of them is offered.
//
// `options` is DANGEROUS on the wire and the connector neutralises it.
// `Poll#options=` is an alias of `poll_option_names=` (poll.rb), which
// treats the array as the COMPLETE option set: `removed = existing -
// names; poll_options.each { mark_for_destruction if removed… }`, and
// `accepts_nested_attributes_for :poll_options, allow_destroy: true`
// autosaves the destruction — with `PollOption has_many :stance_choices,
// dependent: :destroy`, so every vote cast on an omitted option is
// hard-deleted (Loomio's own tests pin this: `update!(poll_option_names:
// two of three)` leaves two). Nothing validates against it on an open,
// non-anonymous poll and Loomio answers 200. A caller told "options
// adds names" who sends `["C"]` would therefore wipe A and B and their
// ballots. So when `options` is given the connector first GETs the poll
// (`compact=1`), takes Loomio's STORED `poll_option_names` (which may
// differ from what was sent at create: common keys are re-labelled in
// the instance's locale, "agree" → "Agree"), and PATCHes the union —
// existing names first, in their order, then the new ones — so the
// tool's additive contract is honest at the cost of one extra call.
// Names already present (exact match) are not repeated; a name that
// differs only in case would create a second option, hence the schema
// text asks for `poll_option_names` spelling. Removal is deliberately
// not offered. What the pre-read cannot close is the WINDOW between it
// and the PATCH: an option another editor adds in that instant is
// absent from the union and Loomio destroys it (with any votes already
// cast on it) on 200, without a signal — the b2 API has no atomic
// add-option primitive and no version check (`versions_count` does not
// move on an option-only change: `has_paper_trail only:` filters on
// columns), and the echo cannot reveal it either (it reflects the
// post-destruction state and equals `options_sent` by construction;
// `removed_poll_option_ids` is not serialised). Loomio's own Vue client
// submits the complete set the same way over a minutes-long form
// window, so this is strictly narrower than the reference UI — but the
// contract is "never removes an option it SAW", not "never removes",
// and the description says so. A present `recipient_message` records a `poll_edited`
// item and notifies. Proof: controller test "update happy case" (3.8.1)
// PATCHes title / details / details_format and asserts `polls[0].title`;
// nested JSON verified live (200); the replacement semantics of
// `options` come from poll.rb / poll_option.rb and Loomio's model tests,
// not from a live run.
// Authorization (`:update`): thread not locked, poll kept, NOT closed,
// and the user a poll admin (author or group admin) → 403 "Not
// authorized to update Poll." otherwise (a closed poll cannot be edited;
// reopen it in Loomio first). Model rules that answer 422: `anonymous`
// cannot be switched (either way — omitted here), `hide_results` cannot
// leave 'until_closed', `closing_at` must be in the future, and an
// anonymous poll's configuration is frozen once a ballot exists.

export const updatePollSchema = z
  .object({
    id_or_key: idOrKey.describe("Poll id or short key."),
    title: z.string().min(1).optional(),
    options: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        "Names to ADD (+1 call): merged with the stored names, so it never removes an option it saw. Not atomic.",
      ),
    ...pollSettingFields,
    // Update-only override: the shared "Default 'off'" describes a new
    // poll; on PATCH the rule that matters is the one Loomio enforces
    // (poll.rb: hide_results cannot leave 'until_closed').
    hide_results: HideResultsEnum.optional().describe("Cannot leave 'until_closed' once set."),
    ...pollRecipientFields,
  })
  .superRefine((input, ctx) => {
    const { id_or_key: _id, ...rest } = input;
    if (Object.values(rest).every((v) => v === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "Nothing to update: pass at least one poll field or recipients to add.",
      });
    }
    refuseHtmlWithoutFormat(ctx, input.details, input.details_format, "details");
  });

export interface UpdatePollResult extends PollWriteResult {
  /**
   * Present when `options` was given: the complete option list the
   * connector sent (Loomio's stored names ∪ the new ones), so the caller
   * can see that nothing was dropped.
   */
  options_sent?: string[];
}

/**
 * The full option list to PATCH so that `names` are ADDED: Loomio's
 * stored names first, in their order, then each new name not already
 * present (exact match). Exported for the tests; pure.
 */
export function mergePollOptions(existing: readonly string[], names: readonly string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function updatePoll(
  input: z.infer<typeof updatePollSchema>,
): Promise<UpdatePollResult> {
  // Refuse the write before the option lookup spends a call (see create).
  if (isReadOnly()) throw new LoomioReadOnlyError("PATCH");
  const { id_or_key, options, ...attrs } = input;
  const path = `/b2/polls/${encodePathSegment(id_or_key)}`;

  // `options` REPLACES on the wire (see the module note): read the stored
  // names and send the union so the documented ADD semantics hold.
  let optionsSent: string[] | undefined;
  if (options !== undefined) {
    const current = await loomioGet<PollsResponse>(path, readParams("compact"));
    const record = current.polls?.[0];
    if (!record || !Array.isArray(record.poll_option_names)) {
      throw new LoomioApiError(
        502,
        `Loomio answered GET ${path} without a poll carrying poll_option_names, so the connector cannot ` +
          "tell which options exist. Nothing was changed: sending `options` blind would let Loomio " +
          "delete every option not in the list, votes included.",
      );
    }
    optionsSent = mergePollOptions(record.poll_option_names, options);
  }

  const body = optionsSent ? { ...attrs, options: optionsSent } : attrs;
  const resp = await loomioPatch<PollsResponse>(path, nestedBody("poll", body));
  const shaped = shapePollWrite(resp, `PATCH ${path}`);
  return optionsSent ? { ...shaped, options_sent: optionsSent } : shaped;
}

// ── delete_poll ─────────────────────────────────────────────────────────────
//
// `DELETE /b2/polls/{id}` → `PollService.discard`: SOFT. Stamps
// `discarded_at` / `discarded_by`, destroys the thread's `stance_created`
// / `stance_updated` items for the poll (the votes' rows stay), unpins
// the poll's own item and re-sequences the thread; the serializer nulls
// title/details (`hide_when_discarded`). Restorable by an admin in
// Loomio's UI. Proof: controller test "destroy soft deletes poll" (3.8.1)
// asserts `discarded_at` and `discarded_by`; DELETE exercised live (200).
// Authorization (`:destroy`): thread not locked, poll kept, user a poll
// admin → 403 "Not authorized to destroy Poll." otherwise; unknown → 404.

export const deletePollSchema = z.object({
  id_or_key: idOrKey.describe("Poll id or short key."),
});

export interface DeletePollResult extends PollWriteResult {
  discarded: boolean;
  note: string;
}

export async function deletePoll(
  input: z.infer<typeof deletePollSchema>,
): Promise<DeletePollResult> {
  const path = `/b2/polls/${encodePathSegment(input.id_or_key)}`;
  const resp = await loomioDelete<PollsResponse>(path);
  const shaped = shapePollWrite(resp, `DELETE ${path}`);
  return {
    ...shaped,
    discarded: typeof shaped.poll.discarded_at === "string",
    note:
      "Soft-discarded: the poll is hidden from every list, its title/details nulled and its vote items " +
      "removed from the thread view, but the records remain and a group admin can restore it in " +
      "Loomio. Nothing was permanently deleted.",
  };
}
