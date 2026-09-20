import { z } from "zod";
import { LoomioApiError, LoomioAuthError, loomioGet } from "../loomio/client.js";
import { checkLoomioHealth, keyRejectedWarning } from "../loomio/health.js";

// ── list_groups (probe-based enumeration) ──────────────────────────────────
//
// Loomio 3.8.1 does expose GET /api/b2/groups (GroupsController#index →
// `current_user.groups`), but this connector does not call it yet — the
// native listing arrives in v0.0.12. Until then list_groups keeps its
// original strategy: one `b2/polls?group_id=N&limit=1&status=all` per id
// over a range, collecting the group objects the 200 responses side-load.
//
// Why b2/polls and not another list endpoint:
//   - b2/memberships answers 200 with an EMPTY list to a non-member (no
//     group side-loaded), so it cannot tell "member of a group" from
//     "not a member" — the one thing an enumeration needs to know.
//   - b2/discussions and b2/polls both go through
//     `records_visible_in_group` (Api::B2::BaseController): 403 when the
//     group is not visible to the connector's user, otherwise the
//     visible records with their group side-loaded. Polls is the cheaper
//     of the two and was kept.
//
// What each status means (Ability::Group, Loomio 3.8.1):
//   200 → the group exists and `can?(:show, group)`: the connector's
//         user is a member, OR the group is publicly visible (Loomio
//         ≥ 3.8 lets any authenticated user read public groups), OR it
//         is a subgroup visible to parent-group members. Instance
//         `is_admin` is NOT consulted — an instance admin sees exactly
//         the groups it belongs to, like any other user.
//   404 → no group with that id. Only reachable with a VALID key:
//         `Group.find` runs after `authenticate_api_key!`.
//   403 → the group exists but is not visible to the connector's user.
//         ALSO what every probe returns when the API key is rejected
//         (`authenticate_api_key!` is a prepend_before_action, so it
//         fires before the group lookup — even for ids that do not
//         exist). A zero-group scan therefore consults the key-health
//         probe before being returned as an empty list, and FORCES a
//         fresh probe when any miss was a 403: the scan's own evidence
//         (403s where a valid key would have produced 404s) outranks a
//         cached `valid` that may predate a rotation by up to a minute
//         (see `listGroups` / `explainEmptyScan`).
//
// CAVEAT — a group with NO polls is invisible to this probe. The group
// object reaches the response only as a side-load of the polls that
// reference it (PollSerializer `has_one :topic` → TopicSerializer
// `has_one :group, root: :groups`). With zero kept polls there is
// nothing to side-load, the `groups` array is absent, and the probe
// records a miss even though the connector can read the group perfectly
// well. A missing group is therefore NOT proof the user cannot see it.
// The native GET /api/b2/groups (v0.0.12) has no such gap.
//
// The `groups` array carries exactly the queried group: a poll's topic
// `has_one :group, root: :groups`, and `records_visible_in_group` scopes
// to that one group (`or_subgroups: false`). A subgroup's PARENT is
// serialized under a separate `parent_groups` root (GroupSerializer
// `has_one :parent, root: :parent_groups`), which this probe deliberately
// ignores: that side-load carries no visibility check on the parent, so
// harvesting it would list groups the user may not be able to read. A
// parent group is therefore found only when its own id is probed (and it
// has polls); `parent_id` on the subgroup is kept for navigating up.
// Results are still deduped by id, defensively.
//
// The probe runs with bounded concurrency and a "stop after N
// consecutive misses" early-exit, since most Loomio instances have
// dense id ranges in the low hundreds.

interface RawGroup {
  id: number;
  key?: string;
  handle?: string | null;
  name?: string;
  full_name?: string;
  parent_id?: number | null;
  discussion_privacy_options?: string;
  is_visible_to_public?: boolean;
  memberships_count?: number;
  discussions_count?: number;
  description?: string;
  created_at?: string;
  archived_at?: string | null;
}

interface PollsResponse {
  groups?: RawGroup[];
  // `parent_groups` (a subgroup's parent, side-loaded WITHOUT a
  // visibility check on it) is intentionally not read — see above.
}

const DEFAULT_START_ID = 1;
const DEFAULT_END_ID = 200;
const MAX_END_ID = 10000;
const MAX_PROBE_SPAN = 500;
const CONCURRENCY = 5;

