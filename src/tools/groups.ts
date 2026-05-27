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
// Workaround: probe `b2/memberships?group_id=N` over an id range. With
// the bot user marked `is_admin: true`, the responses cleanly
// distinguish:
//
//   200 → group exists, bot can see it; the response carries the group
//         object we want
//   404 → no group with that id (skip)
//   403 → group exists but bot can't see it (shouldn't happen with
//         is_admin; treat as miss)
//
// The probe runs with bounded concurrency and a "stop after N
// consecutive 404s" early-exit, since most Loomio instances have
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

interface MembershipsResponse {
  groups?: RawGroup[];
}

export const listGroupsSchema = z.object({
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
    .max(10000)
    .optional()
    .describe(
      "Last group_id to probe (inclusive). Defaults to 200, which covers most Loomio instances; bump for larger ones.",
    ),
  stop_after_consecutive_misses: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Early-exit heuristic: stop probing after this many consecutive 404s. Saves wall time on sparse ID ranges. Defaults to 50.",
    ),
});

const CONCURRENCY = 5;

interface ProbeResult {
  id: number;
  group: RawGroup | null;
}

async function probeOne(id: number): Promise<ProbeResult> {
  try {
    const resp = await loomioGet<MembershipsResponse>("/b2/memberships", {
      group_id: id,
      limit: 1,
    });
    return { id, group: resp.groups?.[0] ?? null };
  } catch (err) {
    // 404 (RecordNotFound) is the expected "no such group" signal.
    if (err instanceof LoomioApiError && err.status === 404) return { id, group: null };
    // 403 → bot can't see it (shouldn't happen with is_admin, but
    // treat as a soft miss so we keep walking the range).
    if (err instanceof LoomioAuthError) return { id, group: null };
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
  const start = input.start_id ?? 1;
  const end = input.end_id ?? 200;
  const maxMisses = input.stop_after_consecutive_misses ?? 50;

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
      if (r.group) {
        found.push(slim(r.group));
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
