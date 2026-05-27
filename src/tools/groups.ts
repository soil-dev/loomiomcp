import { z } from "zod";
import { LoomioApiError, LoomioAuthError, loomioGet } from "../loomio/client.js";

// ── list_groups (probe-based enumeration) ──────────────────────────────────
//
// Loomio's b2 surface has no `groups` resource and no api-key-authed
// endpoint that returns "all groups the calling user can see". v1's
// `profile/groups` requires a session; the v1 explore endpoint returns
// only publicly-listed groups (skipping hidden / closed / secret ones,
// regardless of the caller's privileges).
//
// Workaround: probe `b2/polls?group_id=N&limit=1&status=all` over an
// id range. We use the polls endpoint specifically because:
//   - b2/memberships requires the caller to be a group ADMIN.
//     Non-admin bots get 403 across the board.
//   - b2/discussions only requires MEMBERSHIP but its serializer
//     OMITS the `groups` array entirely when the queried group has
//     no discussions — so empty groups silently disappear from the
//     enumeration even though the bot has access.
//   - b2/polls also only requires MEMBERSHIP but its serializer
//     ALWAYS includes the group metadata in the `groups` array,
//     because it also returns historical poll-created events whose
//     resolution requires the group object. Works for empty groups.
//   - For `is_admin: true` users, every endpoint bypasses the
//     per-group check anyway.
//
// Responses cleanly distinguish:
//   200 → group exists, bot can read its polls (= is a member, or
//         `is_admin`); the response carries the group object
//   404 → no group with that id (skip)
//   403 → group exists but bot isn't a member (skip)
//
// b2/polls's response shape: the `groups` array carries the queried
// group AND its parent group (so users can navigate up). We dedupe
// by id so each group appears once in the result.
//
// The probe runs with bounded concurrency and a "stop after N
// consecutive misses" early-exit, since most Loomio instances have
// dense ID ranges in the low hundreds.

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
    if (err instanceof LoomioApiError && err.status === 404) return { id, groups: [] };
    // 403 → bot isn't a member of this group (and isn't is_admin).
    // Treat as soft miss so we keep walking the range.
    if (err instanceof LoomioAuthError && err.status === 403) return { id, groups: [] };
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

export async function listGroups(input: z.infer<typeof listGroupsSchema>) {
  const parsed = listGroupsSchema.parse(input);
  const start = parsed.start_id ?? DEFAULT_START_ID;
  const end = parsed.end_id ?? DEFAULT_END_ID;
  const maxMisses = parsed.stop_after_consecutive_misses ?? 50;

  const seenIds = new Set<number>();
  const found: SlimGroup[] = [];
  let consecutiveMisses = 0;
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
        // b2/polls returns the queried group + its parent. Dedupe
        // by id; the parent may also be hit later in the probe range
        // (which is harmless — same group, just confirmed twice).
        for (const g of r.groups) {
          if (!seenIds.has(g.id)) {
            seenIds.add(g.id);
            found.push(slim(g));
          }
        }
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
      }
    }

    if (consecutiveMisses >= maxMisses) {
      earlyExit = true;
      break;
    }
  }

  return {
    groups: found,
    scanned: {
      from: start,
      to: lastScanned,
      stopped_early: earlyExit,
      total_found: found.length,
    },
  };
}