export const listGroupsSchema = z
  .object({
    start_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("First group_id to probe (inclusive). Defaults to 1."),
    end_id: z
      .number()
      .int()
      .min(1)
      .max(MAX_END_ID)
      .optional()
      .describe(
        "Last group_id to probe (inclusive). Defaults to 200. A single call may scan at most 500 ids; use multiple calls for wider ranges.",
      ),
    stop_after_consecutive_misses: z
      .number()
      .int()
      .min(1)
      .max(MAX_PROBE_SPAN)
      .optional()
      .describe(
        "Early-exit heuristic: stop probing after this many consecutive 404/403 misses. Saves wall time on sparse id ranges. Defaults to 50.",
      ),
  })
  .superRefine((input, ctx) => {
    const start = input.start_id ?? DEFAULT_START_ID;
    const end = input.end_id ?? DEFAULT_END_ID;
    if (end < start) {
      ctx.addIssue({
        code: "custom",
        path: ["end_id"],
        message: "end_id must be greater than or equal to start_id.",
      });
      return;
    }
    if (end - start + 1 > MAX_PROBE_SPAN) {
      ctx.addIssue({
        code: "custom",
        path: ["end_id"],
        message: `A single list_groups call may scan at most ${MAX_PROBE_SPAN} ids.`,
      });
    }
  });

interface ProbeResult {
  id: number;
  groups: RawGroup[];
  /**
   * Why an empty `groups` came back. `not_found` (404) proves the key
   * was accepted; `forbidden` (403) is either "not visible" or "key
   * rejected" and is what makes the empty-scan path re-probe the key.
   * Absent when the probe answered 200 (with or without side-loaded
   * groups — a poll-less group is a 200 with no `groups`).
   */
  miss?: "not_found" | "forbidden";
}

async function probeOne(id: number): Promise<ProbeResult> {
  try {
    const resp = await loomioGet<PollsResponse>("/b2/polls", {
      group_id: id,
      limit: 1,
      status: "all",
    });
    return { id, groups: resp.groups ?? [] };
  } catch (err) {
    // 404 (RecordNotFound) is the expected "no such group" signal.
    if (err instanceof LoomioApiError && err.status === 404) {
      return { id, groups: [], miss: "not_found" };
    }
    // 403 → the group is not visible to the connector's user — OR the
    // key is rejected, in which case every id looks like this. A single
    // probe cannot tell the two apart (same generic body), so it is a
    // soft miss here; the zero-found path below asks the health probe,
    // and the recorded reason decides whether that probe may be served
    // from cache.
    if (err instanceof LoomioAuthError && err.status === 403) {
      return { id, groups: [], miss: "forbidden" };
    }
    throw err;
  }
}

interface SlimGroup {
  id: number;
  key: string | undefined;
  handle: string | null | undefined;
  name: string | undefined;
  parent_id: number | null | undefined;
  discussion_privacy_options: string | undefined;
  is_visible_to_public: boolean | undefined;
  memberships_count: number | undefined;
}

function slim(g: RawGroup): SlimGroup {
  return {
    id: g.id,
    key: g.key,
    handle: g.handle,
    name: g.name,
    parent_id: g.parent_id,
    discussion_privacy_options: g.discussion_privacy_options,
    is_visible_to_public: g.is_visible_to_public,
    memberships_count: g.memberships_count,
  };
}

export const POLL_LESS_GROUPS_NOTE =
  "this probe reads groups off b2/polls, so a group with no polls is never discovered even when " +
  "the connector's user can see it (native GET /api/b2/groups arrives in v0.0.12)";

export interface ListGroupsResult {
  groups: SlimGroup[];
  scanned: {
    from: number;
    to: number;
    stopped_early: boolean;
    total_found: number;
    /** Present only when nothing was found: what the empty result can and cannot mean. */
    note?: string;
  };
}

/**
 * Nothing found. Two very different worlds produce that: (a) the key is
 * fine and no group in the range is visible — or the visible ones have
 * no polls (see CAVEAT); (b) the key was rotated and every probe 403'd.
 * Returning `groups: []` for (b) is a lie an agent will relay as "you
 * have no groups". Ask the key-health probe and refuse in case (b); in
 * the other cases say what the emptiness does and does not prove.
 *
 * `sawForbidden` decides whether the probe may answer from its 60 s
 * cache. When every miss was a 404 the key was demonstrably accepted on
 * every request, and a cached verdict is fine. When any miss was a 403
 * the scan holds evidence the cache may not: a key rotated seconds
 * after the last `valid` probe produces exactly this picture (403 for
 * every id, non-existent ones included), and trusting the cache would
 * return `groups: []` inside that window — so force a fresh probe. All-
 * 403 is not PROOF of rejection (a valid key over a dense range of
 * hidden groups looks the same), which is why the probe, not the scan,
 * gets the last word. Costs one extra request pair on this path only.
 *
 * The `unreachable` note is fixed text: the probe's `detail` is an
 * operator-facing string built from error messages and is kept out of
 * tool results, like `/health` keeps it out of its body.
 */
async function explainEmptyScan(
  from: number,
  to: number,
  opts: { sawForbidden: boolean },
): Promise<string> {
  const health = await checkLoomioHealth({ force: opts.sawForbidden });
  const range = `group ids ${from}-${to}`;
  if (health.key_status === "rejected") {
    throw new LoomioAuthError(
      `list_groups found no groups in ${range}, and the connector's key-health probe reports the ` +
        "API key is REJECTED — the empty result reflects the rejected key, not the connector " +
        `user's groups. ${keyRejectedWarning()}`,
      403,
      "unauthenticated",
    );
  }
  if (health.key_status === "valid") {
    return (
      `No group in ${range} is visible to the connector's user (the API key passed its last ` +
      `health check), or every visible one has no polls — ${POLL_LESS_GROUPS_NOTE}. Widen the ` +
      "range or check the connector user's memberships in Loomio before concluding it has no groups."
    );
  }
  return (
    `No group found in ${range}, and the key-health probe could not reach Loomio to verify the API ` +
    'key (key_status "unreachable"; see the connector\'s logs or GET /health for the cause). The ' +
    "empty result may not reflect the connector user's real groups; retry once Loomio is reachable."
  );
}

export async function listGroups(
  input: z.infer<typeof listGroupsSchema>,
): Promise<ListGroupsResult> {
  const parsed = listGroupsSchema.parse(input);
  const start = parsed.start_id ?? DEFAULT_START_ID;
  const end = parsed.end_id ?? DEFAULT_END_ID;
  const maxMisses = parsed.stop_after_consecutive_misses ?? 50;

  const seenIds = new Set<number>();
  const found: SlimGroup[] = [];
  let consecutiveMisses = 0;
  let sawForbidden = false;
  let earlyExit = false;
  let lastScanned = start - 1;

  // Batch by `CONCURRENCY` IDs at a time. Each batch is awaited in full
  // before evaluating the miss-count, so the early-exit heuristic stays
  // simple (no race between fast 200s and slow 404s).
  for (let batchStart = start; batchStart <= end; batchStart += CONCURRENCY) {
    const ids: number[] = [];
    for (let id = batchStart; id < batchStart + CONCURRENCY && id <= end; id++) {
      ids.push(id);
    }
    const results = await Promise.all(ids.map((id) => probeOne(id)));

    for (const r of results) {
      lastScanned = r.id;
      if (r.groups.length > 0) {
        // Loomio puts exactly the queried group in `groups` (the parent
        // lives under `parent_groups`, which `probeOne` does not read).
        // Dedupe by id anyway, so a response that repeats a group can
        // never produce a duplicate row.
        for (const g of r.groups) {
          if (!seenIds.has(g.id)) {
            seenIds.add(g.id);
            found.push(slim(g));
          }
        }
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
        if (r.miss === "forbidden") sawForbidden = true;
      }
    }

    if (consecutiveMisses >= maxMisses) {
      earlyExit = true;
      break;
    }
  }

  const note =
    found.length === 0 ? await explainEmptyScan(start, lastScanned, { sawForbidden }) : undefined;

  return {
    groups: found,
    scanned: {
      from: start,
      to: lastScanned,
      stopped_early: earlyExit,
      total_found: found.length,
      ...(note ? { note } : {}),
    },
  };
}
